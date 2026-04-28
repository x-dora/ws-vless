/**
 * KV 缓存实现（二级缓存）
 *
 * Cloudflare Workers KV 存储
 * 需要绑定 UUID_KV 命名空间
 */

import { cacheLogger } from '../utils/logger';
import { isSubrequestBudgetExceededError, type SubrequestBudget } from '../utils/subrequest-budget';
import type { CacheStore, MergedUUIDCache, UUIDCacheData } from './types';

/**
 * KV 缓存存储实现
 */
export class KVStore implements CacheStore {
  readonly name = 'KV';
  private kv: KVNamespace;
  private readonly budget?: SubrequestBudget;

  constructor(kv: KVNamespace, budget?: SubrequestBudget) {
    this.kv = kv;
    this.budget = budget;
  }

  isAvailable(): boolean {
    return this.kv !== undefined && this.kv !== null;
  }

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      this.budget?.consume(1, `KV.get ${provider}`);
      const data = await this.kv.get<UUIDCacheData>(`uuids:${provider}`, 'json');
      if (!data) {
        return null;
      }

      // 检查过期（KV 有自己的 TTL，但也检查一下）
      if (data.expiresAt && Date.now() > data.expiresAt) {
        return null;
      }

      return data;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[KV] Get UUIDs error (${provider}):`, error);
      return null;
    }
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      this.budget?.consume(1, `KV.put ${provider}`);
      const now = Date.now();
      const data: UUIDCacheData = {
        uuids,
        cachedAt: now,
        provider,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.kv.put(`uuids:${provider}`, JSON.stringify(data), {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[KV] Set UUIDs error (${provider}):`, error);
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      this.budget?.consume(1, `KV.delete ${provider}`);
      await this.kv.delete(`uuids:${provider}`);
      return true;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[KV] Delete UUIDs error (${provider}):`, error);
      return false;
    }
  }

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      this.budget?.consume(1, 'KV.get merged');
      const data = await this.kv.get<MergedUUIDCache>('uuids:merged', 'json');
      if (!data) {
        return null;
      }

      if (data.expiresAt && Date.now() > data.expiresAt) {
        return null;
      }

      return data;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[KV] Get merged cache error:', error);
      return null;
    }
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      this.budget?.consume(1, 'KV.put merged');
      const now = Date.now();
      const data: MergedUUIDCache = {
        uuidMap,
        cachedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.kv.put('uuids:merged', JSON.stringify(data), {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[KV] Set merged cache error:', error);
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      this.budget?.consume(1, 'KV.delete merged');
      await this.kv.delete('uuids:merged');
      return true;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[KV] Delete merged cache error:', error);
      return false;
    }
  }
}
