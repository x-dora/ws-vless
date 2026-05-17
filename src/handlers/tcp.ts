/**
 * TCP 传输层
 *
 * 负责建立远端 TCP 连接、处理重试策略，并把远端数据桥接回下行 sink。
 */

import { connect } from 'cloudflare:sockets';
import type { TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction } from '../types';
import { isClosedWritableStreamError } from '../utils/_websocket';
import type { OutboundRetryOptions } from '../utils/nat64';
import { formatSocketHostname, resolveRetryTarget } from '../utils/nat64';
import { isSubrequestBudgetExceededError, type SubrequestBudget } from '../utils/subrequest-budget';
import type { DownlinkSink } from './downlink';

interface PendingWrite {
  chunk: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

export interface TcpTransportOptions {
  addressRemote: string;
  addressType: number | undefined;
  portRemote: number;
  initialData: Uint8Array;
  downlink: DownlinkSink;
  responseHeader: Uint8Array;
  log: ConnLogFunction;
  retryOptions?: OutboundRetryOptions;
  trafficTracker?: TrafficTracker | null;
  budget?: SubrequestBudget;
  closeDownlinkOnRemoteClose?: boolean;
  maxPendingBytes?: number;
}

export class TcpTransport {
  private socket: Socket | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pendingWrites: PendingWrite[] = [];
  private pendingBytes = 0;
  private drainingPending = false;
  private responseHeaderSent = false;
  private closed = false;
  private outboundClosed = false;
  private closeOutboundRequested = false;
  private retryAttempted = false;

  constructor(private readonly options: TcpTransportOptions) {}

  async connect(): Promise<void> {
    try {
      const tcpSocket = await this.connectAndWrite(
        this.options.addressRemote,
        this.options.portRemote,
        'direct',
      );

      await this.pipeRemoteToDownlink(tcpSocket, async () => await this.retry('no incoming data'));
    } catch (error) {
      if (this.closed) {
        return;
      }

      if (isSubrequestBudgetExceededError(error)) {
        this.options.log.warn(`TCP budget exhausted: ${error.message}`);
        this.fail(error);
        return;
      }

      if (this.retryAttempted) {
        this.fail(error);
        throw error;
      }

      this.options.log.warn('Initial TCP connect failed, attempting fallback', String(error));
      const retried = await this.retry('initial connect failure');
      if (!retried) {
        this.fail(error);
      }
    }
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.closed || this.outboundClosed) {
      return;
    }

    if (!this.writer || this.drainingPending) {
      return await this.enqueuePendingWrite(chunk);
    }

    try {
      await this.writeChunk(chunk);
    } catch (error) {
      if (isClosedWritableStreamError(error)) {
        this.options.log.debug('TCP outbound writer already closed');
        this.close();
        this.options.downlink.close();
        return Promise.resolve();
      }

      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.outboundClosed = true;
    this.rejectPendingWrites(new Error('TCP transport closed'));
    this.releaseWriter();

    try {
      this.socket?.close();
    } catch {
      // ignore
    }

    this.socket = null;
  }

  private enqueuePendingWrite(chunk: Uint8Array): Promise<void> {
    const maxPendingBytes = this.options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    if (this.pendingBytes + chunk.byteLength > maxPendingBytes) {
      this.close();
      this.options.downlink.close();
      return Promise.reject(new Error(`TCP pending write queue exceeded ${maxPendingBytes} bytes`));
    }

    this.pendingBytes += chunk.byteLength;
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ chunk, resolve, reject });
    });
  }

  private rejectPendingWrites(error: unknown): void {
    const pendingWrites = this.pendingWrites;
    this.pendingWrites = [];
    this.pendingBytes = 0;

    for (const pendingWrite of pendingWrites) {
      pendingWrite.reject(error);
    }
  }

  private fail(error: unknown): void {
    this.rejectPendingWrites(error);
    this.close();
    this.options.downlink.close();
  }

  async closeOutbound(): Promise<void> {
    this.closeOutboundRequested = true;

    if (this.closed || this.outboundClosed || !this.writer) {
      return;
    }

    await this.drainPendingChunks();
    if (!this.writer || this.closed || this.outboundClosed) {
      return;
    }

    this.outboundClosed = true;
    const writer = this.writer;
    try {
      await writer.close();
    } catch (error) {
      if (!isClosedWritableStreamError(error)) {
        throw error;
      }
    } finally {
      this.releaseWriter();
    }
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

    await this.sendResponseHeaderOnce();

    this.writer = tcpSocket.writable.getWriter();
    await this.writeChunk(this.options.initialData);
    await this.drainPendingChunks();
    if (this.closeOutboundRequested) {
      await this.closeOutbound();
    }
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

    await this.pipeRemoteToDownlink(tcpSocket, null);
    return true;
  }

  private observeSocketClosed(socket: Socket, closeWebSocket: boolean): void {
    void socket.closed
      .catch((error: unknown) => {
        this.options.log.debug('TCP socket closed with error:', String(error));
      })
      .finally(() => {
        if (closeWebSocket) {
          this.options.downlink.close();
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

  private async sendResponseHeaderOnce(): Promise<void> {
    if (this.responseHeaderSent || !this.options.downlink.isOpen()) {
      return;
    }

    await this.options.downlink.send(this.options.responseHeader);
    this.responseHeaderSent = true;
  }

  private async writeChunk(chunk: Uint8Array): Promise<void> {
    if (!this.writer || this.closed || this.outboundClosed) {
      return;
    }

    this.options.trafficTracker?.addUplink(chunk.byteLength);
    try {
      await this.writer.write(chunk);
    } catch (error) {
      if (isClosedWritableStreamError(error)) {
        this.close();
        this.options.downlink.close();
        return;
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
      while (this.pendingWrites.length > 0 && this.writer && !this.closed) {
        const pendingWrite = this.pendingWrites.shift();
        if (!pendingWrite) {
          continue;
        }
        this.pendingBytes -= pendingWrite.chunk.byteLength;
        try {
          await this.writeChunk(pendingWrite.chunk);
          pendingWrite.resolve();
        } catch (error) {
          pendingWrite.reject(error);
          this.rejectPendingWrites(error);
          throw error;
        }
      }
    } finally {
      this.drainingPending = false;
    }
  }

  private async pipeRemoteToDownlink(
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

            if (!this.options.downlink.isOpen()) {
              controller.error('Downlink is not open');
              return;
            }

            await this.options.downlink.send(chunk);
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
      this.fail(new Error('TCP retry failed after no incoming data'));
      return;
    }

    if (streamError || !hasIncomingData) {
      this.fail(streamError ?? new Error('TCP remote closed without incoming data'));
      return;
    }

    if (this.options.closeDownlinkOnRemoteClose) {
      this.options.downlink.close();
    }
  }
}
