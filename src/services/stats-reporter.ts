/**
 * 流量统计上报服务
 * 在连接断开后将用户流量上报到外部统计服务（如 mock_node.py）
 */

import { createLogger } from '../utils/logger';

const log = createLogger('StatsReporter');

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 流量统计数据
 */
export interface TrafficStats {
  /** 用户 vlessUuid（Worker 只知道这个） */
  uuid: string;
  /** 上行流量（字节） */
  uplink: number;
  /** 下行流量（字节） */
  downlink: number;
  /** 连接时长（毫秒） */
  duration?: number;
  /** 目标地址 */
  target?: string;
  /** 连接类型 */
  type?: 'tcp' | 'udp' | 'mux';
}

/**
 * 上报配置
 */
export interface StatsReporterConfig {
  /** 上报端点 URL */
  endpoint: string;
  /** 认证 Token（可选） */
  authToken?: string;
  /** 请求超时（毫秒），默认 5000 */
  timeout?: number;
  /** 是否启用 */
  enabled?: boolean;
}

// ============================================================================
// 流量追踪器
// ============================================================================

/**
 * 连接流量追踪器
 * 用于追踪单个连接的流量
 */
export class TrafficTracker {
  private uplink = 0;
  private downlink = 0;
  private startTime: number;
  private reported = false;

  constructor(
    /** 用户 vlessUuid */
    public readonly uuid: string,
    public readonly target?: string,
    public readonly type?: 'tcp' | 'udp' | 'mux'
  ) {
    this.startTime = Date.now();
  }

  /**
   * 记录上行流量（客户端 -> 远程）
   */
  addUplink(bytes: number): void {
    this.uplink += bytes;
  }

  /**
   * 记录下行流量（远程 -> 客户端）
   */
  addDownlink(bytes: number): void {
    this.downlink += bytes;
  }

  /**
   * 获取当前统计
   */
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

  /**
   * 标记为已上报
   */
  markReported(): void {
    this.reported = true;
  }

  /**
   * 是否已上报
   */
  isReported(): boolean {
    return this.reported;
  }

  /**
   * 是否有流量
   */
  hasTraffic(): boolean {
    return this.uplink > 0 || this.downlink > 0;
  }
}

// ============================================================================
// 流量上报器
// ============================================================================

/**
 * 创建流量上报器
 * 
 * @param config 上报配置
 * @returns 上报函数，返回 Promise<boolean> 表示是否成功
 */
export function createStatsReporter(config: StatsReporterConfig) {
  const { endpoint, authToken, timeout = 5000, enabled = true } = config;

  if (!enabled || !endpoint) {
    log.debug('Stats reporter disabled');
    return async (_stats: TrafficStats): Promise<boolean> => true;
  }

  log.info('Stats reporter enabled', endpoint);

  /**
   * 上报单个连接的流量
   */
  return async function report(stats: TrafficStats): Promise<boolean> {
    // 无流量不上报
    if (stats.uplink === 0 && stats.downlink === 0) {
      return true;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // 直接使用 vlessUuid，Remnawave 就是用 vlessUuid 作为 Xray username
          uuid: stats.uuid,
          uplink: stats.uplink,
          downlink: stats.downlink,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        log.debug(
          `Stats reported: ${stats.uuid} ↑${formatBytes(stats.uplink)} ↓${formatBytes(stats.downlink)}`
        );
        return true;
      } else {
        log.warn(`Stats report failed: ${response.status} ${response.statusText}`);
        return false;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('Stats report timeout');
      } else {
        log.warn('Stats report error:', error);
      }
      return false;
    }
  };
}

/**
 * 批量上报流量
 * 
 * @param endpoint 上报端点
 * @param stats 流量统计数组
 * @param authToken 认证 Token
 */
export async function batchReportStats(
  endpoint: string,
  stats: TrafficStats[],
  authToken?: string
): Promise<boolean> {
  if (stats.length === 0) return true;

  // 过滤无流量的记录
  const validStats = stats.filter(s => s.uplink > 0 || s.downlink > 0);
  if (validStats.length === 0) return true;

  const batchEndpoint = endpoint.replace('/worker/report', '/worker/batch-report');

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(batchEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reports: validStats.map(s => ({
          uuid: s.uuid,
          uplink: s.uplink,
          downlink: s.downlink,
        })),
      }),
    });

    return response.ok;
  } catch (error) {
    log.warn('Batch stats report error:', error);
    return false;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化字节数
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
