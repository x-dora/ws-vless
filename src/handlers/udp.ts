/**
 * UDP 传输层
 *
 * 当前只支持 DNS over HTTPS。
 */

import { DEFAULT_DNS_SERVER } from '../config';
import type { ConnLogFunction } from '../types';
import {
  fetchWithBudget,
  isSubrequestBudgetExceededError,
  type SubrequestBudget,
} from '../utils/subrequest-budget';
import type { DownlinkSink } from './downlink';

export interface UdpDnsTransportOptions {
  downlink: DownlinkSink;
  responseHeader: Uint8Array;
  log: ConnLogFunction;
  dnsServer?: string;
  budget?: SubrequestBudget;
}

export class UdpDnsTransport {
  private pendingInput = new Uint8Array(0);
  private responseHeaderSent = false;
  private closedFlag = false;
  private processing: Promise<void> = Promise.resolve();
  private readonly closedResolve: () => void;
  private readonly closedReject: (error: unknown) => void;
  readonly closed: Promise<void>;

  constructor(private readonly options: UdpDnsTransportOptions) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closed = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    this.closed.catch(() => {
      // Errors are also surfaced through write()/closeInbound() callers.
    });
    this.closedResolve = resolve;
    this.closedReject = reject;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closedFlag || chunk.byteLength === 0) {
      return;
    }

    const packets = this.takePackets(chunk);
    for (const packet of packets) {
      this.processing = this.processing.then(() => this.handleDnsPacket(packet));
    }

    await this.processing;
  }

  async closeInbound(): Promise<void> {
    if (this.closedFlag) {
      return await this.closed;
    }

    if (this.pendingInput.byteLength > 0) {
      const error = new Error('Truncated UDP packet');
      this.fail(error);
      throw error;
    }

    try {
      await this.processing;
      this.close();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  close(): void {
    if (this.closedFlag) {
      return;
    }

    this.closedFlag = true;
    this.options.downlink.close();
    this.closedResolve();
  }

  private takePackets(chunk: Uint8Array): Uint8Array[] {
    const nextInput = new Uint8Array(this.pendingInput.byteLength + chunk.byteLength);
    nextInput.set(this.pendingInput, 0);
    nextInput.set(chunk, this.pendingInput.byteLength);

    const packets: Uint8Array[] = [];
    let offset = 0;
    while (nextInput.byteLength - offset >= 2) {
      const udpPacketLength = (nextInput[offset] << 8) | nextInput[offset + 1];
      const packetStart = offset + 2;
      const packetEnd = packetStart + udpPacketLength;
      if (nextInput.byteLength < packetEnd) {
        break;
      }

      packets.push(nextInput.slice(packetStart, packetEnd));
      offset = packetEnd;
    }

    this.pendingInput = nextInput.slice(offset);
    return packets;
  }

  private async handleDnsPacket(packet: Uint8Array): Promise<void> {
    if (this.closedFlag) {
      return;
    }

    try {
      const response = await fetchWithBudget(
        this.options.budget,
        this.options.dnsServer ?? DEFAULT_DNS_SERVER,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
          },
          body: packet,
        },
        'dns doh fetch',
      );

      const dnsQueryResult = await response.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

      if (!this.options.downlink.isOpen()) {
        return;
      }

      await this.sendResponseHeaderOnce();
      this.options.log.debug(`DoH success, DNS response length: ${udpSize}`);

      const dnsQueryArray = new Uint8Array(dnsQueryResult);
      const combined = new Uint8Array(udpSizeBuffer.length + dnsQueryArray.length);
      combined.set(udpSizeBuffer, 0);
      combined.set(dnsQueryArray, udpSizeBuffer.length);
      await this.options.downlink.send(combined);
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.options.log.warn(`DNS UDP budget exhausted: ${error.message}`);
      } else {
        this.options.log.error(`DNS UDP error: ${error}`);
      }
      this.fail(error);
      throw error;
    }
  }

  private async sendResponseHeaderOnce(): Promise<void> {
    if (this.responseHeaderSent || !this.options.downlink.isOpen()) {
      return;
    }

    await this.options.downlink.send(this.options.responseHeader);
    this.responseHeaderSent = true;
  }

  private fail(error: unknown): void {
    if (this.closedFlag) {
      return;
    }

    this.closedFlag = true;
    this.options.downlink.close();
    this.closedReject(error);
  }
}
