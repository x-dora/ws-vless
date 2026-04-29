/**
 * 请求统计服务
 *
 * 负责记录 Worker 层的聚合请求指标，不保存任何请求正文或会话数据。
 * 适合长期驻留在 Worker 实例中，作为全局可复用服务。
 */

export interface RequestMetricsSnapshot {
  requests: number;
  websocketUpgrades: number;
  successes: number;
  errors: number;
  authFailures: number;
  cacheHits: number;
  cacheMisses: number;
  routeHits: Record<string, number>;
  statusCodes: Record<number, number>;
}

export class RequestMetricsService {
  private requests = 0;
  private websocketUpgrades = 0;
  private successes = 0;
  private errors = 0;
  private authFailures = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly routeHits = new Map<string, number>();
  private readonly statusCodes = new Map<number, number>();

  recordRequest(route: string): void {
    this.requests += 1;
    this.bumpMap(this.routeHits, route);
  }

  recordWebSocketUpgrade(): void {
    this.websocketUpgrades += 1;
  }

  recordSuccess(status: number): void {
    this.successes += 1;
    this.bumpMap(this.statusCodes, status);
  }

  recordError(status = 500): void {
    this.errors += 1;
    this.bumpMap(this.statusCodes, status);
  }

  recordAuthFailure(): void {
    this.authFailures += 1;
  }

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  recordCacheMiss(): void {
    this.cacheMisses += 1;
  }

  snapshot(): RequestMetricsSnapshot {
    return {
      requests: this.requests,
      websocketUpgrades: this.websocketUpgrades,
      successes: this.successes,
      errors: this.errors,
      authFailures: this.authFailures,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      routeHits: Object.fromEntries(this.routeHits),
      statusCodes: Object.fromEntries(this.statusCodes),
    };
  }

  private bumpMap<T extends string | number>(map: Map<T, number>, key: T): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}
