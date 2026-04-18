import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTCPOutBound } from '../src/handlers/tcp';
import {
  AddressType,
  type ConnLogFunction,
  type RemoteSocketWrapper,
  WS_READY_STATE,
} from '../src/types';
import { ipv4ToNat64IPv6 } from '../src/utils/nat64';

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock('cloudflare:sockets', () => ({
  connect: connectMock,
}));

interface MockSocket extends Partial<Socket> {
  opened: Promise<SocketInfo>;
  closed: Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: ReturnType<typeof vi.fn>;
}

function createEmptySocket(): MockSocket {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const socket: MockSocket = {
    opened: Promise.resolve({}),
    closed,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        queueMicrotask(() => {
          controller.close();
          resolveClosed();
        });
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write() {
        return Promise.resolve();
      },
      close() {
        resolveClosed();
        return Promise.resolve();
      },
      abort() {
        resolveClosed();
        return Promise.resolve();
      },
    }),
    close: vi.fn(() => {
      resolveClosed();
    }),
  };

  return socket;
}

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

function createLog(): ConnLogFunction {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('TCP outbound fallback', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries through explicit PROXY_IP when the direct socket closes without data', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket()).mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();
    const remoteSocket: RemoteSocketWrapper = { value: null };

    await handleTCPOutBound(
      remoteSocket,
      'example.com',
      AddressType.Domain,
      443,
      new Uint8Array([1, 2, 3]),
      webSocket,
      new Uint8Array([0, 0]),
      createLog(),
      { proxyIP: '203.0.113.8' },
      null,
    );

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: '203.0.113.8',
      port: 443,
    });
    expect((webSocket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it('falls back to NAT64 when PROXY_IP is not configured', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket()).mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();
    const expected = ipv4ToNat64IPv6('203.0.113.10', '2602:fc59:b0:64::');

    await handleTCPOutBound(
      { value: null },
      '203.0.113.10',
      AddressType.IPv4,
      8443,
      new Uint8Array([9, 9, 9]),
      webSocket,
      new Uint8Array([0, 0]),
      createLog(),
      { nat64Prefixes: ['2602:fc59:b0:64::'] },
      null,
    );

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: expected,
      port: 8443,
    });
  });

  it('does not attempt an invalid retry when the original target is already IPv6', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();

    await handleTCPOutBound(
      { value: null },
      '2001:db8::10',
      AddressType.IPv6,
      443,
      new Uint8Array([7, 7, 7]),
      webSocket,
      new Uint8Array([0, 0]),
      createLog(),
      { nat64Prefixes: ['2602:fc59:b0:64::'] },
      null,
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect((webSocket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });
});
