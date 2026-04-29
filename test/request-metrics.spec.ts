import { describe, expect, it } from 'vitest';
import { RequestMetricsService } from '../src/services/request-metrics';

describe('request metrics service', () => {
  it('tracks request, route, status and cache counters', () => {
    const metrics = new RequestMetricsService();

    metrics.recordRequest('/api/uuids');
    metrics.recordWebSocketUpgrade();
    metrics.recordSuccess(200);
    metrics.recordError(404);
    metrics.recordAuthFailure();
    metrics.recordCacheHit();
    metrics.recordCacheMiss();

    expect(metrics.snapshot()).toMatchObject({
      requests: 1,
      websocketUpgrades: 1,
      successes: 1,
      errors: 1,
      authFailures: 1,
      cacheHits: 1,
      cacheMisses: 1,
      routeHits: {
        '/api/uuids': 1,
      },
      statusCodes: {
        200: 1,
        404: 1,
      },
    });
  });
});
