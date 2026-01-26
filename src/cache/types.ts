/**
 * 缓存类型定义
 */

/**
 * UUID 缓存数据结构
 */
export interface UUIDCacheData {
  /** UUID 列表 */
  uuids: string[];
  /** 缓存创建时间戳 */
  cachedAt: number;
  /** 提供者名称 */
  provider: string;
  /** 过期时间戳 */
  expiresAt: number;
}

/**
 * 合并 UUID 缓存数据
 */
export interface MergedUUIDCache {
  /** UUID 到提供者的映射 */
  uuidMap: Record<string, string>;
  /** 缓存创建时间戳 */
  cachedAt: number;
  /** 过期时间戳 */
  expiresAt: number;
}

/**
 * 缓存存储接口
 */
export interface CacheStore {
  /** 存储名称 */
  readonly name: string;

  /** 获取缓存的 UUID 列表 */
  getCachedUUIDs(provider: string): Promise<UUIDCacheData | null>;

  /** 设置 UUID 缓存 */
  setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void>;

  /** 删除 UUID 缓存 */
  deleteCachedUUIDs(provider: string): Promise<boolean>;

  /** 获取合并后的 UUID 缓存 */
  getMergedUUIDCache(): Promise<MergedUUIDCache | null>;

  /** 设置合并后的 UUID 缓存 */
  setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void>;

  /** 删除合并后的 UUID 缓存 */
  deleteMergedUUIDCache(): Promise<boolean>;

  /** 检查缓存后端是否可用 */
  isAvailable(): boolean;
}

/**
 * 默认缓存时间（秒）
 */
export const DEFAULT_CACHE_TTL = 300; // 5 分钟

/**
 * 二级缓存写入间隔（毫秒）
 * 避免频繁写入 KV/D1
 */
export const L2_WRITE_INTERVAL = 60000; // 1 分钟
