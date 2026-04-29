/**
 * TCP 传输层
 *
 * 负责建立远端 TCP 连接、处理重试策略，并把远端数据桥接回 WebSocket。
 */

import { connect } from 'cloudflare:sockets';
import type { TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import { safeCloseWebSocket } from '../utils/_websocket';
import type { OutboundRetryOptions } from '../utils/nat64';
import { formatSocketHostname, resolveRetryTarget } from '../utils/nat64';
import { isSubrequestBudgetExceededError, type SubrequestBudget } from '../utils/subrequest-budget';

export interface TcpTransportOptions {
  addressRemote: string;
  addressType: number | undefined;
  portRemote: number;
  initialData: Uint8Array;
  webSocket: WebSocket;
  responseHeader: Uint8Array;
  log: ConnLogFunction;
  retryOptions?: OutboundRetryOptions;
  trafficTracker?: TrafficTracker | null;
  budget?: SubrequestBudget;
}

export class TcpTransport {
  private socket: Socket | null = null;
  private retryAttempted = false;

  constructor(private readonly options: TcpTransportOptions) {}

  async connect(): Promise<void> {
    try {
      const tcpSocket = await this.connectAndWrite(
        this.options.addressRemote,
        this.options.portRemote,
        'direct',
      );

      await this.pipeRemoteToWebSocket(tcpSocket, async () => await this.retry('no incoming data'));
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.options.log.warn(`TCP budget exhausted: ${error.message}`);
        safeCloseWebSocket(this.options.webSocket);
        return;
      }

      if (this.retryAttempted) {
        throw error;
      }

      this.options.log.warn('Initial TCP connect failed, attempting fallback', String(error));
      const retried = await this.retry('initial connect failure');
      if (!retried) {
        safeCloseWebSocket(this.options.webSocket);
      }
    }
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (!this.socket) {
      return;
    }

    this.options.trafficTracker?.addUplink(chunk.byteLength);
    const writer = this.socket.writable.getWriter();
    try {
      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  }

  close(): void {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.close();
    } catch {
      // ignore
    }

    this.socket = null;
  }

  private async connectAndWrite(
    address: string,
    port: number,
    mode: 'direct' | 'proxy-ip' | 'nat64',
  ): Promise<Socket> {
    this.options.budget?.consume(1, `tcp connect ${mode} ${address}:${port}`);
    const hostname = formatSocketHostname(address);
    const tcpSocket: Socket = connect({
      hostname,
      port,
    });

    this.socket = tcpSocket;
    this.options.log.debug(
      mode === 'direct'
        ? `Connecting to ${hostname}:${port}`
        : `Connecting via ${mode} ${hostname}:${port}`,
    );

    await tcpSocket.opened;
    this.options.log.debug(`Connected to ${hostname}:${port}`);

    const writer = tcpSocket.writable.getWriter();
    try {
      await writer.write(this.options.initialData);
    } finally {
      writer.releaseLock();
    }

    this.options.trafficTracker?.addUplink(this.options.initialData.byteLength);
    return tcpSocket;
  }

  private async retry(reason: string): Promise<boolean> {
    if (this.retryAttempted) {
      return false;
    }

    this.retryAttempted = true;
    const target = await resolveRetryTarget(
      this.options.addressRemote,
      this.options.addressType,
      this.options.retryOptions ?? {},
    );
    if (!target) {
      this.options.log.debug(`No retry target available (${reason})`);
      return false;
    }

    this.options.log.debug(
      `Retrying connection via ${target.mode} ${target.address}:${this.options.portRemote} (${reason})`,
    );

    let tcpSocket: Socket;
    try {
      tcpSocket = await this.connectAndWrite(target.address, this.options.portRemote, target.mode);
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      this.options.log.warn(`Retry connect failed (${target.mode}): ${String(error)}`);
      return false;
    }

    tcpSocket.closed
      .catch((error: unknown) => {
        this.options.log.error('Retry tcpSocket closed error:', String(error));
      })
      .finally(() => {
        safeCloseWebSocket(this.options.webSocket);
      });

    await this.pipeRemoteToWebSocket(tcpSocket, null);
    return true;
  }

  private async pipeRemoteToWebSocket(
    remoteSocket: Socket,
    retry: (() => Promise<boolean>) | null,
  ): Promise<void> {
    let hasIncomingData = false;
    let streamError: unknown = null;
    let header: Uint8Array | null = this.options.responseHeader;

    await remoteSocket.readable
      .pipeTo(
        new WritableStream({
          write: async (chunk: Uint8Array, controller) => {
            if (chunk.byteLength > 0) {
              hasIncomingData = true;
            }

            this.options.trafficTracker?.addDownlink(chunk.byteLength);

            if (this.options.webSocket.readyState !== WS_READY_STATE.OPEN) {
              controller.error('WebSocket is not open');
              return;
            }

            if (header) {
              const combined = await new Blob([header, chunk]).arrayBuffer();
              this.options.webSocket.send(combined);
              header = null;
            } else {
              this.options.webSocket.send(chunk);
            }
          },
          close: () => {
            this.options.log.debug(
              `Remote connection readable closed, hasIncomingData: ${hasIncomingData}`,
            );
          },
          abort: (reason) => {
            this.options.log.error('Remote connection readable aborted:', String(reason));
          },
        }),
      )
      .catch((error) => {
        streamError = error;
        this.options.log.error('remoteSocketToWS exception:', String(error));
      });

    if (!hasIncomingData && retry) {
      this.options.log.debug('No incoming data, retrying...');
      const retried = await retry();
      if (retried) {
        return;
      }
      safeCloseWebSocket(this.options.webSocket);
      return;
    }

    if (streamError || !hasIncomingData) {
      safeCloseWebSocket(this.options.webSocket);
    }
  }
}
