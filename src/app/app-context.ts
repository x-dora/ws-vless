/**
 * 应用上下文
 *
 * 负责从 WorkerEnv 组装全局可复用的服务图。
 */

import { getConfig } from '../config';
import { AuthService } from '../http/auth-service';
import {
  createRemnawaveProvider,
  createUUIDManager as createUUIDManagerFactory,
  type UUIDProviderManager,
} from '../providers';
import { RequestMetricsService } from '../services/request-metrics';
import { TrafficStatsService } from '../services/stats-reporter';
import type { WorkerEnv } from '../types';
import { createLogger, initLogger } from '../utils/logger';
import { createSubrequestBudget, type SubrequestBudget } from '../utils/subrequest-budget';

const log = createLogger('App');

export class AppContext {
  readonly config: ReturnType<typeof getConfig>;
  readonly authService: AuthService;
  readonly requestMetrics = new RequestMetricsService();
  readonly trafficStatsService: TrafficStatsService;

  constructor(private readonly env: WorkerEnv) {
    this.config = getConfig(env);
    const devMode = env.DEV_MODE === 'true';
    initLogger(devMode, env.LOG_LEVEL);

    this.authService = new AuthService(env.API_KEY);
    this.trafficStatsService = new TrafficStatsService({
      endpoint: env.STATS_REPORT_URL,
      authToken: env.STATS_REPORT_TOKEN,
      enabled: Boolean(env.STATS_REPORT_URL),
    });

    const previewManager = this.createUUIDManager();
    log.info(devMode ? 'dev mode' : 'prod mode', `cache=${previewManager.getCacheType()}`);
  }

  createRequestBudget(): SubrequestBudget {
    return createSubrequestBudget(this.config.subrequestLimit);
  }

  createUUIDManager(budget?: SubrequestBudget): UUIDProviderManager {
    const devMode = this.env.DEV_MODE === 'true';
    const cacheTTL = parseOptionalInteger(this.env.UUID_CACHE_TTL);
    const effectiveDefaultUUID = devMode ? this.env.UUID || '' : '';
    const manager = createUUIDManagerFactory(effectiveDefaultUUID, {
      cacheTTL,
      kv: this.env.UUID_KV,
      d1: this.env.UUID_D1,
      budget,
    });

    const remnawaveProvider = createRemnawaveProvider(this.env.RW_API_URL, this.env.RW_API_KEY, {
      timeout: 10_000,
      budget,
    });

    if (remnawaveProvider) {
      manager.register(remnawaveProvider);
    }

    return manager;
  }
}

function parseOptionalInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
