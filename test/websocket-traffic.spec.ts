import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfig } from '../src/config';
import { createSingleUUIDValidator } from '../src/core/header';
import { buildMuxKeepAliveFrame } from '../src/core/mux';
import { WebSocketGateway } from '../src/handlers/connection';
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

function uuidToBytes(uuid: string): number[] {
  const parts = uuid.replace(/-/g, '').match(/.{2}/g);
  if (!parts) {
    throw new Error(`Invalid UUID fixture: ${uuid}`);
  }

  return parts.map((part) => Number.parseInt(part, 16));
}

function buildProtocolHeader(
  options: { command?: ProxyCommand; address?: string; port?: number; payload?: Uint8Array } = {},
): Uint8Array {
  const command = options.command ?? ProxyCommand.TCP;
  const address = options.address ?? 'target.example';
  const port = options.port ?? 8443;
  const payload = options.payload ?? new Uint8Array();

  if (command === ProxyCommand.MUX) {
    const bytes = new Uint8Array(1 + 16 + 1 + 1 + payload.byteLength);
    let offset = 0;
    bytes[offset++] = 1;
    bytes.set(uuidToBytes(TEST_UUID), offset);
    offset += 16;
    bytes[offset++] = 0;
    bytes[offset++] = command;
    bytes.set(payload, offset);
    return bytes;
  }

  const addressBytes = new TextEncoder().encode(address);
  const bytes = new Uint8Array(
    1 + 16 + 1 + 1 + 2 + 1 + 1 + addressBytes.byteLength + payload.byteLength,
  );
  let offset = 0;
  bytes[offset++] = 1;
  bytes.set(uuidToBytes(TEST_UUID), offset);
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

function createGateway(trafficStatsService: TrafficStatsService): WebSocketGateway {
  const config = new RuntimeConfig({
    DEV_MODE: 'true',
    UUID: TEST_UUID,
    PROXY_IP: '',
    NAT64_PREFIXES: '',
  } as WorkerEnv);

  return new WebSocketGateway({
    config,
    trafficStatsService,
  });
}

function acceptWebSocket(response: Response): WebSocket {
  const webSocket = response.webSocket;
  if (!webSocket) {
    throw new Error('Expected WebSocket response');
  }

  webSocket.accept();
  return webSocket;
}

function closeServerTunnel(server: WebSocket | null): void {
  if (!server) {
    throw new Error('Expected server WebSocket');
  }

  server.dispatchEvent(new Event('close'));
}

function waitForServerMessage(server: WebSocket | null): Promise<void> {
  if (!server) {
    throw new Error('Expected server WebSocket');
  }

  return new Promise((resolve) => {
    server.addEventListener('message', () => resolve(), { once: true });
  });
}

async function startWebSocketTunnel(trafficStatsService: TrafficStatsService) {
  const ctx = createExecutionContext();
  let serverSocket: WebSocket | null = null;
  const OriginalWebSocketPair = WebSocketPair;
  vi.stubGlobal('WebSocketPair', function WebSocketPairStub() {
    const pair = new OriginalWebSocketPair();
    serverSocket = Object.values(pair)[1];
    return pair;
  });

  const response = await createGateway(trafficStatsService).handle(
    new Request('https://example.com/', {
      headers: { Upgrade: 'websocket' },
    }),
    { executionContext: ctx, budget: createSubrequestBudget(48) },
    createSingleUUIDValidator(TEST_UUID),
  );

  expect(response.status).toBe(101);
  return {
    client: acceptWebSocket(response),
    server: serverSocket,
    ctx,
  };
}

describe('WebSocket tunnel traffic reporting', () => {
  beforeEach(() => {
    connectMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('reports WebSocket TCP traffic once when the tunnel closes', async () => {
    const firstPayload = new Uint8Array([1, 2, 3]);
    const remotePayload = new Uint8Array([9, 8, 7, 6]);
    const socket = createWritableSocket([remotePayload]);
    connectMock.mockReturnValueOnce(socket);
    const trafficStatsService = new TrafficStatsService({
      endpoint: 'https://stats.example.test/worker/report',
    });
    const report = vi.spyOn(trafficStatsService, 'report').mockResolvedValue(true);

    const { client, server, ctx } = await startWebSocketTunnel(trafficStatsService);
    client.send(buildProtocolHeader({ payload: firstPayload }));

    await vi.waitFor(() => {
      expect(socket.writes).toEqual([firstPayload]);
    });

    closeServerTunnel(server);
    await waitOnExecutionContext(ctx);

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toMatchObject({
      uuid: TEST_UUID,
      uplink: firstPayload.byteLength,
      downlink: remotePayload.byteLength,
    });
  });

  it('reports accumulated Mux session bytes when the WebSocket tunnel closes', async () => {
    const muxFrame = buildMuxKeepAliveFrame();
    const trafficStatsService = new TrafficStatsService({
      endpoint: 'https://stats.example.test/worker/report',
    });
    const report = vi.spyOn(trafficStatsService, 'report').mockResolvedValue(true);
    const { client, server, ctx } = await startWebSocketTunnel(trafficStatsService);
    const messageReceived = waitForServerMessage(server);
    client.send(buildProtocolHeader({ command: ProxyCommand.MUX, payload: muxFrame }));

    await messageReceived;
    await Promise.resolve();
    closeServerTunnel(server);
    await waitOnExecutionContext(ctx);

    expect(connectMock).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toMatchObject({
      uuid: TEST_UUID,
      uplink: muxFrame.byteLength,
      downlink: 0,
    });
  });
});
