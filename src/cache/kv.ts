/**
 * KV 缓存实现（二级缓存）
 * 
 * Cloudflare Workers KV 存储
 * 需要绑定 UUID_KV 命名空间
 */

import type { CacheStore, UUIDCacheData, MergedUUIDCache } from './types';
import { cacheLogger } from '../utils/logger';

/**
 * KV 缓存存储实现
 */
export class KVStore implements CacheStore {
  readonly name = 'KV';
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  isAvailable(): boolean {
    return this.kv !== undefined && this.kv !== null;
  }

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    try {
      const data = await this.kv.get<UUIDCacheData>(`uuids:${provider}`, 'json');
      if (!data) return null;

      // 检查过期（KV 有自己的 TTL，但也检查一下）
      if (data.expiresAt && Date.now() > data.expiresAt) {
        return null;
      }
      
      return data;
    } catch (error) {
      cacheLogger.error(`[KV] Get UUIDs error (${provider}):`, error);
      return null;
    }
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    try {
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
      cacheLogger.error(`[KV] Set UUIDs error (${provider}):`, error);
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    try {
      await this.kv.delete(`uuids:${provider}`);
      return true;
    } catch (error) {
      cacheLogger.error(`[KV] Delete UUIDs error (${provider}):`, error);
      return false;
    }
  }

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    try {
      const data = await this.kv.get<MergedUUIDCache>('uuids:merged', 'json');
      if (!data) return null;

      if (data.expiresAt && Date.now() > data.expiresAt) {
        return null;
      }
      
      return data;
    } catch (error) {
      cacheLogger.error('[KV] Get merged cache error:', error);
      return null;
    }
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    try {
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
      cacheLogger.error('[KV] Set merged cache error:', error);
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    try {
      await this.kv.delete('uuids:merged');
      return true;
    } catch (error) {
      cacheLogger.error('[KV] Delete merged cache error:', error);
      return false;
    }
  }
}
