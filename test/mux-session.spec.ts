import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuxNetwork, type SubConnection } from '../src/core/mux';
import { createMuxSession } from '../src/handlers/mux-session';
import { AddressType, type ConnLogFunction, WS_READY_STATE } from '../src/types';
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

  return {
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

describe('Mux TCP fallback', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the NAT64 retry policy for TCP sub-connections', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket()).mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();
    const session = createMuxSession({
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: {
        nat64Prefixes: ['2602:fc59:11:64::'],
      },
    });

    const subConn: SubConnection = {
      id: 7,
      address: '198.51.100.11',
      addressType: AddressType.IPv4,
      port: 443,
      network: MuxNetwork.TCP,
      closed: false,
      createdAt: Date.now(),
      ready: false,
      pendingData: [],
    };

    const expected = ipv4ToNat64IPv6('198.51.100.11', '2602:fc59:11:64::');

    await (
      session as unknown as {
        handleTCPSubConnection: (
          connection: SubConnection,
          initialData?: Uint8Array,
        ) => Promise<void>;
      }
    ).handleTCPSubConnection(subConn, new Uint8Array([1, 2, 3]));

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: `[${expected}]`,
      port: 443,
    });
    expect((webSocket as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();
  });
});
