import { AddressType } from '../types';

export interface Nat64ResolveOptions {
  nat64Prefixes?: readonly string[];
  resolverURL?: string;
  fetcher?: typeof fetch;
}

export interface OutboundRetryOptions extends Nat64ResolveOptions {
  proxyIP?: string;
}

export interface RetryTarget {
  address: string;
  mode: 'proxy-ip' | 'nat64';
}

interface DNSJsonAnswer {
  type?: number;
  data?: string;
}

interface DNSJsonResponse {
  Answer?: DNSJsonAnswer[];
}

const DNS_JSON_A_RECORD = 1;

function sanitizeHostLiteral(value: string): string {
  return value.trim().replace(/^\[(.*)\]$/, '$1');
}

export function parseNat64Prefixes(
  raw: string | readonly string[] | undefined,
  fallback: readonly string[] = [],
): string[] {
  const source =
    raw === undefined
      ? fallback
      : typeof raw === 'string'
        ? raw.split(',').map((item) => item.trim())
        : raw;

  const prefixes = source
    .map(normalizeNat64Prefix)
    .filter((prefix): prefix is string => prefix !== null);

  return prefixes.length > 0 ? prefixes : [...fallback];
}

export function normalizeNat64Prefix(prefix: string): string | null {
  const normalized = sanitizeHostLiteral(prefix)
    .toLowerCase()
    .replace(/\/\d+$/, '');
  if (!normalized || !normalized.includes(':')) {
    return null;
  }

  const nonEmptySegments = normalized.split(':').filter((segment) => segment.length > 0);
  if (nonEmptySegments.length > 6) {
    return null;
  }

  return normalized;
}

export function isIPv4Address(value: string): boolean {
  const normalized = sanitizeHostLiteral(value);
  const parts = normalized.split('.');
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255;
  });
}

export function isIPv6Address(value: string): boolean {
  const normalized = sanitizeHostLiteral(value);
  if (!normalized.includes(':')) {
    return false;
  }

  if (!/^[0-9a-f:.]+$/i.test(normalized)) {
    return false;
  }

  const doubleColonCount = normalized.split('::').length - 1;
  if (doubleColonCount > 1) {
    return false;
  }

  const segments = normalized.split(':');
  return segments.every((segment) => segment === '' || /^[0-9a-f]{1,4}$/i.test(segment));
}

export function selectNat64Prefix(prefixes: readonly string[], seed: string): string | null {
  if (prefixes.length === 0) {
    return null;
  }

  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return prefixes[hash % prefixes.length];
}

export function ipv4ToNat64IPv6(ipv4: string, prefix: string): string {
  if (!isIPv4Address(ipv4)) {
    throw new Error(`Invalid IPv4 address: ${ipv4}`);
  }

  const normalizedPrefix = normalizeNat64Prefix(prefix);
  if (!normalizedPrefix) {
    throw new Error(`Invalid NAT64 prefix: ${prefix}`);
  }

  const parts = sanitizeHostLiteral(ipv4)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const high = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, '0');
  const low = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, '0');
  const separator = normalizedPrefix.endsWith(':') ? '' : ':';

  return `${normalizedPrefix}${separator}${high}:${low}`;
}

export async function resolveDomainToIPv4(
  domain: string,
  resolverURL: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(`${resolverURL}?name=${encodeURIComponent(domain)}&type=A`, {
    headers: {
      Accept: 'application/dns-json',
    },
  });

  if (!response.ok) {
    throw new Error(`DNS resolver responded with ${response.status}`);
  }

  const payload = (await response.json()) as DNSJsonResponse;
  const record = payload.Answer?.find(
    (answer) =>
      answer.type === DNS_JSON_A_RECORD &&
      typeof answer.data === 'string' &&
      isIPv4Address(answer.data),
  );

  return record?.data ?? null;
}

function classifyAddress(address: string, addressType?: number): AddressType | null {
  if (
    addressType === AddressType.IPv4 ||
    addressType === AddressType.Domain ||
    addressType === AddressType.IPv6
  ) {
    return addressType;
  }

  if (isIPv4Address(address)) {
    return AddressType.IPv4;
  }

  if (isIPv6Address(address)) {
    return AddressType.IPv6;
  }

  return AddressType.Domain;
}

export async function resolveNat64Target(
  address: string,
  addressType: number | undefined,
  options: Nat64ResolveOptions,
): Promise<string | null> {
  const {
    nat64Prefixes = [],
    resolverURL = 'https://1.1.1.1/dns-query',
    fetcher = fetch,
  } = options;
  const normalizedAddress = sanitizeHostLiteral(address);
  const resolvedType = classifyAddress(normalizedAddress, addressType);

  if (resolvedType === AddressType.IPv6) {
    return null;
  }

  const prefix = selectNat64Prefix(nat64Prefixes, normalizedAddress);
  if (!prefix) {
    return null;
  }

  if (resolvedType === AddressType.IPv4) {
    return ipv4ToNat64IPv6(normalizedAddress, prefix);
  }

  const ipv4 = await resolveDomainToIPv4(normalizedAddress, resolverURL, fetcher);
  if (!ipv4) {
    return null;
  }

  return ipv4ToNat64IPv6(ipv4, prefix);
}

export async function resolveRetryTarget(
  address: string,
  addressType: number | undefined,
  options: OutboundRetryOptions,
): Promise<RetryTarget | null> {
  const proxyIP = options.proxyIP?.trim();
  if (proxyIP) {
    return {
      address: sanitizeHostLiteral(proxyIP),
      mode: 'proxy-ip',
    };
  }

  const nat64Target = await resolveNat64Target(address, addressType, options);
  if (!nat64Target) {
    return null;
  }

  return {
    address: nat64Target,
    mode: 'nat64',
  };
}
