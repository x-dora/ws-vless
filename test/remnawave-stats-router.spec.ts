import { describe, expect, it, vi } from 'vitest';
import { RemnawaveStatsRouter } from '../src/http/remnawave-stats-router';
import type { TrafficStatsService } from '../src/services/stats-reporter';

describe('RemnawaveStatsRouter', () => {
  it('serves user stats without authorization', async () => {
    const service = {
      getUsersStats: vi.fn(async () => [{ username: 'uuid-1', uplink: 100, downlink: 200 }]),
    } as unknown as TrafficStatsService;
    const router = new RemnawaveStatsRouter({ trafficStatsService: service });
    const request = new Request('https://example.com/node/stats/get-users-stats', {
      method: 'POST',
      body: JSON.stringify({ reset: true }),
    });

    expect(router.canHandle(request)).toBe(true);

    const response = await router.handle(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        users: [{ username: 'uuid-1', uplink: 100, downlink: 200 }],
      },
    });
    expect(service.getUsersStats).toHaveBeenCalledWith(true, undefined);
  });

  it('serves combined stats with Remnawave response shape', async () => {
    const service = {
      getCombinedStats: vi.fn(async () => ({
        inbounds: [{ inbound: 'VLESS_WS', uplink: 100, downlink: 200 }],
        outbounds: [{ outbound: 'DIRECT', uplink: 100, downlink: 200 }],
      })),
    } as unknown as TrafficStatsService;
    const router = new RemnawaveStatsRouter({ trafficStatsService: service });

    const response = await router.handle(
      new Request('https://example.com/node/stats/get-combined-stats', {
        method: 'POST',
        body: JSON.stringify({ reset: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        inbounds: [{ inbound: 'VLESS_WS', uplink: 100, downlink: 200 }],
        outbounds: [{ outbound: 'DIRECT', uplink: 100, downlink: 200 }],
      },
    });
    expect(service.getCombinedStats).toHaveBeenCalledWith(false, undefined);
  });
});
