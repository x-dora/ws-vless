import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfig } from '../src/config';
import { createSingleUUIDValidator } from '../src/core/header';
import { isXHttpStreamOneRequest, XHttpGateway } from '../src/handlers/xhttp';
import { TrafficStatsService } from '../src/services/stats-reporter';
import { AddressType, ProxyCommand, type WorkerEnv } from '../src/types';
import { createSubrequestBudget } from '../src/utils/subrequest-budget';

const TEST_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock('cloudflare:sockets', () => ({
  connect: connectMock,
}));

interface WritableMockSocket extends Partial<Socket> {
  opened: Promise<SocketInfo>;
  closed: Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: ReturnType<typeof vi.fn>;
  writes: Uint8Array[];
}

interface DeferredSocket extends WritableMockSocket {
  emitRemoteData(chunk: Uint8Array): void;
  resolveOpened(info?: SocketInfo): void;
  closeRemoteReadable(): void;
}

interface ControlledReadableSocket extends WritableMockSocket {
  emitRemoteData(chunk: Uint8Array): void;
  closeRemoteReadable(): void;
}

function uuidToBytes(uuid: string): number[] {
  const parts = uuid.replace(/-/g, '').match(/.{2}/g);
  if (!parts) {
    throw new Error(`Invalid UUID fixture: ${uuid}`);
  }

  return parts.map((part) => Number.parseInt(part, 16));
}

function buildVlessHeader(
  options: {
    uuid?: string;
    command?: ProxyCommand;
    address?: string;
    port?: number;
    payload?: Uint8Array;
  } = {},
): Uint8Array {
  const uuid = options.uuid ?? TEST_UUID;
  const command = options.command ?? ProxyCommand.TCP;
  const address = options.address ?? 'target.example';
  const port = options.port ?? 8443;
  const payload = options.payload ?? new Uint8Array();
  const addressBytes = new TextEncoder().encode(address);

  const bytes = new Uint8Array(
    1 + 16 + 1 + 1 + 2 + 1 + 1 + addressBytes.byteLength + payload.byteLength,
  );
  let offset = 0;
  bytes[offset++] = 1;
  bytes.set(uuidToBytes(uuid), offset);
  offset += 16;
  bytes[offset++] = 0;
  bytes[offset++] = command;
  bytes[offset++] = (port >> 8) & 0xff;
  bytes[offset++] = port & 0xff;
  bytes[offset++] = AddressType.Domain;
  bytes[offset++] = addressBytes.byteLength;
  bytes.set(addressBytes, offset);
  offset += addressBytes.byteLength;
  bytes.set(payload, offset);
  return bytes;
}

function createChunkedRequestBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function createUdpPacket(payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(2 + payload.byteLength);
  packet[0] = (payload.byteLength >> 8) & 0xff;
  packet[1] = payload.byteLength & 0xff;
  packet.set(payload, 2);
  return packet;
}

function createWritableSocket(readableChunks: Uint8Array[] = []): WritableMockSocket {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const writes: Uint8Array[] = [];

  return {
    opened: Promise.resolve({}),
    closed,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        queueMicrotask(() => {
          for (const chunk of readableChunks) {
            controller.enqueue(chunk);
          }
          controller.close();
          resolveClosed();
        });
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new Uint8Array(chunk));
      },
      close() {
        resolveClosed();
      },
      abort() {
        resolveClosed();
      },
    }),
    close: vi.fn(() => {
      resolveClosed();
    }),
    writes,
  };
}

function createControlledReadableSocket(): ControlledReadableSocket {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const writes: Uint8Array[] = [];
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  let readableClosed = false;

  const closeReadable = () => {
    if (readableClosed) {
      return;
    }
    readableClosed = true;
    readableController.close();
    resolveClosed();
  };

  return {
    opened: Promise.resolve({}),
    closed,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        readableController = controller;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new Uint8Array(chunk));
      },
      close() {
        resolveClosed();
      },
      abort() {
        resolveClosed();
      },
    }),
    close: vi.fn(closeReadable),
    writes,
    emitRemoteData(chunk: Uint8Array) {
      readableController.enqueue(chunk);
    },
    closeRemoteReadable() {
      closeReadable();
    },
  };
}

