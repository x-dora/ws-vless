import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheAPIStore } from '../src/cache';
import { DEFAULT_SUBREQUEST_LIMIT, getConfig } from '../src/config';
import { UUIDProviderManager } from '../src/providers';
import { createStatsReporter } from '../src/services/stats-reporter';
import type { UUIDProvider, WorkerEnv } from '../src/types';
import {
  createSubrequestBudget,
  fetchWithBudget,
  SubrequestBudgetExceededError,
} from '../src/utils/subrequest-budget';

const TEST_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

describe('subrequest budget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers SUBREQUEST_LIMIT over MAX_SUBREQUESTS and falls back on invalid input', () => {
    expect(
      getConfig({
        SUBREQUEST_LIMIT: '96',
        MAX_SUBREQUESTS: '12',
      } as WorkerEnv).subrequestLimit,
    ).toBe(96);

    expect(
      getConfig({
        MAX_SUBREQUESTS: '64',
      } as WorkerEnv).subrequestLimit,
    ).toBe(64);

    expect(
      getConfig({
        SUBREQUEST_LIMIT: 'not-a-number',
        MAX_SUBREQUESTS: '64',
      } as WorkerEnv).subrequestLimit,
    ).toBe(DEFAULT_SUBREQUEST_LIMIT);
  });

  it('tracks consumption and throws once exhausted', () => {
    const budget = createSubrequestBudget(2);

    expect(budget.snapshot()).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
      exhausted: false,
    });

    expect(budget.consume(1, 'first')).toBe(1);
    expect(budget.snapshot()).toEqual({
      limit: 2,
      used: 1,
      remaining: 1,
      exhausted: false,
    });

    expect(budget.consume(1, 'second')).toBe(2);
    expect(budget.snapshot()).toEqual({
      limit: 2,
      used: 2,
      remaining: 0,
      exhausted: true,
    });

    try {
      budget.consume(1, 'third');
      throw new Error('expected budget exhaustion');
    } catch (error) {
      expect(error).toBeInstanceOf(SubrequestBudgetExceededError);
      expect(error).toMatchObject({
        name: 'SubrequestBudgetExceededError',
        limit: 2,
        used: 2,
        remaining: 0,
        operation: 'third',
      });
    }
  });

  it('counts Cache API operations against the same budget', async () => {
    const now = Date.now();
    const cacheMatch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          uuidMap: { cached: TEST_UUID },
          cachedAt: now,
          expiresAt: now + 60_000,
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const cachePut = vi.fn(async () => undefined);
    const cacheDelete = vi.fn(async () => true);

    vi.stubGlobal('caches', {
      default: {
        match: cacheMatch,
        put: cachePut,
        delete: cacheDelete,
      },
    });

    const budget = createSubrequestBudget(2);
    const store = new CacheAPIStore(budget);

    await expect(store.getMergedUUIDCache()).resolves.toMatchObject({
      uuidMap: { cached: TEST_UUID },
    });

    await expect(store.setMergedUUIDCache({ another: TEST_UUID }, 300)).resolves.toBeUndefined();
    await expect(store.deleteMergedUUIDCache()).rejects.toMatchObject({
      name: 'SubrequestBudgetExceededError',
    });

    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('counts direct fetches before execution', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const budget = createSubrequestBudget(1);

    await expect(
      fetchWithBudget(budget, 'https://example.com', undefined, 'unit test fetch'),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      fetchWithBudget(budget, 'https://example.org', undefined, 'unit test fetch'),
    ).rejects.toMatchObject({
      name: 'SubrequestBudgetExceededError',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets stats reporter and provider stats share the same budget', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });

    const report = createStatsReporter({
      endpoint: 'https://stats.example.test/worker/report',
      budget: createSubrequestBudget(1),
    });

    await expect(
      report({
        uuid: TEST_UUID,
        uplink: 128,
        downlink: 256,
      }),
    ).resolves.toBe(true);
    await expect(
      report({
        uuid: TEST_UUID,
        uplink: 128,
        downlink: 256,
      }),
    ).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches each provider only once when collecting stats', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });

    const fetchUUIDs = vi.fn(async () => [TEST_UUID]);
    const isAvailable = vi.fn(async () => {
      throw new Error('isAvailable should not be called by getStats()');
    });

    const manager = new UUIDProviderManager({
      budget: createSubrequestBudget(2),
    });

    manager.register({
      name: 'mock-provider',
      priority: 10,
      fetchUUIDs,
      isAvailable,
    } as UUIDProvider);

    const stats = await manager.getStats();

    expect(fetchUUIDs).toHaveBeenCalledTimes(1);
    expect(isAvailable).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      totalProviders: 1,
      cacheStatus: 'miss',
      providerDetails: [
        {
          name: 'mock-provider',
          priority: 10,
          available: true,
          uuidCount: 1,
        },
      ],
    });
  });
});
