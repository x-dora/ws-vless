import type { RuntimeConfig } from '../config';
import { resolveRetryOverrides } from '../config/request-overrides';
import type { OutboundRetryOptions } from '../utils/nat64';
import { createBudgetedFetcher, type SubrequestBudget } from '../utils/subrequest-budget';

export function createTunnelRetryOptions(
  request: Request,
  config: RuntimeConfig,
  budget: SubrequestBudget,
): OutboundRetryOptions {
  const url = new URL(request.url);
  const retryOverrides = resolveRetryOverrides(url.searchParams, {
    proxyIP: config.proxyIP,
    nat64Prefixes: config.nat64Prefixes,
  });

  return {
    proxyIP: retryOverrides.proxyIP,
    nat64Prefixes: retryOverrides.nat64Prefixes,
    resolverURL: config.nat64ResolverURL,
    fetcher: createBudgetedFetcher(budget, 'nat64 resolver fetch'),
  };
}