function createDeferredSocket(): DeferredSocket {
  let resolveOpened!: (info: SocketInfo) => void;
  let resolveClosed!: () => void;
  const opened = new Promise<SocketInfo>((resolve) => {
    resolveOpened = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const writes: Uint8Array[] = [];
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  let readableClosed = false;

  const closeReadable = () => {
    if (readableClosed) {
      return;
    }
    readableClosed = true;
    readableController.close();
    resolveClosed();
  };

  return {
    opened,
    closed,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        readableController = controller;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new Uint8Array(chunk));
      },
      close() {
        resolveClosed();
      },
      abort() {
        resolveClosed();
      },
    }),
    close: vi.fn(closeReadable),
    writes,
    emitRemoteData(chunk: Uint8Array) {
      readableController.enqueue(chunk);
    },
    resolveOpened(info: SocketInfo = {}) {
      resolveOpened(info);
    },
    closeRemoteReadable() {
      closeReadable();
    },
  };
}

function createGateway() {
  const config = new RuntimeConfig({
    DEV_MODE: 'true',
    UUID: TEST_UUID,
    PROXY_IP: '',
    NAT64_PREFIXES: '2602:fc59:11:64::',
  } as WorkerEnv);

  return new XHttpGateway({
    config,
    trafficStatsService: new TrafficStatsService({ enabled: false }),
  });
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

describe('XHTTP stream-one request detection', () => {
  it('matches POST application/grpc requests with a body outside /api and non-websocket upgrades', () => {
    const request = new Request('https://example.com/anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc+proto' },
      body: new Uint8Array([1]),
    });

    expect(isXHttpStreamOneRequest(request)).toBe(true);
  });

  it.each([
    ['GET', new Request('https://example.com/anything', { method: 'GET' })],
    [
      'missing body',
      new Request('https://example.com/anything', {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc' },
      }),
    ],
    [
      'non-grpc content-type',
      new Request('https://example.com/anything', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([1]),
      }),
    ],
    [
      '/api path',
      new Request('https://example.com/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc' },
        body: new Uint8Array([1]),
      }),
    ],
    [
      'websocket upgrade',
      new Request('https://example.com/anything', {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc', Upgrade: 'websocket' },
        body: new Uint8Array([1]),
      }),
    ],
  ])('does not match %s', (_name, request) => {
    expect(isXHttpStreamOneRequest(request)).toBe(false);
  });
});

