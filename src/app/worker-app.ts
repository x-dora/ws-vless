/**
 * Worker 应用入口
 *
 * 这里负责把 AppContext、路由器和 WebSocket 网关串成最终的 fetch 处理器。
 */

import { createUUIDValidator } from '../core/header';
import { WebSocketGateway } from '../handlers/connection';
import { isXHttpStreamOneRequest, XHttpGateway } from '../handlers/xhttp';
import { HttpRouter } from '../http/http-router';
import type { WorkerEnv } from '../types';
import { isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import { AppContext } from './app-context';
import type { RequestScope } from './types';

const appCache = new WeakMap<WorkerEnv, WorkerApp>();

export class WorkerApp {
  private readonly httpRouter: HttpRouter;
  private readonly websocketGateway: WebSocketGateway;
  private readonly xhttpGateway: XHttpGateway;

  constructor(private readonly context: AppContext) {
    this.httpRouter = new HttpRouter({
      authService: this.context.authService,
      metrics: this.context.requestMetrics,
    });

    this.websocketGateway = new WebSocketGateway({
      config: this.context.config,
      trafficStatsService: this.context.trafficStatsService,
    });

    this.xhttpGateway = new XHttpGateway({
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

      if (isXHttpStreamOneRequest(request)) {
        const uuidManager = this.context.createUUIDManager(scope.budget);
        const validUUIDs = await uuidManager.getAllUUIDs();
        const validateUUID = createUUIDValidator(validUUIDs);

        const response = await this.xhttpGateway.handle(request, scope, validateUUID);
        if (response.status >= 400) {
          this.context.requestMetrics.recordError(response.status);
        } else {
          this.context.requestMetrics.recordSuccess(response.status);
        }
        return response;
      }

      const uuidManager = this.context.getUUIDManager();
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
  const cached = appCache.get(env);
  if (cached) {
    return cached;
  }

  const app = new WorkerApp(new AppContext(env));
  appCache.set(env, app);
  return app;
}
