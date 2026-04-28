import { parseNat64Prefixes } from '../utils/nat64';

interface RetryOverridesBase {
  proxyIP?: string;
  nat64Prefixes: readonly string[];
}

export interface RetryOverrides {
  proxyIP: string;
  nat64Prefixes: string[];
}

function pickFirstNonEmptyValue(searchParams: URLSearchParams, key: string): string | undefined {
  const values = searchParams.getAll(key);
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function pickOverrideValue(
  searchParams: URLSearchParams,
  uppercaseKey: string,
  lowercaseKey: string,
): string | undefined {
  return (
    pickFirstNonEmptyValue(searchParams, uppercaseKey) ??
    pickFirstNonEmptyValue(searchParams, lowercaseKey)
  );
}

export function resolveRetryOverrides(
  searchParams: URLSearchParams,
  base: RetryOverridesBase,
): RetryOverrides {
  const proxyIPOverride = pickOverrideValue(searchParams, 'PROXY_IP', 'proxy_ip');
  const nat64PrefixesOverride = pickOverrideValue(searchParams, 'NAT64_PREFIXES', 'nat64_prefixes');

  return {
    proxyIP: proxyIPOverride ?? base.proxyIP ?? '',
    nat64Prefixes: nat64PrefixesOverride
      ? parseNat64Prefixes(nat64PrefixesOverride, base.nat64Prefixes)
      : [...base.nat64Prefixes],
  };
}
