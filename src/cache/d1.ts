/**
 * D1 缓存实现（二级缓存）
 * 
 * Cloudflare D1 SQLite 数据库
 * 需要绑定 UUID_D1 数据库
 * 
 * 初始化 SQL:
 * ```sql
 * CREATE TABLE IF NOT EXISTS uuid_cache (
 *   key TEXT PRIMARY KEY,
 *   value TEXT NOT NULL,
 *   expires_at INTEGER NOT NULL,
 *   created_at INTEGER NOT NULL
 * );
 * CREATE INDEX IF NOT EXISTS idx_expires_at ON uuid_cache(expires_at);
 * ```
 */

import type { CacheStore, UUIDCacheData, MergedUUIDCache } from './types';

/**
 * D1 数据库缓存存储实现
 */
export class D1Store implements CacheStore {
  readonly name = 'D1';
  private db: D1Database;
  private initialized = false;

  constructor(db: D1Database) {
    this.db = db;
  }

  isAvailable(): boolean {
    return this.db !== undefined && this.db !== null;
  }

  /**
   * 确保表存在
   */
  private async ensureTable(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS uuid_cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_expires_at ON uuid_cache(expires_at);
      `);
      this.initialized = true;
    } catch {
      // 表可能已存在
      this.initialized = true;
    }
  }

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    try {
      await this.ensureTable();
      
      const result = await this.db.prepare(
        'SELECT value FROM uuid_cache WHERE key = ? AND expires_at > ?'
      ).bind(`uuids:${provider}`, Date.now()).first<{ value: string }>();

      if (!result) return null;
      return JSON.parse(result.value) as UUIDCacheData;
    } catch (error) {
      console.error(`[D1] Get UUIDs error (${provider}):`, error);
      return null;
    }
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    try {
      await this.ensureTable();
      
      const now = Date.now();
      const data: UUIDCacheData = {
        uuids,
        cachedAt: now,
        provider,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.db.prepare(`
        INSERT OR REPLACE INTO uuid_cache (key, value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        `uuids:${provider}`,
        JSON.stringify(data),
        data.expiresAt,
        now
      ).run();
    } catch (error) {
      console.error(`[D1] Set UUIDs error (${provider}):`, error);
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    try {
      await this.ensureTable();
      await this.db.prepare('DELETE FROM uuid_cache WHERE key = ?')
        .bind(`uuids:${provider}`)
        .run();
      return true;
    } catch (error) {
      console.error(`[D1] Delete UUIDs error (${provider}):`, error);
      return false;
    }
  }

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    try {
      await this.ensureTable();
      
      const result = await this.db.prepare(
        'SELECT value FROM uuid_cache WHERE key = ? AND expires_at > ?'
      ).bind('uuids:merged', Date.now()).first<{ value: string }>();

      if (!result) return null;
      return JSON.parse(result.value) as MergedUUIDCache;
    } catch (error) {
      console.error('[D1] Get merged cache error:', error);
      return null;
    }
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    try {
      await this.ensureTable();
      
      const now = Date.now();
      const data: MergedUUIDCache = {
        uuidMap,
        cachedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.db.prepare(`
        INSERT OR REPLACE INTO uuid_cache (key, value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        'uuids:merged',
        JSON.stringify(data),
        data.expiresAt,
        now
      ).run();
    } catch (error) {
      console.error('[D1] Set merged cache error:', error);
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    try {
      await this.ensureTable();
      await this.db.prepare('DELETE FROM uuid_cache WHERE key = ?')
        .bind('uuids:merged')
        .run();
      return true;
    } catch (error) {
      console.error('[D1] Delete merged cache error:', error);
      return false;
    }
  }

  /**
   * 清理过期数据（可以定期调用）
   */
  async cleanup(): Promise<void> {
    try {
      await this.ensureTable();
      await this.db.prepare('DELETE FROM uuid_cache WHERE expires_at < ?')
        .bind(Date.now())
        .run();
    } catch {
      // 忽略清理错误
    }
  }
}
