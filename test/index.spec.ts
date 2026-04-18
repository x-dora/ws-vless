import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const TEST_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

describe('worker root response', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes('/api/users')) {
          return new Response(
            JSON.stringify({
              response: {
                users: [{ vlessUuid: TEST_UUID, enabled: true }],
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the current root status payload', async () => {
    const request = new Request('http://example.com/');
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      {
        ...env,
        DEV_MODE: 'true',
        UUID: TEST_UUID,
        RW_API_URL: 'https://panel.example.test',
        RW_API_KEY: 'test-token',
      },
      ctx,
    );

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ message: 'Tunnel Worker Running' });
  });
});
