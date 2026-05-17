/**
 * XHTTP stream-one gateway.
 *
 * The first implementation supports VLESS TCP only. UDP and Mux are rejected
 * before any outbound TCP socket is created.
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
import { isClosedWritableStreamError } from '../utils/_websocket';
import { createConnLog } from '../utils/logger';
import type { OutboundRetryOptions } from '../utils/nat64';
import { createBudgetedFetcher, isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { StreamDownlinkSink } from './downlink';
import { TcpTransport } from './tcp';

type WorkerBytes = Uint8Array<ArrayBufferLike>;

const MAX_XHTTP_HEADER_BYTES = 4096;
const XHTTP_RESPONSE_HEADERS = {
  'Content-Type': 'application/grpc',
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
};

interface XHttpGatewayOptions {
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

interface ParsedInitialHeader {
  header: Required<Pick<HeaderResult, 'addressRemote' | 'portRemote' | 'rawDataIndex'>> &
    Pick<HeaderResult, 'addressType' | 'protocolVersion' | 'isUDP' | 'isMux' | 'userUUID'>;
  rawClientData: WorkerBytes;
}

export function isXHttpStreamOneRequest(request: Request): boolean {
  if (request.method !== 'POST' || request.body === null) {
    return false;
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return false;
  }

  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    return false;
  }

  return request.headers.get('Content-Type')?.toLowerCase().includes('application/grpc') ?? false;
}

export class XHttpGateway {
  constructor(private readonly options: XHttpGatewayOptions) {}

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

    const session = new XHttpConnectionSession({
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

class XHttpConnectionSession {
  private readonly request: Request;
  private readonly validateUUID: UUIDValidator;
  private readonly scope: RequestScope;
  private readonly config: RuntimeConfig;
  private readonly trafficStatsService: TrafficStatsService;
  private readonly retryOptions: OutboundRetryOptions;
  private readonly log: ConnLogFunction;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private headerBuffer: WorkerBytes = new Uint8Array(0) as WorkerBytes;
  private address = '';
  private portWithRandomLog = '';
  private trafficTracker: TrafficTracker | null = null;
  private tcpTransport: TcpTransport | null = null;
  private readerLocked = false;
  private cancelingReader = false;
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
    if (!this.request.body) {
      return this.badRequest('Missing request body');
    }

    this.reader = this.request.body.getReader();

    let parsed: ParsedInitialHeader;
    try {
      parsed = await this.readInitialHeader();
    } catch (error) {
      this.rejectAndReleaseReader();
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      this.log.debug('XHTTP header rejected', String(error));
      return this.badRequest('Bad Request');
    }

    if (parsed.header.isUDP) {
      this.rejectAndReleaseReader();
      this.log.debug('XHTTP UDP command rejected');
      return this.badRequest('Bad Request');
    }

    if (parsed.header.isMux) {
      this.rejectAndReleaseReader();
      this.log.debug('XHTTP Mux command rejected');
      return this.badRequest('Bad Request');
    }

    const responseHeader = createResponseHeader(
      parsed.header.protocolVersion ?? new Uint8Array([0]),
    );

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const { readable: downlinkReadable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        const downlink = new StreamDownlinkSink(writable.getWriter());
        const forwardDownlink = downlinkReadable.pipeTo(
          new WritableStream<Uint8Array>({
            write: (chunk) => {
              controller.enqueue(chunk);
            },
            close: () => {
              controller.close();
              this.finalize();
            },
            abort: (reason) => {
              controller.error(reason);
              this.finalize();
            },
          }),
        );

        this.createTcpTransport(parsed.header, parsed.rawClientData, responseHeader, downlink);
        void this.runTunnel(forwardDownlink);
      },
      cancel: () => {
        this.finalize();
      },
    });

    return new Response(readable, {
      status: 200,
      headers: XHTTP_RESPONSE_HEADERS,
    });
  }

  private async readInitialHeader(): Promise<ParsedInitialHeader> {
    if (!this.reader) {
      throw new Error('Request body reader is not initialized');
    }

    while (true) {
      const { done, value } = await this.reader.read();
      if (done) {
        throw new Error('Incomplete VLESS header');
      }

      this.appendHeaderChunk(value);

      const result = this.parseBufferedHeader();
      if (!result) {
        continue;
      }

      return this.createInitialHeaderResult(result);
    }
  }

  private parseBufferedHeader(): HeaderResult | null {
    const result = processHeader(this.headerBuffer, this.validateUUID);
    if (!result.hasError) {
      return result;
    }

    if (result.message !== BUFFER_TOO_SHORT_MESSAGE) {
      throw new Error(result.message ?? 'Invalid VLESS header');
    }

    if (this.headerBuffer.byteLength > MAX_XHTTP_HEADER_BYTES) {
      throw new Error('VLESS header exceeds limit');
    }

    return null;
  }

  private createInitialHeaderResult(result: HeaderResult): ParsedInitialHeader {
    const rawDataIndex = result.rawDataIndex;
    if (!result.addressRemote || result.portRemote === undefined || rawDataIndex === undefined) {
      throw new Error('Invalid VLESS header');
    }

    this.address = result.addressRemote;
    const connectionType = result.isMux ? 'mux' : result.isUDP ? 'udp' : 'tcp';
    this.portWithRandomLog = `${result.portRemote}--${Math.random().toString(36).substring(2, 6)} ${connectionType}`;
    const rawClientData = this.takeRawClientData(rawDataIndex);

    if (this.trafficStatsService.isEnabled && result.userUUID) {
      this.trafficTracker = this.trafficStatsService.createTracker(
        result.userUUID,
        `${result.addressRemote}:${result.portRemote}`,
        connectionType,
      );
    }

    return {
      header: {
        addressRemote: result.addressRemote,
        addressType: result.addressType,
        portRemote: result.portRemote,
        rawDataIndex,
        protocolVersion: result.protocolVersion,
        isUDP: result.isUDP,
        isMux: result.isMux,
        userUUID: result.userUUID,
      },
      rawClientData,
    };
  }

  private appendHeaderChunk(chunk: Uint8Array): void {
    const newBuffer = new Uint8Array(this.headerBuffer.length + chunk.byteLength) as WorkerBytes;
    newBuffer.set(this.headerBuffer, 0);
    newBuffer.set(chunk, this.headerBuffer.length);
    this.headerBuffer = newBuffer;
  }

  private takeRawClientData(rawDataIndex: number): WorkerBytes {
    const rawClientData = this.headerBuffer.slice(rawDataIndex) as WorkerBytes;
    this.headerBuffer = new Uint8Array(0) as WorkerBytes;
    return rawClientData;
  }

  private createTcpTransport(
    header: Pick<HeaderResult, 'addressRemote' | 'addressType' | 'portRemote'>,
    rawClientData: WorkerBytes,
    responseHeader: Uint8Array,
    downlink: StreamDownlinkSink,
  ): void {
    this.tcpTransport = new TcpTransport({
      addressRemote: header.addressRemote ?? '',
      addressType: header.addressType,
      portRemote: header.portRemote ?? 443,
      initialData: rawClientData,
      downlink,
      responseHeader,
      log: this.log,
      retryOptions: this.retryOptions,
      trafficTracker: this.trafficTracker,
      budget: this.scope.budget,
      closeDownlinkOnRemoteClose: true,
    });
  }

  private async runTunnel(forwardDownlink: Promise<void>): Promise<void> {
    try {
      await Promise.all([this.connectTcpTransport(), this.pumpRequestBody(), forwardDownlink]);
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.log.warn(`Subrequest budget exhausted: ${this.scope.budget.describe()}`);
      } else if (isClosedWritableStreamError(error)) {
        this.log.debug('XHTTP stream closed during tunnel forwarding');
      } else {
        this.log.error('XHTTP tunnel error', String(error));
      }
    } finally {
      this.finalize();
    }
  }

  private async connectTcpTransport(): Promise<void> {
    if (!this.tcpTransport) {
      return;
    }

    await this.tcpTransport.connect();
  }

  private async pumpRequestBody(): Promise<void> {
    if (!this.reader) {
      return;
    }

    try {
      this.readerLocked = true;
      while (!this.finalized) {
        const { done, value } = await this.reader.read();
        if (done) {
          await this.tcpTransport?.closeOutbound();
          break;
        }

        if (value.byteLength > 0) {
          await this.tcpTransport?.send(value);
        }
      }
    } catch (error) {
      if (this.cancelingReader || isClosedWritableStreamError(error)) {
        this.log.debug('XHTTP upstream reader closed');
      } else {
        this.log.error('XHTTP request body read error', String(error));
      }
    } finally {
      this.readerLocked = false;
      this.cancelingReader = false;
      this.releaseReader();
    }
  }

  private rejectAndReleaseReader(): void {
    this.releaseReader();
    this.finalize();
  }

  private releaseReader(): void {
    if (this.readerLocked || !this.reader) {
      return;
    }

    try {
      this.reader.releaseLock();
    } catch {
      // ignore
    }
    this.reader = null;
  }

  private cancelRequestReader(): void {
    if (!this.reader || this.cancelingReader) {
      return;
    }

    this.cancelingReader = true;
    void this.reader.cancel().catch((error) => {
      this.log.debug('XHTTP request body cancel error', String(error));
    });
  }

  private finalize(): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;

    this.tcpTransport?.close();
    this.cancelRequestReader();

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
  }

  private badRequest(message: string): Response {
    return new Response(message, { status: 400 });
  }
}
