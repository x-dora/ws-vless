import { describe, expect, it, vi } from 'vitest';
import { AddressType } from '../src/types';
import {
  formatSocketHostname,
  ipv4ToNat64IPv6,
  resolveDomainToIPv4,
  resolveNat64Target,
  resolveRetryTarget,
  selectNat64Prefix,
} from '../src/utils/nat64';

const PREFIX = '2602:fc59:11:64::';

describe('NAT64 utilities', () => {
  it('converts IPv4 addresses into NAT64 IPv6 literals', () => {
    expect(ipv4ToNat64IPv6('192.0.2.33', PREFIX)).toBe('2602:fc59:11:64::c000:0221');
  });

  it('wraps IPv6 literals for connect()', () => {
    expect(formatSocketHostname('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatSocketHostname('[2001:db8::1]')).toBe('[2001:db8::1]');
    expect(formatSocketHostname('203.0.113.8')).toBe('203.0.113.8');
  });

  it('resolves domain A records and maps them into NAT64 targets', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          Answer: [{ type: 1, data: '198.51.100.7' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const target = await resolveNat64Target('example.com', AddressType.Domain, {
      nat64Prefixes: [PREFIX],
      resolverURL: 'https://resolver.example/dns-query',
      fetcher: fetcher as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(target).toBe('2602:fc59:11:64::c633:6407');
  });

  it('returns null for IPv6 targets and when no A record is available', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          Answer: [{ type: 28, data: '2001:db8::10' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    await expect(
      resolveNat64Target('2001:db8::1', AddressType.IPv6, {
        nat64Prefixes: [PREFIX],
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBeNull();

    await expect(
      resolveNat64Target('no-a.example', AddressType.Domain, {
        nat64Prefixes: [PREFIX],
        resolverURL: 'https://resolver.example/dns-query',
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it('surfaces resolver failures and keeps prefix selection deterministic', async () => {
    const fetcher = vi.fn(async () => new Response('resolver error', { status: 500 }));

    await expect(
      resolveDomainToIPv4(
        'broken.example',
        'https://resolver.example/dns-query',
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow('DNS resolver responded with 500');

    const prefixes = ['64:ff9b::', PREFIX];
    const first = selectNat64Prefix(prefixes, 'stable.example');

    expect(first).not.toBeNull();
    expect(selectNat64Prefix(prefixes, 'stable.example')).toBe(first);
  });

  it('prefers explicit PROXY_IP over NAT64 fallback', async () => {
    await expect(
      resolveRetryTarget('198.51.100.7', AddressType.IPv4, {
        proxyIP: '[203.0.113.8]',
        nat64Prefixes: [PREFIX],
      }),
    ).resolves.toEqual({
      address: '203.0.113.8',
      mode: 'proxy-ip',
    });
  });

  it('builds a NAT64 retry target when only IPv4 fallback is available', async () => {
    await expect(
      resolveRetryTarget('203.0.113.10', AddressType.IPv4, {
        nat64Prefixes: [PREFIX],
      }),
    ).resolves.toEqual({
      address: '2602:fc59:11:64::cb00:710a',
      mode: 'nat64',
    });
  });
});
