/**
 * 缓存模块入口
 * 
 * 分层缓存架构：
 * - L1: Cache API（最快，边缘节点缓存）
 * - L2: KV 或 D1（持久化，KV 优先）
 * 
 * 读取顺序：L1 → L2 → 原始请求
 * 写入策略：始终写 L1，L2 有间隔限制避免频繁写入
 */

// 类型导出
export type { CacheStore, UUIDCacheData, MergedUUIDCache } from './types';
export { DEFAULT_CACHE_TTL, L2_WRITE_INTERVAL } from './types';

// 各缓存实现导出
export { CacheAPIStore } from './cache-api';
export { KVStore } from './kv';
export { D1Store } from './d1';

// 分层缓存导出
export { TieredCache, type TieredCacheOptions } from './tiered';

// ==========================================================================
// 工厂函数
// ==========================================================================

import type { CacheStore } from './types';
import { CacheAPIStore } from './cache-api';
import { TieredCache, type TieredCacheOptions } from './tiered';
import { createLogger } from '../utils/logger';

const log = createLogger('Cache');

/**
 * 创建缓存存储
 * 
 * @param options 配置选项，如果提供 KV 或 D1 则使用分层缓存
 * @returns 缓存存储实例
 */
export function createCacheStore(options?: TieredCacheOptions): CacheStore {
  // 如果没有配置 KV/D1，直接使用 Cache API
  if (!options?.kv && !options?.d1) {
    log.debug('L1 only (CacheAPI)');
    return new CacheAPIStore();
  }
  
  // 使用分层缓存
  return new TieredCache(options);
}

// ==========================================================================
// 缓存配置
// ==========================================================================

/**
 * 缓存配置
 */
export interface CacheConfig {
  /** UUID 缓存 TTL（秒） */
  uuidCacheTTL: number;
  /** 是否启用 L2 缓存 */
  l2Enabled: boolean;
  /** L2 类型 */
  l2Type: 'kv' | 'd1' | 'none';
}

/**
 * 默认缓存配置
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  uuidCacheTTL: 300,
  l2Enabled: false,
  l2Type: 'none',
};
