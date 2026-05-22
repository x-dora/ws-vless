import { describe, expect, it, vi } from 'vitest';
import { QueuedWebSocketDownlink } from '../src/handlers/queued-downlink';
import { WS_READY_STATE } from '../src/types';

function createWebSocketStub(): WebSocket {
  let readyState: number = WS_READY_STATE.OPEN;
  const socket = {
    get readyState() {
      return readyState;
    },
    send: vi.fn(),
    close: vi.fn(function close() {
      readyState = WS_READY_STATE.CLOSED;
    }),
  };

  return socket as unknown as WebSocket;
}

describe('QueuedWebSocketDownlink', () => {
  it('prepends the response header to the first queued message only', () => {
    const webSocket = createWebSocketStub();
    const downlink = new QueuedWebSocketDownlink(webSocket, {
      responseHeader: new Uint8Array([0, 0]),
    });

    downlink.enqueue(new Uint8Array([1, 2]));
    downlink.enqueue(new Uint8Array([3, 4]));

    const send = (webSocket as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenNthCalledWith(1, new Uint8Array([0, 0, 1, 2]));
    expect(send).toHaveBeenNthCalledWith(2, new Uint8Array([3, 4]));
    expect(downlink.isHeaderSent).toBe(true);
  });

  it('rejects new items when the WebSocket is not open', () => {
    const webSocket = createWebSocketStub();
    webSocket.close();

    const downlink = new QueuedWebSocketDownlink(webSocket, {
      responseHeader: new Uint8Array([0, 0]),
    });

    expect(downlink.enqueue(new Uint8Array([1]))).toBe(false);
  });

  it('keeps the response header pending when the first send throws', () => {
    const webSocket = createWebSocketStub();
    const send = (webSocket as unknown as { send: ReturnType<typeof vi.fn> }).send;
    send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });

    const downlink = new QueuedWebSocketDownlink(webSocket, {
      responseHeader: new Uint8Array([0, 0]),
    });

    downlink.enqueue(new Uint8Array([1]));
    downlink.enqueue(new Uint8Array([2]));

    expect(send).toHaveBeenNthCalledWith(1, new Uint8Array([0, 0, 1]));
    expect(send).toHaveBeenNthCalledWith(2, new Uint8Array([0, 0, 2]));
    expect(downlink.isHeaderSent).toBe(true);
  });
});
