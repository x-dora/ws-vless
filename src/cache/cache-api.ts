/**
 * Cache API 缓存实现（一级缓存）
 * 
 * Cloudflare Workers 内置的 Cache API
 * 用作最快的一级缓存层
 */

import type { CacheStore, UUIDCacheData, MergedUUIDCache } from './types';
import { cacheLogger } from '../utils/logger';

/**
 * 缓存键前缀
 */
const CACHE_KEY_PREFIX = 'https://tunnel-worker-cache.internal/';

/**
 * 生成缓存键 URL
 */
function getCacheKey(key: string): string {
  return `${CACHE_KEY_PREFIX}${encodeURIComponent(key)}`;
}

/**
 * Cache API 缓存存储实现
 */
export class CacheAPIStore implements CacheStore {
  readonly name = 'CacheAPI';

  isAvailable(): boolean {
    return typeof caches !== 'undefined' && caches.default !== undefined;
  }

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    try {
      const cache = caches.default;
      const request = new Request(getCacheKey(`uuids:${provider}`));
      const response = await cache.match(request);
      
      if (!response) return null;

      const data = await response.json() as UUIDCacheData;
      
      // 检查是否过期
      if (data.expiresAt && Date.now() > data.expiresAt) {
        await this.deleteCachedUUIDs(provider);
        return null;
      }
      
      return data;
    } catch (error) {
      cacheLogger.error(`[CacheAPI] Get UUIDs error (${provider}):`, error);
      return null;
    }
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    try {
      const cache = caches.default;
      const request = new Request(getCacheKey(`uuids:${provider}`));
      const now = Date.now();

      const data: UUIDCacheData = {
        uuids,
        cachedAt: now,
        provider,
        expiresAt: now + ttlSeconds * 1000,
      };

      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttlSeconds}`,
        },
      });

      await cache.put(request, response);
    } catch (error) {
      cacheLogger.error(`[CacheAPI] Set UUIDs error (${provider}):`, error);
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    try {
      const cache = caches.default;
      return await cache.delete(new Request(getCacheKey(`uuids:${provider}`)));
    } catch (error) {
      cacheLogger.error(`[CacheAPI] Delete UUIDs error (${provider}):`, error);
      return false;
    }
  }

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    try {
      const cache = caches.default;
      const response = await cache.match(new Request(getCacheKey('uuids:merged')));
      
      if (!response) return null;

      const data = await response.json() as MergedUUIDCache;
      
      if (data.expiresAt && Date.now() > data.expiresAt) {
        await this.deleteMergedUUIDCache();
        return null;
      }
      
      return data;
    } catch (error) {
      cacheLogger.error('[CacheAPI] Get merged cache error:', error);
      return null;
    }
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    try {
      const cache = caches.default;
      const request = new Request(getCacheKey('uuids:merged'));
      const now = Date.now();

      const data: MergedUUIDCache = {
        uuidMap,
        cachedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      };

      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttlSeconds}`,
        },
      });

      await cache.put(request, response);
    } catch (error) {
      cacheLogger.error('[CacheAPI] Set merged cache error:', error);
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    try {
      const cache = caches.default;
      return await cache.delete(new Request(getCacheKey('uuids:merged')));
    } catch (error) {
      cacheLogger.error('[CacheAPI] Delete merged cache error:', error);
      return false;
    }
  }
}
