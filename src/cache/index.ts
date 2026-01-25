/**
 * Worker Cache API 缓存模块
 * 
 * Worker 是无状态的，全局变量在 isolate 重启后会丢失
 * 使用 Cloudflare Workers 的 Cache API 进行持久化缓存
 * 
 * Cache API 特点：
 * - 内置于 Workers，无需额外绑定
 * - 基于 HTTP 缓存语义
 * - 在边缘节点缓存数据
 * - 支持 TTL 控制
 */

// ============================================================================
// 缓存键生成
// ============================================================================

/**
 * 缓存键前缀
 */
const CACHE_KEY_PREFIX = 'https://tunnel-worker-cache.internal/';

/**
 * 生成缓存键 URL
 * Cache API 需要使用 URL 作为键
 * @param key 缓存键名
 * @returns 完整的缓存 URL
 */
function getCacheKey(key: string): string {
  return `${CACHE_KEY_PREFIX}${encodeURIComponent(key)}`;
}

// ============================================================================
// UUID 缓存操作
// ============================================================================

/**
 * UUID 缓存数据结构
 */
interface UUIDCacheData {
  /** UUID 列表 */
  uuids: string[];
  /** 缓存创建时间戳 */
  cachedAt: number;
  /** 提供者名称 */
  provider: string;
}

/**
 * 默认缓存时间（秒）
 */
const DEFAULT_CACHE_TTL = 300; // 5 分钟

/**
 * 从 Cache API 获取缓存的 UUID 列表
 * @param provider 提供者名称
 * @returns 缓存的 UUID 数据，如果不存在或过期则返回 null
 */
export async function getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(`uuids:${provider}`);
    const request = new Request(cacheKey);
    
    const response = await cache.match(request);
    if (!response) {
      return null;
    }

    const data = await response.json() as UUIDCacheData;
    return data;
  } catch (error) {
    console.error(`[Cache] Failed to get cached UUIDs for ${provider}:`, error);
    return null;
  }
}

/**
 * 将 UUID 列表缓存到 Cache API
 * @param provider 提供者名称
 * @param uuids UUID 列表
 * @param ttlSeconds 缓存时间（秒）
 */
export async function setCachedUUIDs(
  provider: string,
  uuids: string[],
  ttlSeconds: number = DEFAULT_CACHE_TTL
): Promise<void> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(`uuids:${provider}`);
    const request = new Request(cacheKey);

    const data: UUIDCacheData = {
      uuids,
      cachedAt: Date.now(),
      provider,
    };

    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${ttlSeconds}`,
      },
    });

    await cache.put(request, response);
    console.log(`[Cache] Cached ${uuids.length} UUIDs for ${provider}, TTL: ${ttlSeconds}s`);
  } catch (error) {
    console.error(`[Cache] Failed to cache UUIDs for ${provider}:`, error);
  }
}

/**
 * 删除指定提供者的 UUID 缓存
 * @param provider 提供者名称
 */
export async function deleteCachedUUIDs(provider: string): Promise<boolean> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(`uuids:${provider}`);
    const request = new Request(cacheKey);
    
    return await cache.delete(request);
  } catch (error) {
    console.error(`[Cache] Failed to delete cached UUIDs for ${provider}:`, error);
    return false;
  }
}

// ============================================================================
// 合并 UUID 缓存
// ============================================================================

/**
 * 合并后的 UUID 缓存键
 */
const MERGED_CACHE_KEY = 'uuids:merged';

/**
 * 合并 UUID 缓存数据
 */
interface MergedUUIDCache {
  /** UUID 到提供者的映射 */
  uuidMap: Record<string, string>;
  /** 缓存创建时间戳 */
  cachedAt: number;
}

/**
 * 获取合并后的 UUID 缓存
 */
export async function getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(MERGED_CACHE_KEY);
    const request = new Request(cacheKey);
    
    const response = await cache.match(request);
    if (!response) {
      return null;
    }

    return await response.json() as MergedUUIDCache;
  } catch (error) {
    console.error('[Cache] Failed to get merged UUID cache:', error);
    return null;
  }
}

/**
 * 设置合并后的 UUID 缓存
 * @param uuidMap UUID 到提供者的映射
 * @param ttlSeconds 缓存时间（秒）
 */
export async function setMergedUUIDCache(
  uuidMap: Record<string, string>,
  ttlSeconds: number = DEFAULT_CACHE_TTL
): Promise<void> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(MERGED_CACHE_KEY);
    const request = new Request(cacheKey);

    const data: MergedUUIDCache = {
      uuidMap,
      cachedAt: Date.now(),
    };

    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${ttlSeconds}`,
      },
    });

    await cache.put(request, response);
    console.log(`[Cache] Cached merged UUIDs: ${Object.keys(uuidMap).length} total`);
  } catch (error) {
    console.error('[Cache] Failed to set merged UUID cache:', error);
  }
}

/**
 * 删除合并后的 UUID 缓存
 */
export async function deleteMergedUUIDCache(): Promise<boolean> {
  try {
    const cache = caches.default;
    const cacheKey = getCacheKey(MERGED_CACHE_KEY);
    const request = new Request(cacheKey);
    
    return await cache.delete(request);
  } catch (error) {
    console.error('[Cache] Failed to delete merged UUID cache:', error);
    return false;
  }
}

// ============================================================================
// 缓存配置
// ============================================================================

/**
 * 缓存配置
 */
export interface CacheConfig {
  /** UUID 缓存 TTL（秒） */
  uuidCacheTTL: number;
}

/**
 * 默认缓存配置
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  uuidCacheTTL: DEFAULT_CACHE_TTL,
};
