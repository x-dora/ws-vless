/**
 * Worker 应用入口
 *
 * 这里负责把 AppContext、路由器和 WebSocket 网关串成最终的 fetch 处理器。
 */

import { createUUIDValidator } from '../core/header';
import { WebSocketGateway } from '../handlers/connection';
import { HttpRouter } from '../http/http-router';
import type { WorkerEnv } from '../types';
import { isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { AppContext } from './app-context';
import type { RequestScope } from './types';

const appCache = new Map<string, WorkerApp>();

export class WorkerApp {
  private readonly httpRouter: HttpRouter;
  private readonly websocketGateway: WebSocketGateway;

  constructor(private readonly context: AppContext) {
    this.httpRouter = new HttpRouter({
      authService: this.context.authService,
      metrics: this.context.requestMetrics,
    });

    this.websocketGateway = new WebSocketGateway({
      config: this.context.config,
      trafficStatsService: this.context.trafficStatsService,
    });
  }

  async fetch(request: Request, _env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const scope: RequestScope = {
      executionContext: ctx,
      budget: this.context.createRequestBudget(),
    };

    const url = new URL(request.url);
    this.context.requestMetrics.recordRequest(url.pathname);

    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        this.context.requestMetrics.recordWebSocketUpgrade();

        const uuidManager = this.context.createUUIDManager(scope.budget);
        const validUUIDs = await uuidManager.getAllUUIDs();
        const validateUUID = createUUIDValidator(validUUIDs);

        const response = await this.websocketGateway.handle(request, scope, validateUUID);
        this.context.requestMetrics.recordSuccess(response.status);
        return response;
      }

      const uuidManager = this.context.createUUIDManager(scope.budget);
      return await this.httpRouter.handle(request, uuidManager);
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.context.requestMetrics.recordError(503);
        return new Response('Service Unavailable', { status: 503 });
      }

      this.context.requestMetrics.recordError(500);
      return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, {
        status: 500,
      });
    }
  }
}

export function getWorkerApp(env: WorkerEnv): WorkerApp {
  const key = buildAppKey(env);
  const cached = appCache.get(key);
  if (cached) {
    return cached;
  }

  const app = new WorkerApp(new AppContext(env));
  appCache.set(key, app);
  return app;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: env key builder intentionally lists all toggles for stable cache invalidation
function buildAppKey(env: WorkerEnv): string {
  return JSON.stringify({
    UUID: env.UUID ?? '',
    PROXY_IP: env.PROXY_IP ?? '',
    DNS_SERVER: env.DNS_SERVER ?? '',
    NAT64_PREFIXES: env.NAT64_PREFIXES ?? '',
    NAT64_RESOLVER_URL: env.NAT64_RESOLVER_URL ?? '',
    API_KEY: env.API_KEY ?? '',
    DEV_MODE: env.DEV_MODE ?? '',
    RW_API_URL: env.RW_API_URL ?? '',
    RW_API_KEY: env.RW_API_KEY ?? '',
    UUID_CACHE_TTL: env.UUID_CACHE_TTL ?? '',
    MUX_ENABLED: env.MUX_ENABLED ?? '',
    MUX_TIMEOUT: env.MUX_TIMEOUT ?? '',
    SUBREQUEST_LIMIT: env.SUBREQUEST_LIMIT ?? '',
    MAX_SUBREQUESTS: env.MAX_SUBREQUESTS ?? '',
    LOG_LEVEL: env.LOG_LEVEL ?? '',
    STATS_REPORT_URL: env.STATS_REPORT_URL ?? '',
    STATS_REPORT_TOKEN: env.STATS_REPORT_TOKEN ?? '',
    hasKV: Boolean(env.UUID_KV),
    hasD1: Boolean(env.UUID_D1),
  });
}
