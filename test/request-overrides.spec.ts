import { describe, expect, it } from 'vitest';
import { resolveRetryOverrides } from '../src/config/request-overrides';

const BASE = {
  proxyIP: '203.0.113.1',
  nat64Prefixes: ['2602:fc59:11:64::'],
} as const;

function resolveFromQuery(query: string) {
  const url = new URL(`https://example.com/${query}`);
  return resolveRetryOverrides(url.searchParams, BASE);
}

describe('request retry overrides', () => {
  it('falls back to base values when no override parameters are provided', () => {
    expect(resolveFromQuery('')).toEqual({
      proxyIP: '203.0.113.1',
      nat64Prefixes: ['2602:fc59:11:64::'],
    });
  });

  it('applies uppercase query parameters', () => {
    expect(
      resolveFromQuery('?PROXY_IP=198.51.100.8&NAT64_PREFIXES=64:ff9b::,2602:fc59:11:64::'),
    ).toEqual({
      proxyIP: '198.51.100.8',
      nat64Prefixes: ['64:ff9b::', '2602:fc59:11:64::'],
    });
  });

  it('applies lowercase query parameters', () => {
    expect(
      resolveFromQuery('?proxy_ip=198.51.100.9&nat64_prefixes=64:ff9b::,2001:db8:64::'),
    ).toEqual({
      proxyIP: '198.51.100.9',
      nat64Prefixes: ['64:ff9b::', '2001:db8:64::'],
    });
  });

  it('prefers uppercase parameters when both uppercase and lowercase are provided', () => {
    expect(
      resolveFromQuery(
        '?PROXY_IP=198.51.100.10&proxy_ip=198.51.100.11&NAT64_PREFIXES=64:ff9b::&nat64_prefixes=2001:db8:64::',
      ),
    ).toEqual({
      proxyIP: '198.51.100.10',
      nat64Prefixes: ['64:ff9b::'],
    });
  });

  it('ignores empty override values and keeps base values', () => {
    expect(resolveFromQuery('?PROXY_IP=&proxy_ip=&NAT64_PREFIXES=&nat64_prefixes=')).toEqual({
      proxyIP: '203.0.113.1',
      nat64Prefixes: ['2602:fc59:11:64::'],
    });
  });

  it('uses first non-empty value for repeated parameters', () => {
    expect(resolveFromQuery('?PROXY_IP=&PROXY_IP=  &PROXY_IP=198.51.100.12')).toEqual({
      proxyIP: '198.51.100.12',
      nat64Prefixes: ['2602:fc59:11:64::'],
    });
  });

  it('falls back to base NAT64 prefixes when override is invalid', () => {
    expect(resolveFromQuery('?NAT64_PREFIXES=invalid-prefix')).toEqual({
      proxyIP: '203.0.113.1',
      nat64Prefixes: ['2602:fc59:11:64::'],
    });
  });
});
