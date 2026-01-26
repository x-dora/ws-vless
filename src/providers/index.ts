/**
 * UUID 提供者管理模块
 * 管理多个 UUID 提供者，按优先级获取可用 UUID
 * 
 * 分层缓存架构：
 * - L1: Cache API（边缘节点）
 * - L2: KV 或 D1（持久化，可选）
 */

import type { UUIDProvider, UUIDValidationResult } from '../types';
import { isValidUUID } from '../utils/uuid';
import { createLogger } from '../utils/logger';
import { 
  type CacheStore,
  createCacheStore,
  DEFAULT_CACHE_CONFIG,
} from '../cache';
import { BaseUUIDProvider, StaticUUIDProvider, HttpApiUUIDProvider } from './base';

const log = createLogger('UUID');

// 导出基类和内置提供者
export { BaseUUIDProvider, StaticUUIDProvider, HttpApiUUIDProvider };

// 导出 Remnawave 提供者
export { RemnawaveUUIDProvider, createRemnawaveProvider } from './remnawave';

// ============================================================================
// 提供者管理器配置
// ============================================================================

/**
 * UUID 管理器配置选项
 */
export interface UUIDManagerOptions {
  /** 缓存 TTL（秒） */
  cacheTTL?: number;
  /** KV 命名空间（可选，作为二级缓存） */
  kv?: KVNamespace;
  /** D1 数据库（可选，作为二级缓存，KV 优先） */
  d1?: D1Database;
}

// ============================================================================
// 提供者管理器
// ============================================================================

/**
 * UUID 提供者管理器
 * 统一管理多个 UUID 来源，支持优先级排序和多种缓存后端
 */
export class UUIDProviderManager {
  /** 已注册的提供者列表 */
  private providers: UUIDProvider[] = [];
  
  /** 缓存 TTL（秒） */
  private cacheTTL: number;

  /** 缓存存储 */
  private cacheStore: CacheStore;

  constructor(options: UUIDManagerOptions = {}) {
    this.cacheTTL = options.cacheTTL ?? DEFAULT_CACHE_CONFIG.uuidCacheTTL;
    this.cacheStore = createCacheStore({
      kv: options.kv,
      d1: options.d1,
    });
  }

  /**
   * 注册 UUID 提供者
   * @param provider UUID 提供者实例
   */
  register(provider: UUIDProvider): void {
    this.providers.push(provider);
    // 按优先级排序（数字越小优先级越高）
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 批量注册提供者
   * @param providers 提供者数组
   */
  registerAll(providers: UUIDProvider[]): void {
    providers.forEach((p) => this.register(p));
  }

  /**
   * 移除指定名称的提供者
   * @param name 提供者名称
   */
  unregister(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name);
  }

  /**
   * 从缓存或提供者获取所有 UUID
   * 支持多种缓存后端
   * @param forceRefresh 是否强制刷新缓存
   * @returns UUID 数组
   */
  async getAllUUIDs(forceRefresh = false): Promise<string[]> {
    // 1. 如果不强制刷新，尝试从缓存获取
    if (!forceRefresh) {
      const cached = await this.cacheStore.getMergedUUIDCache();
      if (cached) {
        // 日志由 cacheStore 输出
        return Object.keys(cached.uuidMap);
      }
    }

    // 2. 缓存未命中或强制刷新，从提供者获取
    log.info('Fetching from providers...');
    const uuidMap = await this.fetchFromProviders();

    // 3. 存入缓存
    if (Object.keys(uuidMap).length > 0) {
      await this.cacheStore.setMergedUUIDCache(uuidMap, this.cacheTTL);
    }

    return Object.keys(uuidMap);
  }

