/**
 * Ordered WebSocket downlink queue.
 */

import { WS_READY_STATE } from '../types';

const DEFAULT_MAX_WRITE_QUEUE = 100;

export interface QueuedWebSocketDownlinkOptions {
  responseHeader: Uint8Array;
  maxQueueLength?: number;
}

export class QueuedWebSocketDownlink {
  private readonly maxQueueLength: number;
  private queue: Uint8Array[] = [];
  private head = 0;
  private processing = false;
  private headerSent = false;

  constructor(
    private readonly webSocket: WebSocket,
    private readonly options: QueuedWebSocketDownlinkOptions,
  ) {
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_WRITE_QUEUE;
  }

  enqueue(data: Uint8Array): boolean {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) {
      this.clear();
      return false;
    }

    if (this.queue.length - this.head >= this.maxQueueLength) {
      return false;
    }

    this.queue.push(data);
    this.processQueue();
    return true;
  }

  clear(): void {
    this.queue = [];
    this.head = 0;
    this.processing = false;
  }

  get isHeaderSent(): boolean {
    return this.headerSent;
  }

  private processQueue(): void {
    if (this.processing || this.head >= this.queue.length) {
      return;
    }

    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) {
      this.clear();
      return;
    }

    this.processing = true;
    try {
      while (this.head < this.queue.length) {
        const data = this.queue[this.head++];
        const shouldMarkHeaderSent = !this.headerSent;
        this.webSocket.send(this.withResponseHeader(data));
        if (shouldMarkHeaderSent) {
          this.headerSent = true;
        }
      }
    } catch {
      // Stop processing; the session lifecycle will close the socket.
    } finally {
      if (this.head > 64 && this.head >= this.queue.length) {
        this.clear();
      }
      this.processing = false;
    }
  }

  private withResponseHeader(data: Uint8Array): Uint8Array {
    if (this.headerSent) {
      return data;
    }

    const combined = new Uint8Array(this.options.responseHeader.length + data.length);
    combined.set(this.options.responseHeader);
    combined.set(data, this.options.responseHeader.length);
    return combined;
  }
}
