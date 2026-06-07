/**
 * XHTTP stream-one gateway.
 *
 * Supports VLESS TCP and DNS-only UDP. Mux is rejected before any outbound
 * transport is created.
 */

import type { RequestScope } from '../app/types';
import type { RuntimeConfig } from '../config';
import { createResponseHeader, type UUIDValidator } from '../core/header';
import type { TrafficStatsService } from '../services/stats-reporter';
import type { ConnLogFunction, HeaderResult } from '../types';
import { isClosedWritableStreamError } from '../utils/_websocket';
import { createConnLog } from '../utils/logger';
import type { OutboundRetryOptions } from '../utils/nat64';
import { isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { StreamDownlinkSink } from './downlink';
import { InitialHeaderParser } from './initial-header';
import { createTunnelRetryOptions } from './retry-options';
import { TcpTransport } from './tcp';
import { TunnelTrafficReporter } from './tunnel-traffic';
import { UdpDnsTransport } from './udp';

type WorkerBytes = Uint8Array<ArrayBufferLike>;

const MAX_XHTTP_HEADER_BYTES = 4096;
const XHTTP_RESPONSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};
const XHTTP_UPLINK_STALL_LOG_MS = 25_000;

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
    const session = new XHttpConnectionSession({
      request,
      validateUUID,
      scope,
      config: this.options.config,
      trafficStatsService: this.options.trafficStatsService,
      retryOptions: createTunnelRetryOptions(request, this.options.config, scope.budget),
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
  private readonly initialParser: InitialHeaderParser;
  private readonly trafficReporter: TunnelTrafficReporter;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private address = '';
  private portWithRandomLog = '';
  private tcpTransport: TcpTransport | null = null;
  private udpTransport: UdpDnsTransport | null = null;
  private downlink: StreamDownlinkSink | null = null;
  private readerLocked = false;
  private cancelingReader = false;
  private finalized = false;
  private finalizePromise: Promise<void> | null = null;
  private startedAt = Date.now();
  private lastUplinkReadAt = 0;
  private lastTcpWriteAt = 0;
  private uplinkBytes = 0;
  private uplinkStallTimer: ReturnType<typeof setInterval> | null = null;
  private readonly abortListener = () => {
    this.log.debug('XHTTP request aborted');
    void this.finalize('request-abort');
  };

  constructor(options: SessionOptions) {
    this.request = options.request;
    this.validateUUID = options.validateUUID;
    this.scope = options.scope;
    this.config = options.config;
    this.trafficStatsService = options.trafficStatsService;
    this.retryOptions = options.retryOptions;
    this.log = createConnLog(() => `${this.address}:${this.portWithRandomLog}`);
    this.initialParser = new InitialHeaderParser(this.validateUUID, {
      maxHeaderBytes: MAX_XHTTP_HEADER_BYTES,
      headerTooLargeMessage: 'VLESS header exceeds limit',
    });
    this.trafficReporter = new TunnelTrafficReporter({
      scope: this.scope,
      service: this.trafficStatsService,
      log: this.log,
      label: 'XHTTP',
      warnOnReportFalse: true,
    });
  }

  async start(): Promise<Response> {
    if (!this.request.body) {
      return this.badRequest('Missing request body');
    }

    this.reader = this.request.body.getReader();
    this.request.signal.addEventListener('abort', this.abortListener, { once: true });

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

    if (parsed.header.isMux) {
      this.rejectAndReleaseReader();
      this.log.debug('XHTTP Mux command rejected');
      return this.badRequest('Bad Request');
    }

    if (parsed.header.isUDP && parsed.header.portRemote !== 53) {
      this.rejectAndReleaseReader();
      this.log.debug('XHTTP UDP non-DNS command rejected');
      return this.badRequest('Bad Request');
    }

    const responseHeader = createResponseHeader(
      parsed.header.protocolVersion ?? new Uint8Array([0]),
    );

    const { readable, writable } = new IdentityTransformStream();
    const downlink = new StreamDownlinkSink(writable.getWriter(), {
      onClose: () => {
        void this.finalize('downlink-close');
      },
      onAbort: (error) => {
        this.log.debug('XHTTP downlink aborted', String(error));
        void this.finalize('downlink-abort');
      },
    });
    this.downlink = downlink;
    const forwardDownlink = downlink.closed.then(
      () => this.finalize('downlink-close'),
      (error) => {
        if (isExpectedTunnelClose(error)) {
          this.log.debug('XHTTP downlink closed');
        } else {
          this.log.error('XHTTP downlink error', String(error));
        }
        return this.finalize('downlink-abort');
      },
    );

    this.createTransport(parsed.header, parsed.rawClientData, responseHeader, downlink);
    this.startUplinkStallProbe();
    void this.runTunnel(forwardDownlink);

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

      const parsed = this.initialParser.push(value);
      if (!parsed) {
        continue;
      }

      return this.createInitialHeaderResult(parsed);
    }
  }

  private createInitialHeaderResult(
    parsed: NonNullable<ReturnType<InitialHeaderParser['push']>>,
  ): ParsedInitialHeader {
    const result = parsed.header;
    const rawDataIndex = result.rawDataIndex;
    if (!result.addressRemote || result.portRemote === undefined || rawDataIndex === undefined) {
      throw new Error('Invalid VLESS header');
    }

    this.address = result.addressRemote;
    this.portWithRandomLog = `${result.portRemote}--${Math.random().toString(36).substring(2, 6)} ${parsed.connectionType}`;

    this.trafficReporter.start(
      result.userUUID,
      `${result.addressRemote}:${result.portRemote}`,
      'xhttp',
    );

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
      rawClientData: parsed.rawClientData,
    };
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
      trafficTracker: this.trafficReporter.currentTracker,
      budget: this.scope.budget,
      closeDownlinkOnRemoteClose: true,
    });
  }

  private createUdpTransport(
    rawClientData: WorkerBytes,
    responseHeader: Uint8Array,
    downlink: StreamDownlinkSink,
  ): void {
    this.udpTransport = new UdpDnsTransport({
      downlink,
      responseHeader,
      log: this.log,
      dnsServer: this.config.dnsServer,
      budget: this.scope.budget,
    });

    if (rawClientData.length > 0) {
      void this.udpTransport.write(rawClientData).catch((error) => {
        this.log.error('XHTTP UDP initial payload error', String(error));
        void this.finalize('udp-initial-error');
      });
    }
  }

  private createTransport(
    header: ParsedInitialHeader['header'],
    rawClientData: WorkerBytes,
    responseHeader: Uint8Array,
    downlink: StreamDownlinkSink,
  ): void {
    if (header.isUDP) {
      this.createUdpTransport(rawClientData, responseHeader, downlink);
      return;
    }

    this.createTcpTransport(header, rawClientData, responseHeader, downlink);
  }

  private async runTunnel(forwardDownlink: Promise<void>): Promise<void> {
    try {
      await Promise.all([this.connectTcpTransport(), this.pumpRequestBody(), forwardDownlink]);
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.log.warn(`Subrequest budget exhausted: ${this.scope.budget.describe()}`);
      } else if (isExpectedTunnelClose(error)) {
        this.log.debug('XHTTP stream closed during tunnel forwarding');
      } else {
        this.log.error('XHTTP tunnel error', String(error));
      }
    } finally {
      await this.finalize('run-tunnel-finally');
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
          await this.udpTransport?.closeInbound();
          break;
        }

        if (value.byteLength > 0) {
          this.lastUplinkReadAt = Date.now();
          this.uplinkBytes += value.byteLength;
          await this.sendClientChunk(value);
        }
      }
    } catch (error) {
      if (this.cancelingReader) {
        this.log.debug('XHTTP upstream reader closed');
      } else if (isExpectedRequestBodyClose(error)) {
        this.log.debug('XHTTP request body closed', String(error));
        void this.finalize('request-body-closed');
      } else {
        this.log.error('XHTTP request body read error', String(error));
        void this.finalize('request-body-error');
      }
    } finally {
      this.readerLocked = false;
      this.cancelingReader = false;
      this.releaseReader();
    }
  }

  private async sendClientChunk(chunk: Uint8Array): Promise<void> {
    if (this.udpTransport) {
      await this.udpTransport.write(chunk);
      return;
    }

    await this.tcpTransport?.send(chunk);
    this.lastTcpWriteAt = Date.now();
  }

  private rejectAndReleaseReader(): void {
    this.releaseReader();
    void this.finalize('request-rejected');
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

  private finalize(reason: string): Promise<void> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }
    this.finalized = true;

    this.finalizePromise = this.trafficReporter.report(reason);

    this.tcpTransport?.close();
    this.udpTransport?.close();
    this.downlink?.close();
    this.cancelRequestReader();
    this.stopUplinkStallProbe();
    this.request.signal.removeEventListener('abort', this.abortListener);

    return this.finalizePromise;
  }

  private startUplinkStallProbe(): void {
    this.startedAt = Date.now();
    this.lastUplinkReadAt = this.startedAt;
    this.lastTcpWriteAt = this.startedAt;

    this.uplinkStallTimer = setInterval(() => {
      if (this.finalized) {
        this.stopUplinkStallProbe();
        return;
      }

      const now = Date.now();
      this.log.debug(
        `XHTTP uplink still open: age=${now - this.startedAt}ms, ` +
          `lastRead=${now - this.lastUplinkReadAt}ms, ` +
          `lastTcpWrite=${now - this.lastTcpWriteAt}ms, uplinkBytes=${this.uplinkBytes}`,
      );
    }, XHTTP_UPLINK_STALL_LOG_MS);
  }

  private stopUplinkStallProbe(): void {
    if (this.uplinkStallTimer === null) {
      return;
    }

    clearInterval(this.uplinkStallTimer);
    this.uplinkStallTimer = null;
  }

  private badRequest(message: string): Response {
    return new Response(message, { status: 400 });
  }
}

function isExpectedRequestBodyClose(error: unknown): boolean {
  if (isClosedWritableStreamError(error)) {
    return true;
  }

  return (
    error instanceof TypeError &&
    /request stream.*client disconnected|client disconnected/i.test(error.message)
  );
}

function isExpectedTunnelClose(error: unknown): boolean {
  if (isClosedWritableStreamError(error)) {
    return true;
  }

  return (
    error instanceof TypeError &&
    /readablestream.*closed|closed.*readablestream/i.test(error.message)
  );
}
