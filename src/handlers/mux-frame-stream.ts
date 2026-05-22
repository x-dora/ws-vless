/**
 * Incremental Mux.Cool frame stream parser.
 *
 * Keeps partial frames between WebSocket messages so the session layer can
 * focus on connection state transitions.
 */

import { type MuxFrame, parseMuxFrame } from '../core/mux';
import type { ConnLogFunction } from '../types';

export class MuxFrameStream {
  private buffer = new Uint8Array(0);

  constructor(private readonly log: ConnLogFunction) {}

  push(data: ArrayBuffer | ArrayBufferLike | Uint8Array): MuxFrame[] {
    const incoming = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bytes = this.consumeBufferedData(incoming);
    const frames: MuxFrame[] = [];

    let offset = 0;
    let iterationsRemaining = 1000;
    while (offset < bytes.length && iterationsRemaining-- > 0) {
      const remainingLength = bytes.length - offset;
      if (remainingLength < 2) {
        break;
      }

      const result = parseMuxFrame(bytes, offset, remainingLength);
      if (result.hasError) {
        if (isIncompleteFrameError(result.message)) {
          break;
        }
        this.log.warn(`Mux parse error: ${result.message}`);
        break;
      }

      if (result.frame.frameLength <= 0) {
        this.log.warn(`Mux invalid frameLength: ${result.frame.frameLength}`);
        break;
      }

      frames.push(result.frame);
      offset += result.frame.frameLength;
    }

    this.buffer = offset < bytes.length ? bytes.slice(offset) : new Uint8Array(0);
    return frames;
  }

  clear(): void {
    this.buffer = new Uint8Array(0);
  }

  private consumeBufferedData(incoming: Uint8Array): Uint8Array {
    if (this.buffer.length === 0) {
      return incoming;
    }

    const bytes = new Uint8Array(this.buffer.length + incoming.length);
    bytes.set(this.buffer, 0);
    bytes.set(incoming, this.buffer.length);
    this.buffer = new Uint8Array(0);
    return bytes;
  }
}

function isIncompleteFrameError(message: string): boolean {
  return message.includes('Incomplete') || message === 'Buffer too short for Mux frame';
}
