/**
 * WebSocket 网关
 *
 * 将 VLESS 头解析、TCP/UDP/Mux 派发、流量统计和生命周期管理收敛到一个对象里。
 */

import type { RequestScope } from '../app/types';
import type { RuntimeConfig } from '../config';
import { resolveRetryOverrides } from '../config/request-overrides';
import {
  BUFFER_TOO_SHORT_MESSAGE,
  createResponseHeader,
  processHeader,
  type UUIDValidator,
} from '../core/header';
import type { TrafficStatsService, TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction, HeaderResult } from '../types';
import {
  decodeWebSocketEarlyData,
  isClosedWritableStreamError,
  safeCloseWebSocket,
} from '../utils/_websocket';
import { createConnLog } from '../utils/logger';
import type { OutboundRetryOptions } from '../utils/nat64';
import { createBudgetedFetcher, isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { createMuxSession, type MuxSession } from './mux-session';
import { TcpTransport } from './tcp';
import { UdpDnsTransport } from './udp';

type WorkerBytes = Uint8Array<ArrayBufferLike>;

interface WebSocketGatewayOptions {
  config: RuntimeConfig;
  trafficStatsService: TrafficStatsService;
}

interface SessionOptions {
  request: Request;
  validateUUID: UUIDValidator;
  scope: RequestScope;
  config: RuntimeConfig;
  trafficStatsService: TrafficStatsService;
  retryOptions: OutboundRetryOptions;
}

export class WebSocketGateway {
  constructor(private readonly options: WebSocketGatewayOptions) {}

  async handle(
    request: Request,
    scope: RequestScope,
    validateUUID: UUIDValidator,
  ): Promise<Response> {
    const url = new URL(request.url);
    const retryOverrides = resolveRetryOverrides(url.searchParams, {
      proxyIP: this.options.config.proxyIP,
      nat64Prefixes: this.options.config.nat64Prefixes,
    });
    const retryOptions: OutboundRetryOptions = {
      proxyIP: retryOverrides.proxyIP,
      nat64Prefixes: retryOverrides.nat64Prefixes,
      resolverURL: this.options.config.nat64ResolverURL,
      fetcher: createBudgetedFetcher(scope.budget, 'nat64 resolver fetch'),
    };

    const session = new TunnelConnectionSession({
      request,
      validateUUID,
      scope,
      config: this.options.config,
      trafficStatsService: this.options.trafficStatsService,
      retryOptions,
    });

    return await session.start();
  }
}

class TunnelConnectionSession {
  private readonly request: Request;
  private readonly validateUUID: UUIDValidator;
  private readonly scope: RequestScope;
  private readonly config: RuntimeConfig;
  private readonly trafficStatsService: TrafficStatsService;
  private readonly retryOptions: OutboundRetryOptions;
  private readonly log: ConnLogFunction;

  private webSocket!: WebSocket;
  private headerBuffer: WorkerBytes = new Uint8Array(0) as WorkerBytes;
  private responseHeader: WorkerBytes = new Uint8Array([0, 0]) as WorkerBytes;
  private address = '';
  private portWithRandomLog = '';
  private trafficTracker: TrafficTracker | null = null;
  private muxSession: MuxSession | null = null;
  private tcpTransport: TcpTransport | null = null;
  private udpTransport: UdpDnsTransport | null = null;
  private finalized = false;

  constructor(options: SessionOptions) {
    this.request = options.request;
    this.validateUUID = options.validateUUID;
    this.scope = options.scope;
    this.config = options.config;
    this.trafficStatsService = options.trafficStatsService;
    this.retryOptions = options.retryOptions;
    this.log = createConnLog(() => `${this.address}:${this.portWithRandomLog}`);
  }

  async start(): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    this.webSocket = webSocket;
    // 固定二进制消息为 ArrayBuffer，以兼容 2026-03-17 后的标准 Blob 默认行为。
    this.webSocket.binaryType = 'arraybuffer';
    this.webSocket.accept();

    const earlyDataHeader = this.request.headers.get('sec-websocket-protocol') || '';
    const { earlyData, error } = decodeWebSocketEarlyData(earlyDataHeader);
    if (error) {
      this.log.error('Early data parse error', String(error));
      this.finalize();
      return new Response('Bad Request', { status: 400 });
    }

    if (earlyData) {
      this.handleChunk(earlyData).catch((err) => {
        if (isSubrequestBudgetExceededError(err)) {
          this.log.warn(`Subrequest budget exhausted: ${this.scope.budget.describe()}`);
        } else {
          this.log.error('Early data handle error', String(err));
        }
        this.finalize();
      });
    }

    this.webSocket.addEventListener('message', (event: MessageEvent) => {
      const chunk = event.data;
      if (!(chunk instanceof ArrayBuffer)) {
        this.log.error('Unexpected WebSocket message payload type');
        this.finalize();
        return;
      }

      this.handleChunk(chunk).catch((err) => {
        if (isSubrequestBudgetExceededError(err)) {
          this.log.warn(`Subrequest budget exhausted: ${this.scope.budget.describe()}`);
        } else if (isClosedWritableStreamError(err)) {
          this.log.debug('WebSocket message arrived after outbound writer closed');
        } else {
          this.log.error('WebSocket message handle error', String(err));
        }
        this.finalize();
      });
    });

    this.webSocket.addEventListener('close', () => {
      this.finalize();
    });

    this.webSocket.addEventListener('error', () => {
      this.log.debug('WebSocket server error');
      this.finalize();
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleChunk(chunk: ArrayBuffer | ArrayBufferLike | Uint8Array): Promise<void> {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

    if (this.muxSession) {
      await this.muxSession.processData(bytes);
      return;
    }

    if (this.udpTransport) {
      this.udpTransport.write(bytes);
      return;
    }

    if (this.tcpTransport) {
      await this.tcpTransport.send(bytes);
      return;
    }

    await this.handleInitialChunk(bytes);
  }

  private async handleInitialChunk(
    chunk: ArrayBuffer | ArrayBufferLike | Uint8Array,
  ): Promise<void> {
    this.appendHeaderChunk(chunk);

    const {
      hasError,
      message,
      portRemote = 443,
      addressRemote = '',
      addressType,
      rawDataIndex,
      protocolVersion = new Uint8Array([0, 0]),
      isUDP,
      isMux,
      userUUID,
    } = processHeader(this.headerBuffer, this.validateUUID);

    if (hasError) {
      if (message === BUFFER_TOO_SHORT_MESSAGE) {
        return;
      }
      throw new Error(message);
    }

    this.address = addressRemote;
    const connectionType = isMux ? 'mux' : isUDP ? 'udp' : 'tcp';
    this.portWithRandomLog = `${portRemote}--${Math.random().toString(36).substring(2, 6)} ${connectionType}`;
    this.responseHeader = createResponseHeader(protocolVersion);

    const rawClientData = this.takeRawClientData(rawDataIndex);

    if (this.trafficStatsService.isEnabled && userUUID) {
      this.trafficTracker = this.trafficStatsService.createTracker(
        userUUID,
        `${addressRemote}:${portRemote}`,
        connectionType,
      );
    }

    await this.dispatchInitialConnection(
      { addressRemote, addressType, portRemote, isUDP, isMux },
      rawClientData,
    );
  }

  private appendHeaderChunk(chunk: ArrayBuffer | ArrayBufferLike | Uint8Array): void {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const newBuffer = new Uint8Array(this.headerBuffer.length + incoming.byteLength) as WorkerBytes;
    newBuffer.set(this.headerBuffer, 0);
    newBuffer.set(incoming, this.headerBuffer.length);
    this.headerBuffer = newBuffer;
  }

  private takeRawClientData(rawDataIndex: number | undefined): WorkerBytes {
    if (rawDataIndex === undefined) {
      throw new Error('Invalid header: missing raw data index');
    }

    const rawClientData = this.headerBuffer.slice(rawDataIndex) as WorkerBytes;
    this.headerBuffer = new Uint8Array(0) as WorkerBytes;
    return rawClientData;
  }

  private async dispatchInitialConnection(
    header: Pick<HeaderResult, 'addressRemote' | 'addressType' | 'portRemote' | 'isUDP' | 'isMux'>,
    rawClientData: WorkerBytes,
  ): Promise<void> {
    if (header.isMux && this.config.muxEnabled) {
      await this.startMuxTransport(rawClientData);
      return;
    }

    if (header.isUDP) {
      this.startUdpTransport(header.portRemote, rawClientData);
      return;
    }

    this.startTcpTransport(header, rawClientData);
  }

  private async startMuxTransport(rawClientData: WorkerBytes): Promise<void> {
    this.log.debug('Mux connection established');
    this.muxSession = createMuxSession({
      webSocket: this.webSocket,
      responseHeader: this.responseHeader,
      log: this.log,
      retryOptions: this.retryOptions,
      dnsServer: this.config.dnsServer,
      budget: this.scope.budget,
    });

    if (rawClientData.length > 0) {
      await this.muxSession.processData(rawClientData);
    }
  }

  private startUdpTransport(portRemote: number | undefined, rawClientData: WorkerBytes): void {
    if (portRemote !== 53) {
      throw new Error('UDP proxy only supports DNS (port 53)');
    }

    this.udpTransport = new UdpDnsTransport({
      webSocket: this.webSocket,
      responseHeader: this.responseHeader,
      log: this.log,
      dnsServer: this.config.dnsServer,
      budget: this.scope.budget,
    });

    if (rawClientData.length > 0) {
      this.udpTransport.write(rawClientData);
    }
  }

  private startTcpTransport(
    header: Pick<HeaderResult, 'addressRemote' | 'addressType' | 'portRemote'>,
    rawClientData: WorkerBytes,
  ): void {
    this.tcpTransport = new TcpTransport({
      addressRemote: header.addressRemote ?? '',
      addressType: header.addressType,
      portRemote: header.portRemote ?? 443,
      initialData: rawClientData,
      webSocket: this.webSocket,
      responseHeader: this.responseHeader,
      log: this.log,
      retryOptions: this.retryOptions,
      trafficTracker: this.trafficTracker,
      budget: this.scope.budget,
    });

    void this.tcpTransport.connect().catch((error) => {
      this.log.error('TCP outbound error', String(error));
      safeCloseWebSocket(this.webSocket);
    });
  }

  private finalize(): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;

    if (this.muxSession) {
      const muxStats = this.muxSession.getStats();
      if (this.trafficTracker) {
        this.trafficTracker.addUplink(muxStats.bytesReceived);
        this.trafficTracker.addDownlink(muxStats.bytesSent);
      }
      this.muxSession.close();
    }

    this.tcpTransport?.close();

    if (this.trafficTracker) {
      const stats = this.trafficTracker.getStats();
      this.log.debug(`Traffic: ↑${stats.uplink} ↓${stats.downlink}`);

      if (!this.trafficTracker.isReported() && this.trafficTracker.hasTraffic()) {
        this.trafficTracker.markReported();
        const reportPromise = this.trafficStatsService
          .report(stats, this.scope.budget)
          .then((ok) => {
            if (ok) {
              this.log.debug('Stats reported');
            }
          })
          .catch((error) => {
            this.log.error(`Stats report error: ${String(error)}`);
          });

        this.scope.executionContext.waitUntil(reportPromise);
      }
    }

    safeCloseWebSocket(this.webSocket);
  }
}
