/**
 * WebSocket 网关
 *
 * 将 VLESS 头解析、TCP/UDP/Mux 派发、流量统计和生命周期管理收敛到一个对象里。
 */

import type { RequestScope } from '../app/types';
import type { RuntimeConfig } from '../config';
import { resolveRetryOverrides } from '../config/request-overrides';
import { createResponseHeader, processHeader, type UUIDValidator } from '../core/header';
import type { TrafficStatsService, TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction } from '../types';
import { makeReadableWebSocketStream, safeCloseWebSocket } from '../utils/_websocket';
import { createConnLog } from '../utils/logger';
import type { OutboundRetryOptions } from '../utils/nat64';
import { createBudgetedFetcher, isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { createMuxSession, type MuxSession } from './mux-session';
import { TcpTransport } from './tcp';
import { UdpDnsTransport } from './udp';

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
  private responseHeader = new Uint8Array([0, 0]);
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
    this.webSocket.accept();

    const earlyDataHeader = this.request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(
      this.webSocket,
      earlyDataHeader,
      this.log,
    );

    readableWebSocketStream
      .pipeTo(
        new WritableStream({
          write: async (chunk: ArrayBuffer) => {
            await this.handleChunk(chunk);
          },
          close: () => {
            this.finalize();
          },
          abort: (reason) => {
            this.log.warn('ReadableWebSocketStream aborted', JSON.stringify(reason));
            this.finalize();
          },
        }),
      )
      .catch((error) => {
        if (isSubrequestBudgetExceededError(error)) {
          this.log.warn(`Subrequest budget exhausted: ${this.scope.budget.describe()}`);
          this.muxSession?.close();
          safeCloseWebSocket(this.webSocket);
          return;
        }

        this.log.error('ReadableWebSocketStream pipeTo error', String(error));
        this.finalize();
      });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.muxSession) {
      await this.muxSession.processData(chunk);
      return;
    }

    if (this.udpTransport) {
      this.udpTransport.write(new Uint8Array(chunk));
      return;
    }

    if (this.tcpTransport) {
      await this.tcpTransport.send(new Uint8Array(chunk));
      return;
    }

    await this.handleInitialChunk(chunk);
  }

  private async handleInitialChunk(chunk: ArrayBuffer): Promise<void> {
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
    } = processHeader(chunk, this.validateUUID);

    if (hasError) {
      throw new Error(message);
    }

    this.address = addressRemote;
    const connectionType = isMux ? 'mux' : isUDP ? 'udp' : 'tcp';
    this.portWithRandomLog = `${portRemote}--${Math.random().toString(36).substring(2, 6)} ${connectionType}`;
    this.responseHeader = createResponseHeader(protocolVersion);

    const rawClientData = new Uint8Array(chunk.slice(rawDataIndex));

    if (this.trafficStatsService.isEnabled && userUUID) {
      this.trafficTracker = this.trafficStatsService.createTracker(
        userUUID,
        `${addressRemote}:${portRemote}`,
        connectionType,
      );
    }

    if (isMux && this.config.muxEnabled) {
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
        await this.muxSession.processData(rawClientData.buffer);
      }
      return;
    }

    if (isUDP) {
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
      return;
    }

    this.tcpTransport = new TcpTransport({
      addressRemote,
      addressType,
      portRemote,
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
          .then((ok) =>
            ok ? this.log.debug('Stats reported') : this.log.warn('Stats report failed'),
          )
          .catch((error) => {
            this.log.error(`Stats report error: ${String(error)}`);
          });

        this.scope.executionContext.waitUntil(reportPromise);
      }
    }

    safeCloseWebSocket(this.webSocket);
  }
}
