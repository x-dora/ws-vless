/**
 * 流量统计服务
 *
 * 负责连接级流量追踪与流量上报。这里不再提供函数式闭包，
 * 而是让配置、追踪器和上报动作都归到一个服务对象中。
 */

import { createLogger } from '../utils/logger';
import {
  fetchWithBudget,
  isSubrequestBudgetExceededError,
  type SubrequestBudget,
} from '../utils/subrequest-budget';

const log = createLogger('Traffic');

export type TrafficType = 'tcp' | 'udp' | 'mux';

export interface TrafficStats {
  uuid: string;
  uplink: number;
  downlink: number;
  duration?: number;
  target?: string;
  type?: TrafficType;
}

export interface TrafficStatsServiceOptions {
  endpoint?: string;
  authToken?: string;
  timeout?: number;
  enabled?: boolean;
}

export class TrafficTracker {
  private uplink = 0;
  private downlink = 0;
  private readonly startTime = Date.now();
  private reported = false;

  constructor(
    public readonly uuid: string,
    public readonly target?: string,
    public readonly type?: TrafficType,
  ) {}

  addUplink(bytes: number): void {
    this.uplink += bytes;
  }

  addDownlink(bytes: number): void {
    this.downlink += bytes;
  }

  getStats(): TrafficStats {
    return {
      uuid: this.uuid,
      uplink: this.uplink,
      downlink: this.downlink,
      duration: Date.now() - this.startTime,
      target: this.target,
      type: this.type,
    };
  }

  markReported(): void {
    this.reported = true;
  }

  isReported(): boolean {
    return this.reported;
  }

  hasTraffic(): boolean {
    return this.uplink > 0 || this.downlink > 0;
  }
}

export class TrafficStatsService {
  private readonly endpoint?: string;
  private readonly authToken?: string;
  private readonly timeout: number;
  private readonly enabled: boolean;

  constructor(options: TrafficStatsServiceOptions = {}) {
    this.endpoint = options.endpoint;
    this.authToken = options.authToken;
    this.timeout = options.timeout ?? 5000;
    this.enabled = options.enabled ?? true;
  }

  get isEnabled(): boolean {
    return this.enabled && Boolean(this.endpoint);
  }

  createTracker(uuid: string, target?: string, type?: TrafficType): TrafficTracker {
    return new TrafficTracker(uuid, target, type);
  }

  async report(stats: TrafficStats, budget?: SubrequestBudget): Promise<boolean> {
    if (!this.isEnabled) {
      return true;
    }

    if (stats.uplink === 0 && stats.downlink === 0) {
      return true;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const endpoint = this.endpoint;
    if (!endpoint) {
      return true;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.authToken) {
        headers.Authorization = `Bearer ${this.authToken}`;
      }

      const response = await fetchWithBudget(
        budget,
        endpoint,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            uuid: stats.uuid,
            uplink: stats.uplink,
            downlink: stats.downlink,
          }),
          signal: controller.signal,
        },
        'traffic report',
      );

      if (response.ok) {
        log.debug(
          `reported ${stats.uuid} ↑${formatBytes(stats.uplink)} ↓${formatBytes(stats.downlink)}`,
        );
        return true;
      }

      log.warn(`traffic report failed: ${response.status} ${response.statusText}`);
      return false;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        log.warn(`traffic report skipped: ${error.message}`);
        return false;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('traffic report timeout');
      } else {
        log.warn('traffic report error:', error);
      }

      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async reportBatch(stats: TrafficStats[], budget?: SubrequestBudget): Promise<boolean> {
    if (!this.isEnabled) {
      return true;
    }

    if (stats.length === 0) {
      return true;
    }

    const validStats = stats.filter((item) => item.uplink > 0 || item.downlink > 0);
    if (validStats.length === 0) {
      return true;
    }

    const batchEndpoint = this.endpoint?.replace('/worker/report', '/worker/batch-report');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.authToken) {
        headers.Authorization = `Bearer ${this.authToken}`;
      }

      const response = await fetchWithBudget(
        budget,
        batchEndpoint,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            reports: validStats.map((item) => ({
              uuid: item.uuid,
              uplink: item.uplink,
              downlink: item.downlink,
            })),
          }),
        },
        'traffic batch report',
      );

      return response.ok;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        log.warn(`batch traffic report skipped: ${error.message}`);
        return false;
      }

      log.warn('batch traffic report error:', error);
      return false;
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** index).toFixed(2))} ${sizes[index]}`;
}
