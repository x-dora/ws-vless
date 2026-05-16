/**
 * TCP 传输层
 *
 * 负责建立远端 TCP 连接、处理重试策略，并把远端数据桥接回 WebSocket。
 */

import { connect } from 'cloudflare:sockets';
import type { TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import { isClosedWritableStreamError, safeCloseWebSocket } from '../utils/_websocket';
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
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pendingChunks: Uint8Array[] = [];
  private drainingPending = false;
  private responseHeaderSent = false;
  private closed = false;
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
      if (this.closed) {
        return;
      }

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
    if (this.closed) {
      return;
    }

    if (!this.writer || this.drainingPending) {
      this.pendingChunks.push(chunk);
      return;
    }

    try {
      await this.writeChunk(chunk);
    } catch (error) {
      if (isClosedWritableStreamError(error)) {
        this.options.log.debug('TCP outbound writer already closed');
        this.close();
        safeCloseWebSocket(this.options.webSocket);
        return;
      }

      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pendingChunks = [];
    this.releaseWriter();

    try {
      this.socket?.close();
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

    this.replaceSocket(tcpSocket);
    this.observeSocketClosed(tcpSocket, false);
    this.options.log.debug(
      mode === 'direct'
        ? `Connecting to ${hostname}:${port}`
        : `Connecting via ${mode} ${hostname}:${port}`,
    );

    await tcpSocket.opened;
    if (this.closed) {
      try {
        tcpSocket.close();
      } catch {}
      throw new Error('TCP transport closed');
    }
    this.options.log.debug(`Connected to ${hostname}:${port}`);

    this.sendResponseHeaderOnce();

    this.writer = tcpSocket.writable.getWriter();
    await this.writeChunk(this.options.initialData);
    await this.drainPendingChunks();
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

    this.observeSocketClosed(tcpSocket, true);

    await this.pipeRemoteToWebSocket(tcpSocket, null);
    return true;
  }

  private observeSocketClosed(socket: Socket, closeWebSocket: boolean): void {
    void socket.closed
      .catch((error: unknown) => {
        this.options.log.debug('TCP socket closed with error:', String(error));
      })
      .finally(() => {
        if (closeWebSocket) {
          safeCloseWebSocket(this.options.webSocket);
        }
      });
  }

  private replaceSocket(nextSocket: Socket): void {
    this.releaseWriter();

    if (this.socket && this.socket !== nextSocket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }

    this.socket = nextSocket;
  }

  private releaseWriter(): void {
    if (!this.writer) {
      return;
    }

    try {
      this.writer.releaseLock();
    } catch {
      // ignore
    }

    this.writer = null;
  }

  private sendResponseHeaderOnce(): void {
    if (this.responseHeaderSent || this.options.webSocket.readyState !== WS_READY_STATE.OPEN) {
      return;
    }

    this.options.webSocket.send(this.options.responseHeader);
    this.responseHeaderSent = true;
  }

  private async writeChunk(chunk: Uint8Array): Promise<void> {
    if (!this.writer || this.closed) {
      return;
    }

    this.options.trafficTracker?.addUplink(chunk.byteLength);
    try {
      await this.writer.write(chunk);
    } catch (error) {
      if (isClosedWritableStreamError(error)) {
        this.close();
        safeCloseWebSocket(this.options.webSocket);
      }

      throw error;
    }
  }

  private async drainPendingChunks(): Promise<void> {
    if (!this.writer || this.drainingPending || this.closed) {
      return;
    }

    this.drainingPending = true;
    try {
      while (this.pendingChunks.length > 0 && this.writer && !this.closed) {
        const pendingChunk = this.pendingChunks.shift();
        if (!pendingChunk) {
          continue;
        }
        await this.writeChunk(pendingChunk);
      }
    } finally {
      this.drainingPending = false;
    }
  }

  private async pipeRemoteToWebSocket(
    remoteSocket: Socket,
    retry: (() => Promise<boolean>) | null,
  ): Promise<void> {
    let hasIncomingData = false;
    let streamError: unknown = null;

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

            this.options.webSocket.send(chunk);
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
