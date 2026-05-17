/**
 * Downlink sinks used by transports to send bytes back to the client.
 */

import { WS_READY_STATE } from '../types';
import { safeCloseWebSocket } from '../utils/_websocket';

export interface DownlinkSink {
  send(chunk: Uint8Array): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

export class WebSocketDownlinkSink implements DownlinkSink {
  constructor(private readonly webSocket: WebSocket) {}

  async send(chunk: Uint8Array): Promise<void> {
    if (!this.isOpen()) {
      throw new Error('WebSocket is not open');
    }

    this.webSocket.send(chunk);
  }

  close(): void {
    safeCloseWebSocket(this.webSocket);
  }

  isOpen(): boolean {
    return this.webSocket.readyState === WS_READY_STATE.OPEN;
  }
}

export class StreamDownlinkSink implements DownlinkSink {
  private open = true;

  constructor(private readonly writer: WritableStreamDefaultWriter<Uint8Array>) {}

  async send(chunk: Uint8Array): Promise<void> {
    if (!this.open) {
      throw new Error('Response stream is not open');
    }

    try {
      await this.writer.write(chunk);
    } catch (error) {
      this.open = false;
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      throw error;
    }
  }

  close(): void {
    if (!this.open) {
      return;
    }

    this.open = false;
    void this.writer
      .close()
      .catch(() => {
        // ignore
      })
      .finally(() => {
        try {
          this.writer.releaseLock();
        } catch {
          // ignore
        }
      });
  }

  isOpen(): boolean {
    return this.open;
  }
}
