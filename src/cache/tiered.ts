/**
 * 分层缓存管理器
 * 
 * 缓存层级：
 * L1: Cache API（最快，边缘节点）
 * L2: KV 或 D1（持久化，KV 优先）
 * 
 * 读取策略：L1 → L2 → 原始请求
 * 写入策略：始终写 L1，L2 写入有间隔限制
 */

import type { CacheStore, UUIDCacheData, MergedUUIDCache } from './types';
import { L2_WRITE_INTERVAL } from './types';
import { CacheAPIStore } from './cache-api';
import { KVStore } from './kv';
import { D1Store } from './d1';
import { createLogger } from '../utils/logger';

const log = createLogger('Cache');

/**
 * 分层缓存配置
 */
export interface TieredCacheOptions {
  /** KV 命名空间（可选） */
  kv?: KVNamespace;
  /** D1 数据库（可选） */
  d1?: D1Database;
  /** L2 写入间隔（毫秒），默认 60000 */
  l2WriteInterval?: number;
}

/**
 * 分层缓存管理器
 */
export class TieredCache implements CacheStore {
  readonly name = 'Tiered';
  
  /** L1 缓存（Cache API） */
  private l1: CacheAPIStore;
  
  /** L2 缓存（KV 或 D1，可选） */
  private l2: CacheStore | null = null;
  
  /** L2 上次写入时间 */
  private l2LastWrite: Map<string, number> = new Map();
  
  /** L2 写入间隔 */
  private l2WriteInterval: number;

  constructor(options: TieredCacheOptions = {}) {
    // L1 始终使用 Cache API
    this.l1 = new CacheAPIStore();
    
    // L2 优先使用 KV，其次 D1
    if (options.kv) {
      const kvStore = new KVStore(options.kv);
      if (kvStore.isAvailable()) {
        this.l2 = kvStore;
        log.info('L2=KV');
      }
    }
    
    if (!this.l2 && options.d1) {
      const d1Store = new D1Store(options.d1);
      if (d1Store.isAvailable()) {
        this.l2 = d1Store;
        log.info('L2=D1');
      }
    }
    
    if (!this.l2) {
      log.debug('L2 disabled');
    }
    
    this.l2WriteInterval = options.l2WriteInterval ?? L2_WRITE_INTERVAL;
  }

  isAvailable(): boolean {
    return this.l1.isAvailable();
  }

  /**
   * 检查是否应该写入 L2
   */
  private shouldWriteL2(key: string): boolean {
    if (!this.l2) return false;
    
    const lastWrite = this.l2LastWrite.get(key) || 0;
    return Date.now() - lastWrite >= this.l2WriteInterval;
  }

  /**
   * 标记 L2 已写入
   */
  private markL2Written(key: string): void {
    this.l2LastWrite.set(key, Date.now());
  }

  // ==========================================================================
  // UUID 缓存
  // ==========================================================================

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    const key = `uuids:${provider}`;
    
    // 1. 先查 L1
    const l1Data = await this.l1.getCachedUUIDs(provider);
    if (l1Data) {
      log.cacheHit('L1', `${provider} (${l1Data.uuids.length})`);
      return l1Data;
    }
    log.cacheMiss('L1', provider);
    
    // 2. L1 未命中，查 L2
    if (this.l2) {
      const l2Data = await this.l2.getCachedUUIDs(provider);
      if (l2Data) {
        log.cacheHit('L2', `${provider} (${l2Data.uuids.length})`);
        // 回填 L1
        const remainingTTL = Math.floor((l2Data.expiresAt - Date.now()) / 1000);
        if (remainingTTL > 0) {
          await this.l1.setCachedUUIDs(provider, l2Data.uuids, remainingTTL);
          log.debug('L1 backfill:', provider);
        }
        return l2Data;
      }
      log.cacheMiss('L2', provider);
    }
    
    // 3. 全部未命中
    return null;
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    const key = `uuids:${provider}`;
    
