import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TcpTransport } from '../src/handlers/tcp';
import { AddressType, type ConnLogFunction, WS_READY_STATE } from '../src/types';
import { ipv4ToNat64IPv6 } from '../src/utils/nat64';
import { createBudgetedFetcher, createSubrequestBudget } from '../src/utils/subrequest-budget';

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
    const transport = new TcpTransport({
      addressRemote: 'example.com',
      addressType: AddressType.Domain,
      portRemote: 443,
      initialData: new Uint8Array([1, 2, 3]),
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: { proxyIP: '203.0.113.8' },
    });

    await transport.connect();

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
    const expected = ipv4ToNat64IPv6('203.0.113.10', '2602:fc59:11:64::');

    const transport = new TcpTransport({
      addressRemote: '203.0.113.10',
      addressType: AddressType.IPv4,
      portRemote: 8443,
      initialData: new Uint8Array([9, 9, 9]),
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: { nat64Prefixes: ['2602:fc59:11:64::'] },
    });

    await transport.connect();

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: `[${expected}]`,
      port: 8443,
    });
  });

  it('wraps direct IPv6 targets for connect()', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();

    const transport = new TcpTransport({
      addressRemote: '2001:db8::10',
      addressType: AddressType.IPv6,
      portRemote: 443,
      initialData: new Uint8Array([7, 7, 7]),
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: { nat64Prefixes: ['2602:fc59:11:64::'] },
    });

    await transport.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock.mock.calls[0][0]).toMatchObject({
      hostname: '[2001:db8::10]',
      port: 443,
    });
    expect((webSocket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it('wraps IPv6 PROXY_IP values for retry connect()', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket()).mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();

    const transport = new TcpTransport({
      addressRemote: '203.0.113.10',
      addressType: AddressType.IPv4,
      portRemote: 8443,
      initialData: new Uint8Array([9, 9, 9]),
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: { proxyIP: '2001:db8::5' },
    });

    await transport.connect();

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: '[2001:db8::5]',
      port: 8443,
    });
  });

  it('closes the upstream websocket when the retry budget is exhausted', async () => {
    connectMock.mockReturnValueOnce(createEmptySocket());

    const webSocket = createWebSocketStub();
    const budget = createSubrequestBudget(1);

    const transport = new TcpTransport({
      addressRemote: 'example.com',
      addressType: AddressType.Domain,
      portRemote: 443,
      initialData: new Uint8Array([1, 2, 3]),
      webSocket,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
      retryOptions: {
        nat64Prefixes: ['2602:fc59:11:64::'],
        fetcher: createBudgetedFetcher(budget, 'nat64 resolver fetch'),
      },
      budget,
    });

    await transport.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect((webSocket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    expect(
      (webSocket as unknown as { send: ReturnType<typeof vi.fn> }).send,
    ).not.toHaveBeenCalled();
  });
});
