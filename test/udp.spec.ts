import { afterEach, describe, expect, it, vi } from 'vitest';
import { UdpDnsTransport } from '../src/handlers/udp';
import { type ConnLogFunction, WS_READY_STATE } from '../src/types';

function createWebSocketStub(): WebSocket {
  const socket = {
    readyState: WS_READY_STATE.OPEN,
    send: vi.fn(),
  };

  return socket as unknown as WebSocket;
}

function createLog(): ConnLogFunction {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('UDP DNS transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the VLESS response header only once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([9, 8, 7])))),
    );

    const webSocket = createWebSocketStub();
    const transport = new UdpDnsTransport({
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
    });

    transport.write(new Uint8Array([0, 1, 1, 0, 1, 2]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sendMock = (webSocket as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(
      sendMock.mock.calls.filter(
        ([chunk]) =>
          chunk instanceof Uint8Array && chunk.length === 2 && chunk[0] === 0 && chunk[1] === 0,
      ),
    ).toHaveLength(1);
  });
});
