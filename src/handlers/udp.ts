/**
 * UDP 传输层
 *
 * 当前只支持 DNS over HTTPS。
 */

import { DEFAULT_DNS_SERVER } from '../config';
import type { ConnLogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import { safeCloseWebSocket } from '../utils/_websocket';
import {
  fetchWithBudget,
  isSubrequestBudgetExceededError,
  type SubrequestBudget,
} from '../utils/subrequest-budget';

export interface UdpDnsTransportOptions {
  webSocket: WebSocket;
  responseHeader: Uint8Array;
  log: ConnLogFunction;
  dnsServer?: string;
  budget?: SubrequestBudget;
}

export class UdpDnsTransport {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private isHeaderSent = false;

  constructor(private readonly options: UdpDnsTransportOptions) {
    const transformStream = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        for (let index = 0; index < chunk.byteLength; ) {
          const lengthBuffer = chunk.slice(index, index + 2);
          const udpPacketLength = new DataView(lengthBuffer.buffer).getUint16(0);
          const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
          index += 2 + udpPacketLength;
          controller.enqueue(udpData);
        }
      },
    });

    transformStream.readable
      .pipeTo(
        new WritableStream({
          write: async (chunk: Uint8Array) => {
            const response = await fetchWithBudget(
              this.options.budget,
              this.options.dnsServer ?? DEFAULT_DNS_SERVER,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/dns-message',
                },
                body: chunk,
              },
              'dns doh fetch',
            );

            const dnsQueryResult = await response.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (this.options.webSocket.readyState !== WS_READY_STATE.OPEN) {
              return;
            }

            this.options.log.debug(`DoH success, DNS response length: ${udpSize}`);

            if (this.isHeaderSent) {
              const combined = await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer();
              this.options.webSocket.send(combined);
            } else {
              const combined = await new Blob([
                this.options.responseHeader,
                udpSizeBuffer,
                dnsQueryResult,
              ]).arrayBuffer();
              this.options.webSocket.send(combined);
              this.isHeaderSent = true;
            }
          },
        }),
      )
      .catch((error) => {
        if (isSubrequestBudgetExceededError(error)) {
          this.options.log.warn(`DNS UDP budget exhausted: ${error.message}`);
          safeCloseWebSocket(this.options.webSocket);
          return;
        }
        this.options.log.error(`DNS UDP error: ${error}`);
      });

    this.writer = transformStream.writable.getWriter();
  }

  write(chunk: Uint8Array): void {
    void this.writer.write(chunk);
  }
}
