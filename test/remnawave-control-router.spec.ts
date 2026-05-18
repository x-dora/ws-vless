import { describe, expect, it } from 'vitest';
import { RemnawaveControlRouter } from '../src/http/remnawave-control-router';

describe('RemnawaveControlRouter', () => {
  it('returns a compatible xray start success response', async () => {
    const router = new RemnawaveControlRouter();
    const request = new Request('https://example.com/node/xray/start', {
      method: 'POST',
      body: JSON.stringify({ xrayConfig: {}, internals: {} }),
    });

    expect(router.canHandle(request)).toBe(true);

    const response = await router.handle(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      response: {
        isStarted: true,
        version: '25.3.6',
        error: null,
        nodeInformation: {
          version: '2.7.0',
        },
        system: {
          info: {
            platform: 'workers',
          },
          stats: {
            uptime: 1,
            interface: null,
          },
        },
      },
    });
  });

  it('returns generic success for low-frequency handler updates', async () => {
    const router = new RemnawaveControlRouter();
    const response = await router.handle(
      new Request('https://example.com/node/handler/add-users', {
        method: 'POST',
        body: JSON.stringify({ users: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        success: true,
        error: null,
      },
    });
  });

  it('does not consume ignored request bodies', async () => {
    const router = new RemnawaveControlRouter();
    const request = new Request('https://example.com/node/plugin/sync', {
      method: 'POST',
      body: JSON.stringify({ users: [] }),
    });

    const response = await router.handle(request);

    expect(response.status).toBe(200);
    await expect(request.json()).resolves.toEqual({ users: [] });
  });
});
