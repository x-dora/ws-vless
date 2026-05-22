import { describe, expect, it, vi } from 'vitest';
import { buildMuxKeepFrame } from '../src/core/mux';
import { MuxFrameStream } from '../src/handlers/mux-frame-stream';
import type { ConnLogFunction } from '../src/types';

function createLog(): ConnLogFunction {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('MuxFrameStream', () => {
  it('keeps partial frames until enough bytes arrive', () => {
    const stream = new MuxFrameStream(createLog());
    const frame = buildMuxKeepFrame(9, new Uint8Array([1, 2, 3]));

    expect(stream.push(frame.subarray(0, 4))).toEqual([]);

    const frames = stream.push(frame.subarray(4));
    expect(frames).toHaveLength(1);
    expect(frames[0].metadata.id).toBe(9);
    expect(frames[0].data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('parses multiple complete frames from one chunk', () => {
    const stream = new MuxFrameStream(createLog());
    const first = buildMuxKeepFrame(1, new Uint8Array([1]));
    const second = buildMuxKeepFrame(2, new Uint8Array([2]));
    const chunk = new Uint8Array(first.length + second.length);
    chunk.set(first, 0);
    chunk.set(second, first.length);

    const frames = stream.push(chunk);

    expect(frames.map((frame) => frame.metadata.id)).toEqual([1, 2]);
    expect(frames.map((frame) => frame.data)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  });

  it('logs malformed frame data and leaves the stream reusable after clear', () => {
    const log = createLog();
    const stream = new MuxFrameStream(log);

    expect(stream.push(new Uint8Array([0, 1, 0]))).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Mux parse error: Mux metadata too short');

    stream.clear();
    expect(stream.push(buildMuxKeepFrame(3, new Uint8Array([7])))[0].metadata.id).toBe(3);
  });
});