  /**
   * 从所有提供者获取 UUID 并合并
   */
  private async fetchFromProviders(): Promise<Record<string, string>> {
    const uuidMap: Record<string, string> = {};

    // 并行获取所有提供者的 UUID
    const results = await Promise.allSettled(
      this.providers.map(async (provider) => {
        try {
          const uuids = await provider.fetchUUIDs();
          return { provider: provider.name, uuids };
        } catch (error) {
          log.error(`${provider.name} fetch failed:`, error);
          return { provider: provider.name, uuids: [] };
        }
      })
    );

    // 合并结果（按优先级顺序，先注册的优先）
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { provider, uuids } = result.value;
        for (const uuid of uuids) {
          const normalizedUUID = uuid.toLowerCase();
          // 只添加不存在的 UUID（保持高优先级提供者的归属）
          if (!uuidMap[normalizedUUID]) {
            uuidMap[normalizedUUID] = provider;
          }
        }
      }
    }

    log.info(`Fetched ${Object.keys(uuidMap).length} UUIDs from ${this.providers.length} providers`);
    return uuidMap;
  }

  /**
   * 强制刷新缓存
   */
  async refresh(): Promise<void> {
    log.info('Force refreshing...');
    // 删除旧缓存
    await this.cacheStore.deleteMergedUUIDCache();
    // 重新获取
    await this.getAllUUIDs(true);
  }

  /**
   * 验证 UUID 是否有效
   * @param uuid 待验证的 UUID
   * @param forceRefresh 是否强制刷新缓存
   * @returns 验证结果
   */
  async validateUUID(uuid: string, forceRefresh = false): Promise<UUIDValidationResult> {
    // 首先验证格式
    if (!isValidUUID(uuid)) {
      return { isValid: false };
    }

    const normalizedUUID = uuid.toLowerCase();

    // 尝试从缓存获取
    if (!forceRefresh) {
      const cached = await this.cacheStore.getMergedUUIDCache();
      if (cached && cached.uuidMap[normalizedUUID]) {
        return { isValid: true, provider: cached.uuidMap[normalizedUUID] };
      }
    }

    // 刷新缓存并重新验证
    await this.getAllUUIDs(forceRefresh);
    const cached = await this.cacheStore.getMergedUUIDCache();
    
    if (cached && cached.uuidMap[normalizedUUID]) {
      return { isValid: true, provider: cached.uuidMap[normalizedUUID] };
    }

    return { isValid: false };
  }

  /**
   * 获取已注册的提供者列表
   */
  getProviders(): readonly UUIDProvider[] {
    return this.providers;
  }

  /**
   * 获取提供者统计信息
   */
  async getStats(): Promise<{
    totalProviders: number;
    totalUUIDs: number;
    cacheStatus: 'hit' | 'miss';
    cacheType: string;
    providerDetails: { name: string; priority: number; available: boolean; uuidCount: number }[];
  }> {
    // 检查缓存状态
    const cached = await this.cacheStore.getMergedUUIDCache();
    const cacheStatus = cached ? 'hit' : 'miss';
    const totalUUIDs = cached ? Object.keys(cached.uuidMap).length : 0;

    const providerDetails = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const available = await p.isAvailable();
          const uuids = available ? await p.fetchUUIDs() : [];
          return {
            name: p.name,
            priority: p.priority,
            available,
            uuidCount: uuids.length,
          };
        } catch {
          return {
            name: p.name,
            priority: p.priority,
            available: false,
            uuidCount: 0,
          };
        }
      })
    );

    return {
      totalProviders: this.providers.length,
      totalUUIDs,
      cacheStatus,
      cacheType: this.cacheStore.name,
      providerDetails,
    };
  }

  /**
   * 获取当前使用的缓存类型
   */
  getCacheType(): string {
    return this.cacheStore.name;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 UUID 提供者管理器
 * @param defaultUUID 默认 UUID（来自环境变量）
 * @param options 管理器选项（缓存配置等）
 * @returns 配置好的管理器实例
 */
export function createUUIDManager(
  defaultUUID?: string, 
  options?: UUIDManagerOptions | number
): UUIDProviderManager {
  // 兼容旧版 API：第二个参数可以是 cacheTTL 数字
  const opts: UUIDManagerOptions = typeof options === 'number' 
    ? { cacheTTL: options } 
    : (options ?? {});

  const manager = new UUIDProviderManager(opts);

  // 如果有默认 UUID，注册静态提供者（最高优先级）
  if (defaultUUID && isValidUUID(defaultUUID)) {
    manager.register(new StaticUUIDProvider([defaultUUID], 0));
  }

  return manager;
}
