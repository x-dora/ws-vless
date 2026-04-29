/**
 * HTTP 路由器
 *
 * 负责所有非 WebSocket 请求的路由与响应构造。
 */

import type { UUIDProviderManager } from '../providers';
import type { RequestMetricsService } from '../services/request-metrics';
import { isSubrequestBudgetExceededError } from '../utils/subrequest-budget';
import type { AuthService } from './auth-service';

interface RouterDependencies {
  authService: AuthService;
  metrics: RequestMetricsService;
}

export class HttpRouter {
  constructor(private readonly deps: RouterDependencies) {}

  async handle(request: Request, uuidManager: UUIDProviderManager): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const auth = this.deps.authService.authorize(request);
      if (!auth.authorized) {
        this.deps.metrics.recordAuthFailure();
        this.deps.metrics.recordError(401);
        return this.json({ error: auth.reason }, 401);
      }
    }

    try {
      switch (url.pathname) {
        case '/':
          return this.rootResponse(request);

        case '/api/uuids':
          return await this.listUUIDs(uuidManager);

        case '/api/uuids/refresh':
          return await this.refreshUUIDs(uuidManager);

        case '/api/stats':
          return await this.providerStats(uuidManager);

        case '/api/metrics':
          return this.metrics();

        default:
          return this.notFound();
      }
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        this.deps.metrics.recordError(503);
        return this.json(
          {
            error: error.message,
          },
          503,
        );
      }

      this.deps.metrics.recordError();
      return this.json(
        {
          error: error instanceof Error ? error.message : 'Unexpected router error',
        },
        500,
      );
    }
  }

  private rootResponse(request: Request): Response {
    const cf = (request as unknown as { cf?: object }).cf;
    this.deps.metrics.recordSuccess(200);
    return this.json(cf || { message: 'Tunnel Worker Running' }, 200);
  }

  private async listUUIDs(uuidManager: UUIDProviderManager): Promise<Response> {
    const uuids = await uuidManager.getAllUUIDs();
    this.deps.metrics.recordSuccess(200);
    return this.json({ uuids, count: uuids.length }, 200);
  }

  private async refreshUUIDs(uuidManager: UUIDProviderManager): Promise<Response> {
    await uuidManager.refresh();
    const uuids = await uuidManager.getAllUUIDs();
    this.deps.metrics.recordSuccess(200);
    return this.json({ message: 'Cache refreshed', uuids, count: uuids.length }, 200);
  }

  private async providerStats(uuidManager: UUIDProviderManager): Promise<Response> {
    this.deps.metrics.recordSuccess(200);
    const [providerStats, requestStats] = await Promise.all([
      uuidManager.getStats(),
      Promise.resolve(this.deps.metrics.snapshot()),
    ]);
    return this.json(
      {
        providers: providerStats,
        requests: requestStats,
      },
      200,
    );
  }

  private metrics(): Response {
    this.deps.metrics.recordSuccess(200);
    return this.json(this.deps.metrics.snapshot(), 200);
  }

  private notFound(): Response {
    this.deps.metrics.recordError(404);
    return new Response('Not Found', { status: 404 });
  }

  private json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