    // 始终写入 L1
    await this.l1.setCachedUUIDs(provider, uuids, ttlSeconds);
    log.cacheWrite('L1', `${provider} (${uuids.length})`);
    
    // 有间隔地写入 L2
    if (this.shouldWriteL2(key)) {
      if (this.l2) {
        await this.l2.setCachedUUIDs(provider, uuids, ttlSeconds);
        this.markL2Written(key);
        log.cacheWrite('L2', `${provider} (${uuids.length})`);
      }
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    const key = `uuids:${provider}`;
    
    // 删除 L1
    const l1Result = await this.l1.deleteCachedUUIDs(provider);
    
    // 删除 L2
    let l2Result = true;
    if (this.l2) {
      l2Result = await this.l2.deleteCachedUUIDs(provider);
      this.l2LastWrite.delete(key);
    }
    
    log.debug('delete:', provider);
    return l1Result || l2Result;
  }

  // ==========================================================================
  // 合并 UUID 缓存
  // ==========================================================================

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    // 1. 先查 L1
    const l1Data = await this.l1.getMergedUUIDCache();
    if (l1Data) {
      log.cacheHit('L1', `merged (${Object.keys(l1Data.uuidMap).length})`);
      return l1Data;
    }
    log.cacheMiss('L1', 'merged');
    
    // 2. L1 未命中，查 L2
    if (this.l2) {
      const l2Data = await this.l2.getMergedUUIDCache();
      if (l2Data) {
        log.cacheHit('L2', `merged (${Object.keys(l2Data.uuidMap).length})`);
        // 回填 L1
        const remainingTTL = Math.floor((l2Data.expiresAt - Date.now()) / 1000);
        if (remainingTTL > 0) {
          await this.l1.setMergedUUIDCache(l2Data.uuidMap, remainingTTL);
          log.debug('L1 backfill: merged');
        }
        return l2Data;
      }
      log.cacheMiss('L2', 'merged');
    }
    
    // 3. 全部未命中
    return null;
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    const key = 'uuids:merged';
    const count = Object.keys(uuidMap).length;
    
    // 始终写入 L1
    await this.l1.setMergedUUIDCache(uuidMap, ttlSeconds);
    log.cacheWrite('L1', `merged (${count})`);
    
    // 有间隔地写入 L2
    if (this.shouldWriteL2(key)) {
      if (this.l2) {
        await this.l2.setMergedUUIDCache(uuidMap, ttlSeconds);
        this.markL2Written(key);
        log.cacheWrite('L2', `merged (${count})`);
      }
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    const key = 'uuids:merged';
    
    // 删除 L1
    const l1Result = await this.l1.deleteMergedUUIDCache();
    
    // 删除 L2
    let l2Result = true;
    if (this.l2) {
      l2Result = await this.l2.deleteMergedUUIDCache();
      this.l2LastWrite.delete(key);
    }
    
    log.debug('delete: merged');
    return l1Result || l2Result;
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 强制写入 L2（忽略间隔限制）
   */
  async forceWriteL2(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    if (this.l2) {
      await this.l2.setCachedUUIDs(provider, uuids, ttlSeconds);
      this.markL2Written(`uuids:${provider}`);
    }
  }

  /**
   * 强制写入合并缓存到 L2
   */
  async forceWriteMergedL2(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    if (this.l2) {
      await this.l2.setMergedUUIDCache(uuidMap, ttlSeconds);
      this.markL2Written('uuids:merged');
    }
  }

  /**
   * 获取 L2 类型
   */
  get l2Type(): string {
    return this.l2?.name ?? 'None';
  }

  /**
   * 获取缓存信息
   */
  getInfo(): { l1: string; l2: string; l2WriteInterval: number } {
    return {
      l1: this.l1.name,
      l2: this.l2?.name ?? 'None',
      l2WriteInterval: this.l2WriteInterval,
    };
  }
}