describe('XHTTP gateway', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts valid VLESS TCP headers and streams response header plus remote data', async () => {
    const socket = createWritableSocket([new Uint8Array([7, 8, 9])]);
    connectMock.mockReturnValueOnce(socket);
    const request = new Request('https://example.com/x-anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: buildVlessHeader({ payload: new Uint8Array([1, 2, 3]) }),
    });
    const ctx = createExecutionContext();

    const response = await createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    const body = await readResponseBytes(response);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/grpc');
    expect(connectMock).toHaveBeenCalledWith({ hostname: 'target.example', port: 8443 });
    expect(socket.writes).toEqual([new Uint8Array([1, 2, 3])]);
    expect(body).toEqual(new Uint8Array([1, 0, 7, 8, 9]));
  });

  it('writes header trailing payload and subsequent body chunks to the TCP socket', async () => {
    const socket = createControlledReadableSocket();
    connectMock.mockReturnValueOnce(socket);
    const firstPayload = new Uint8Array([1, 2]);
    const nextPayload = new Uint8Array([3, 4]);
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: createChunkedRequestBody([buildVlessHeader({ payload: firstPayload }), nextPayload]),
    });
    const ctx = createExecutionContext();

    const response = await createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    const bodyPromise = response.arrayBuffer();
    socket.emitRemoteData(new Uint8Array([9]));
    await vi.waitFor(() => {
      expect(socket.writes).toEqual([firstPayload, nextPayload]);
    });
    queueMicrotask(() => {
      socket.closeRemoteReadable();
    });
    await bodyPromise;
    await waitOnExecutionContext(ctx);

    expect(socket.writes).toEqual([firstPayload, nextPayload]);
  });

  it('does not keep reading request body while the TCP writer is not ready', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const socket = createDeferredSocket();
    connectMock.mockReturnValueOnce(socket);
    const firstPayload = new Uint8Array([1, 2]);
    const secondPayload = new Uint8Array([3, 4]);
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body,
    });
    const ctx = createExecutionContext();

    const responsePromise = createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    controller.enqueue(buildVlessHeader({ payload: firstPayload }));
    const response = await responsePromise;
    const bodyPromise = response.arrayBuffer();
    controller.enqueue(secondPayload);
    controller.close();
    await Promise.resolve();

    expect(socket.writes).toEqual([]);

    socket.resolveOpened();
    await vi.waitFor(() => {
      expect(socket.writes).toEqual([firstPayload, secondPayload]);
    });
    socket.emitRemoteData(new Uint8Array([9]));
    socket.closeRemoteReadable();
    await bodyPromise;
    await waitOnExecutionContext(ctx);
  });

  it('rejects invalid UUID without creating a TCP socket', async () => {
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: buildVlessHeader({ uuid: '11111111-1111-4111-8111-111111111111' }),
    });

    const response = await createGateway().handle(
      request,
      { executionContext: createExecutionContext(), budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );

    expect(response.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects Mux commands without creating a TCP socket', async () => {
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: buildVlessHeader({ command: ProxyCommand.MUX }),
    });

    const response = await createGateway().handle(
      request,
      { executionContext: createExecutionContext(), budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );

    expect(response.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('accepts UDP DNS over XHTTP and streams a length-prefixed DoH response', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([9, 8, 7]))));
    vi.stubGlobal('fetch', fetchMock);
    const dnsQuery = new Uint8Array([1, 2, 3]);
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: buildVlessHeader({
        command: ProxyCommand.UDP,
        port: 53,
        payload: createUdpPacket(dnsQuery),
      }),
    });
    const ctx = createExecutionContext();

    const response = await createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    const body = await readResponseBytes(response);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: dnsQuery,
    });
    expect(body).toEqual(new Uint8Array([1, 0, 0, 3, 9, 8, 7]));
  });

  it('rejects non-DNS UDP over XHTTP before DoH or TCP is used', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: buildVlessHeader({
        command: ProxyCommand.UDP,
        port: 123,
        payload: createUdpPacket(new Uint8Array([1, 2, 3])),
      }),
    });

    const response = await createGateway().handle(
      request,
      { executionContext: createExecutionContext(), budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );

    expect(response.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reassembles XHTTP UDP datagrams split between header payload and later body chunks', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([4, 5]))));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://example.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: createChunkedRequestBody([
        buildVlessHeader({
          command: ProxyCommand.UDP,
          port: 53,
          payload: new Uint8Array([0, 3, 1]),
        }),
        new Uint8Array([2, 3]),
      ]),
    });
    const ctx = createExecutionContext();

    const response = await createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    const body = await readResponseBytes(response);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(connectMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(body).toEqual(new Uint8Array([1, 0, 0, 2, 4, 5]));
  });

  it('uses the same query retry overrides as websocket connections', async () => {
    connectMock
      .mockReturnValueOnce(createWritableSocket())
      .mockReturnValueOnce(createWritableSocket([new Uint8Array([7, 8, 9])]));
    const request = new Request(
      'https://example.com/x?PROXY_IP=198.51.100.9&NAT64_PREFIXES=64:ff9b::',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc' },
        body: buildVlessHeader(),
      },
    );
    const ctx = createExecutionContext();

    const response = await createGateway().handle(
      request,
      { executionContext: ctx, budget: createSubrequestBudget(48) },
      createSingleUUIDValidator(TEST_UUID),
    );
    const body = await readResponseBytes(response);
    await waitOnExecutionContext(ctx);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[1][0]).toMatchObject({
      hostname: '198.51.100.9',
      port: 8443,
    });
    expect(body).toEqual(new Uint8Array([1, 0, 7, 8, 9]));
  });
});
