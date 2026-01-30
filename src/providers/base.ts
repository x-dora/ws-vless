/**
 * UUID 提供者基类模块
 * 定义 UUID 提供者的基础抽象类和通用实现
 */

import type { UUIDProvider, UUIDProviderConfig } from '../types';
import { providerLogger } from '../utils/logger';

// ============================================================================
// 抽象基类
// ============================================================================

/**
 * UUID 提供者抽象基类
 * 所有自定义 UUID 提供者都应该继承此类
 */
export abstract class BaseUUIDProvider implements UUIDProvider {
  /** 提供者名称 */
  public abstract readonly name: string;
  
  /** 提供者优先级（数字越小优先级越高） */
  public readonly priority: number;
  
  /** 提供者配置 */
  protected readonly config: UUIDProviderConfig;
  
  /** 缓存的 UUID 列表 */
  protected cachedUUIDs: string[] = [];
  
  /** 缓存过期时间 */
  protected cacheExpiry: number = 0;
  
  /** 默认缓存时间（毫秒） */
  protected readonly cacheDuration: number = 5 * 60 * 1000; // 5 分钟

  constructor(config: UUIDProviderConfig, priority = 100) {
    this.config = config;
    this.priority = priority;
  }

  /**
   * 获取可用的 UUID 列表
   * 实现缓存逻辑，子类应该实现 doFetchUUIDs
   */
  async fetchUUIDs(): Promise<string[]> {
    // 检查缓存是否有效
    if (this.cachedUUIDs.length > 0 && Date.now() < this.cacheExpiry) {
      return this.cachedUUIDs;
    }

    try {
      const uuids = await this.doFetchUUIDs();
      this.cachedUUIDs = uuids;
      this.cacheExpiry = Date.now() + this.cacheDuration;
      return uuids;
    } catch (error) {
      providerLogger.error(`[${this.name}] Failed to fetch UUIDs:`, error);
      // 如果获取失败但有缓存，返回缓存
      if (this.cachedUUIDs.length > 0) {
        return this.cachedUUIDs;
      }
      throw error;
    }
  }

  /**
   * 验证提供者是否可用
   * 默认实现：尝试获取 UUID，成功则可用
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const uuids = await this.fetchUUIDs();
      return uuids.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 实际获取 UUID 的方法
   * 子类必须实现此方法
   */
  protected abstract doFetchUUIDs(): Promise<string[]>;

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cachedUUIDs = [];
    this.cacheExpiry = 0;
  }

  /**
   * 创建带超时的 fetch 请求
   * @param url 请求 URL
   * @param options fetch 选项
   */
  protected async fetchWithTimeout(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const timeout = this.config.timeout || 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.config.headers,
          ...options.headers,
        },
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ============================================================================
// 静态 UUID 提供者
// ============================================================================

/**
 * 静态 UUID 提供者
 * 从配置中的静态列表获取 UUID
 */
export class StaticUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'static';
  private readonly staticUUIDs: string[];

  constructor(uuids: string[], priority = 0) {
    super({ enabled: true }, priority);
    this.staticUUIDs = uuids;
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    return this.staticUUIDs;
  }

  async isAvailable(): Promise<boolean> {
    return this.staticUUIDs.length > 0;
  }
}

// ============================================================================
// 示例：HTTP API 提供者
// ============================================================================

/**
 * HTTP API UUID 提供者
 * 从远程 HTTP API 获取 UUID 列表
 * 
 * 期望的 API 响应格式:
 * {
 *   "uuids": ["uuid1", "uuid2", ...]
 * }
 * 
 * 或者直接返回数组:
 * ["uuid1", "uuid2", ...]
 */
export class HttpApiUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'http-api';

  constructor(config: UUIDProviderConfig, priority = 50) {
    super(config, priority);
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    if (!this.config.endpoint) {
      throw new Error('HTTP API endpoint is required');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // 添加认证头
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await this.fetchWithTimeout(this.config.endpoint, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP API returned ${response.status}`);
    }

    const data = await response.json() as unknown;
    
    // 支持两种响应格式
    if (Array.isArray(data)) {
      return data.filter((item): item is string => typeof item === 'string');
    }
    
    if (data && typeof data === 'object' && 'uuids' in data && Array.isArray((data as { uuids: unknown[] }).uuids)) {
      return (data as { uuids: unknown[] }).uuids.filter((item): item is string => typeof item === 'string');
    }

    throw new Error('Invalid API response format');
  }
}
