import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

const { handleTunnelOverWSMock } = vi.hoisted(() => ({
  handleTunnelOverWSMock: vi.fn(),
}));

vi.mock('../src/handlers/connection', () => ({
  handleTunnelOverWS: handleTunnelOverWSMock,
}));

import worker from '../src/index';

describe('worker websocket retry overrides', () => {
  beforeEach(() => {
    handleTunnelOverWSMock.mockReset();
    handleTunnelOverWSMock.mockResolvedValue(new Response('ok', { status: 200 }));
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

    expect(response.status).toBe(200);
    expect(handleTunnelOverWSMock).toHaveBeenCalledOnce();

    const options = handleTunnelOverWSMock.mock.calls[0]?.[1] as {
      proxyIP?: string;
      nat64Prefixes?: string[];
    };
    expect(options.proxyIP).toBe('198.51.100.8');
    expect(options.nat64Prefixes).toEqual(['64:ff9b::', '2001:db8:64::']);
  });
});
