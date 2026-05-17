import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownlinkSink } from '../src/handlers/downlink';
import { UdpDnsTransport } from '../src/handlers/udp';
import type { ConnLogFunction } from '../src/types';

interface DownlinkStub extends DownlinkSink {
  chunks: Uint8Array[];
  close: ReturnType<typeof vi.fn>;
}

function createDownlinkStub(): DownlinkStub {
  const chunks: Uint8Array[] = [];
  const downlink = {
    chunks,
    send: vi.fn(async (chunk: Uint8Array) => {
      chunks.push(new Uint8Array(chunk));
    }),
    close: vi.fn(() => {
      downlink.open = false;
    }),
    isOpen: vi.fn(() => downlink.open),
    open: true,
  };

  return downlink;
}

function createLog(): ConnLogFunction {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createUdpPacket(payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(2 + payload.byteLength);
  packet[0] = (payload.byteLength >> 8) & 0xff;
  packet[1] = payload.byteLength & 0xff;
  packet.set(payload, 2);
  return packet;
}

describe('UDP DNS transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the VLESS response header only once through the downlink', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([9])))),
    );

    const downlink = createDownlinkStub();
    const transport = new UdpDnsTransport({
      downlink,
      responseHeader: new Uint8Array([0, 0]),
      log: createLog(),
    });

    await transport.write(new Uint8Array([0, 1, 1, 0, 1, 2]));
    await transport.closeInbound();

    expect(
      downlink.chunks.filter(
        (chunk) =>
          chunk instanceof Uint8Array && chunk.length === 2 && chunk[0] === 0 && chunk[1] === 0,
      ),
    ).toHaveLength(1);
  });

  it('sends a complete UDP datagram through DoH and returns a length-prefixed response', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([9, 8, 7]))));
    vi.stubGlobal('fetch', fetchMock);
    const downlink = createDownlinkStub();
    const dnsQuery = new Uint8Array([1, 2, 3]);
    const transport = new UdpDnsTransport({
      downlink,
      responseHeader: new Uint8Array([1, 0]),
      log: createLog(),
    });

    await transport.write(createUdpPacket(dnsQuery));
    await transport.closeInbound();

    expect(fetchMock).toHaveBeenCalledWith('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: dnsQuery,
    });
    expect(downlink.chunks).toEqual([new Uint8Array([1, 0]), new Uint8Array([0, 3, 9, 8, 7])]);
  });

  it('reassembles UDP datagrams split across writes', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([4, 5]))));
    vi.stubGlobal('fetch', fetchMock);
    const downlink = createDownlinkStub();
    const transport = new UdpDnsTransport({
      downlink,
      responseHeader: new Uint8Array([1, 0]),
      log: createLog(),
    });

    await transport.write(new Uint8Array([0, 3, 1]));
    expect(fetchMock).not.toHaveBeenCalled();
    await transport.write(new Uint8Array([2, 3]));
    await transport.closeInbound();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(downlink.chunks).toEqual([new Uint8Array([1, 0]), new Uint8Array([0, 2, 4, 5])]);
  });
});
