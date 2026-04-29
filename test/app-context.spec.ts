/**
 * AppContext 单元测试
 *
 * 测试应用上下文的初始化、服务创建和环境隔离。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/app/app-context';
import { AuthService } from '../src/http/auth-service';
import { RequestMetricsService } from '../src/services/request-metrics';
import { TrafficStatsService } from '../src/services/stats-reporter';
import type { WorkerEnv } from '../src/types';

// Mock logger to avoid console output during tests
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  initLogger: vi.fn(),
}));

// Mock providers
vi.mock('../src/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers')>();
  return {
    ...actual,
    createUUIDManager: vi.fn(() => ({
      getCacheType: () => 'CacheAPI',
      getAllUUIDs: vi.fn(async () => []),
      refresh: vi.fn(async () => {}),
      getStats: vi.fn(async () => ({})),
      register: vi.fn(),
    })),
    createRemnawaveProvider: vi.fn(() => null),
  };
});

describe('AppContext', () => {
  let env: WorkerEnv;

  beforeEach(() => {
    env = {
      UUID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
      API_KEY: 'test-api-key',
      DEV_MODE: 'true',
      STATS_REPORT_URL: 'https://example.com/stats',
      STATS_REPORT_TOKEN: 'stats-token',
      LOG_LEVEL: 'debug',
      RW_API_URL: undefined,
      RW_API_KEY: undefined,
      UUID_CACHE_TTL: undefined,
      PROXY_IP: undefined,
      DNS_SERVER: undefined,
      NAT64_PREFIXES: undefined,
      NAT64_RESOLVER_URL: undefined,
      MUX_ENABLED: undefined,
      MUX_TIMEOUT: undefined,
      SUBREQUEST_LIMIT: undefined,
      MAX_SUBREQUESTS: undefined,
      UUID_KV: undefined,
      UUID_D1: undefined,
    } as WorkerEnv;
  });

  it('initializes services on construction', () => {
    const context = new AppContext(env);

    // Verify services are created
    expect(context.config).toBeDefined();
    expect(context.authService).toBeInstanceOf(AuthService);
    expect(context.requestMetrics).toBeInstanceOf(RequestMetricsService);
    expect(context.trafficStatsService).toBeInstanceOf(TrafficStatsService);
  });

  it('returns UUID manager without budget', () => {
    const context = new AppContext(env);
    const manager = context.getUUIDManager();

    expect(manager).toBeDefined();
    expect(manager.getCacheType).toBeDefined();
  });

  it('creates UUID manager with budget when requested', () => {
    const context = new AppContext(env);
    const budget = { consume: vi.fn(), remaining: vi.fn(), describe: () => 'test' } as any;
    const manager = context.createUUIDManager(budget);

    expect(manager).toBeDefined();
  });

  it('configures auth service with API key', () => {
    const context = new AppContext(env);
    const result = context.authService.authorize(
      new Request('http://example.com/api/test', {
        headers: { 'X-API-Key': 'test-api-key' },
      }),
    );

    expect(result.authorized).toBe(true);
  });

  it('configures auth service without API key', () => {
    env.API_KEY = undefined;
    const context = new AppContext(env);
    const result = context.authService.authorize(new Request('http://example.com/api/test'));

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('API_KEY not configured');
  });

  it('creates request budget based on config', () => {
    const context = new AppContext(env);
    const budget = context.createRequestBudget();

    expect(budget).toBeDefined();
    expect(budget.consume).toBeDefined();
    expect(budget.remaining).toBeDefined();
  });

  it('returns same UUID manager instance from getUUIDManager', () => {
    const context = new AppContext(env);
    const manager1 = context.getUUIDManager();
    const manager2 = context.getUUIDManager();

    // Should return the same instance
    expect(manager1).toBe(manager2);
  });
});
