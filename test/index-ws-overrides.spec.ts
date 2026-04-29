import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

const { resolveRetryOverridesMock } = vi.hoisted(() => ({
  resolveRetryOverridesMock: vi.fn((searchParams: URLSearchParams) => ({
    proxyIP: searchParams.get('PROXY_IP') ?? '',
    nat64Prefixes: ['64:ff9b::', '2001:db8:64::'],
  })),
}));

vi.mock('../src/config/request-overrides', () => ({
  resolveRetryOverrides: resolveRetryOverridesMock,
}));

import worker from '../src/index';

describe('worker websocket retry overrides', () => {
  beforeEach(() => {
    resolveRetryOverridesMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes retry overrides from websocket query parameters', async () => {
    const request = new Request(
      'https://example.com/?PROXY_IP=198.51.100.8&NAT64_PREFIXES=64:ff9b::,2001:db8:64::',
      {
        headers: { Upgrade: 'websocket' },
      },
    );
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      request,
      {
        ...env,
        DEV_MODE: 'true',
        UUID: TEST_UUID,
        RW_API_URL: undefined,
        RW_API_KEY: undefined,
      },
      ctx,
    );

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(101);
    expect(resolveRetryOverridesMock).toHaveBeenCalledOnce();

    const [searchParams, base] = resolveRetryOverridesMock.mock.calls[0] as unknown as [
      URLSearchParams,
      { proxyIP?: string; nat64Prefixes?: readonly string[] },
    ];
    expect(searchParams.get('PROXY_IP')).toBe('198.51.100.8');
    expect(searchParams.get('NAT64_PREFIXES')).toBe('64:ff9b::,2001:db8:64::');
    expect(base.proxyIP).toBe('');
    expect(base.nat64Prefixes).toEqual(['2602:fc59:11:64::']);
  });
});
