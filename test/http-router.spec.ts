import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/http/auth-service';
import { HttpRouter } from '../src/http/http-router';
import type { UUIDProviderManager } from '../src/providers';
import { RequestMetricsService } from '../src/services/request-metrics';

function createUUIDManagerStub(): Pick<
  UUIDProviderManager,
  'getAllUUIDs' | 'refresh' | 'getStats'
> {
  return {
    getAllUUIDs: vi.fn(async () => ['d342d11e-d424-4583-b36e-524ab1f0afa4']),
    refresh: vi.fn(async () => undefined),
    getStats: vi.fn(async () => ({
      totalProviders: 1,
      totalUUIDs: 1,
      cacheStatus: 'hit' as const,
      cacheType: 'CacheAPI',
      providerDetails: [
        {
          name: 'mock-provider',
          priority: 10,
          available: true,
          uuidCount: 1,
        },
      ],
    })),
  };
}

describe('http router', () => {
  it('serves uuid lists with api authentication', async () => {
    const metrics = new RequestMetricsService();
    const router = new HttpRouter({
      authService: new AuthService('secret'),
      metrics,
    });
    const uuidManager = createUUIDManagerStub();

    const response = await router.handle(
      new Request('http://example.com/api/uuids', {
        headers: {
          Authorization: 'Bearer secret',
        },
      }),
      uuidManager as UUIDProviderManager,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      uuids: ['d342d11e-d424-4583-b36e-524ab1f0afa4'],
      count: 1,
    });
    expect(uuidManager.getAllUUIDs).toHaveBeenCalledOnce();
    expect(metrics.snapshot()).toMatchObject({
      authFailures: 0,
      successes: 1,
      errors: 0,
    });
  });

  it('rejects unauthorized api requests', async () => {
    const metrics = new RequestMetricsService();
    const router = new HttpRouter({
      authService: new AuthService('secret'),
      metrics,
    });

    const response = await router.handle(
      new Request('http://example.com/api/stats'),
      createUUIDManagerStub() as UUIDProviderManager,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'API key required. Use X-API-Key header or ?key= query parameter',
    });
    expect(metrics.snapshot()).toMatchObject({
      authFailures: 1,
      errors: 1,
    });
  });
});
