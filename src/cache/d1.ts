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

import { cacheLogger } from '../utils/logger';
import { isSubrequestBudgetExceededError, type SubrequestBudget } from '../utils/subrequest-budget';
import type { CacheStore, MergedUUIDCache, UUIDCacheData } from './types';

/**
 * D1 数据库缓存存储实现
 */
export class D1Store implements CacheStore {
  readonly name = 'D1';
  private db: D1Database;
  private initialized = false;
  private readonly budget?: SubrequestBudget;

  constructor(db: D1Database, budget?: SubrequestBudget) {
    this.db = db;
    this.budget = budget;
  }

  isAvailable(): boolean {
    return this.db !== undefined && this.db !== null;
  }

  /**
   * 确保表存在
   */
  private async ensureTable(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      this.budget?.consume(1, 'D1.exec ensureTable');
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
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      // 表可能已存在
      this.initialized = true;
    }
  }

  async getCachedUUIDs(provider: string): Promise<UUIDCacheData | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      await this.ensureTable();

      this.budget?.consume(1, `D1.first ${provider}`);
      const result = await this.db
        .prepare('SELECT value FROM uuid_cache WHERE key = ? AND expires_at > ?')
        .bind(`uuids:${provider}`, Date.now())
        .first<{ value: string }>();

      if (!result) {
        return null;
      }
      return JSON.parse(result.value) as UUIDCacheData;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[D1] Get UUIDs error (${provider}):`, error);
      return null;
    }
  }

  async setCachedUUIDs(provider: string, uuids: string[], ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.ensureTable();

      this.budget?.consume(1, `D1.run ${provider}`);
      const now = Date.now();
      const data: UUIDCacheData = {
        uuids,
        cachedAt: now,
        provider,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.db
        .prepare(`
        INSERT OR REPLACE INTO uuid_cache (key, value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `)
        .bind(`uuids:${provider}`, JSON.stringify(data), data.expiresAt, now)
        .run();
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[D1] Set UUIDs error (${provider}):`, error);
    }
  }

  async deleteCachedUUIDs(provider: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.ensureTable();
      this.budget?.consume(1, `D1.run delete ${provider}`);
      await this.db.prepare('DELETE FROM uuid_cache WHERE key = ?').bind(`uuids:${provider}`).run();
      return true;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error(`[D1] Delete UUIDs error (${provider}):`, error);
      return false;
    }
  }

  async getMergedUUIDCache(): Promise<MergedUUIDCache | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      await this.ensureTable();

      this.budget?.consume(1, 'D1.first merged');
      const result = await this.db
        .prepare('SELECT value FROM uuid_cache WHERE key = ? AND expires_at > ?')
        .bind('uuids:merged', Date.now())
        .first<{ value: string }>();

      if (!result) {
        return null;
      }
      return JSON.parse(result.value) as MergedUUIDCache;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[D1] Get merged cache error:', error);
      return null;
    }
  }

  async setMergedUUIDCache(uuidMap: Record<string, string>, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.ensureTable();

      this.budget?.consume(1, 'D1.run merged');
      const now = Date.now();
      const data: MergedUUIDCache = {
        uuidMap,
        cachedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      };

      await this.db
        .prepare(`
        INSERT OR REPLACE INTO uuid_cache (key, value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `)
        .bind('uuids:merged', JSON.stringify(data), data.expiresAt, now)
        .run();
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[D1] Set merged cache error:', error);
    }
  }

  async deleteMergedUUIDCache(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.ensureTable();
      this.budget?.consume(1, 'D1.run delete merged');
      await this.db.prepare('DELETE FROM uuid_cache WHERE key = ?').bind('uuids:merged').run();
      return true;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      cacheLogger.error('[D1] Delete merged cache error:', error);
      return false;
    }
  }

  /**
   * 清理过期数据（可以定期调用）
   */
  async cleanup(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.ensureTable();
      this.budget?.consume(1, 'D1.run cleanup');
      await this.db.prepare('DELETE FROM uuid_cache WHERE expires_at < ?').bind(Date.now()).run();
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      // 忽略清理错误
    }
  }
}
