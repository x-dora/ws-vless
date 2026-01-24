/**
 * 自定义 UUID 提供者示例
 * 
 * 本文件提供了如何创建自定义 UUID 提供者的示例
 * 用户可以根据自己的需求实现从不同平台获取 UUID 的逻辑
 */

import type { UUIDProviderConfig } from '../types';
import { BaseUUIDProvider } from './base';

// ============================================================================
// 示例 1: 从 KV 存储获取 UUID
// ============================================================================

/**
 * Cloudflare KV UUID 提供者
 * 从 Cloudflare KV 命名空间获取 UUID 列表
 * 
 * 使用方法:
 * 1. 在 wrangler.jsonc 中配置 KV 命名空间绑定
 * 2. 在 Worker 中传入 KV 绑定
 */
export class KVUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'cloudflare-kv';
  private readonly kvNamespace: KVNamespace;
  private readonly kvKey: string;

  constructor(
    kvNamespace: KVNamespace,
    kvKey: string = 'valid_uuids',
    priority = 10
  ) {
    super({ enabled: true }, priority);
    this.kvNamespace = kvNamespace;
    this.kvKey = kvKey;
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    const data = await this.kvNamespace.get(this.kvKey, 'json');
    
    if (Array.isArray(data)) {
      return data.filter((item): item is string => typeof item === 'string');
    }
    
    return [];
  }
}

// ============================================================================
// 示例 2: 从 D1 数据库获取 UUID
// ============================================================================

/**
 * Cloudflare D1 UUID 提供者
 * 从 Cloudflare D1 数据库获取 UUID 列表
 * 
 * 使用方法:
 * 1. 创建 D1 数据库并添加 users 表
 * 2. 在 wrangler.jsonc 中配置 D1 绑定
 */
export class D1UUIDProvider extends BaseUUIDProvider {
  public readonly name = 'cloudflare-d1';
  private readonly db: D1Database;
  private readonly tableName: string;
  private readonly uuidColumn: string;

  constructor(
    db: D1Database,
    options: {
      tableName?: string;
      uuidColumn?: string;
      priority?: number;
    } = {}
  ) {
    super({ enabled: true }, options.priority ?? 15);
    this.db = db;
    this.tableName = options.tableName ?? 'users';
    this.uuidColumn = options.uuidColumn ?? 'uuid';
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    const query = `SELECT ${this.uuidColumn} FROM ${this.tableName} WHERE active = 1`;
    const result = await this.db.prepare(query).all();
    
    return result.results
      .map((row) => (row as Record<string, unknown>)[this.uuidColumn])
      .filter((uuid): uuid is string => typeof uuid === 'string');
  }
}

// ============================================================================
// 示例 3: 从 Telegram Bot API 获取 UUID
// ============================================================================

/**
 * Telegram Bot UUID 提供者
 * 通过 Telegram Bot API 获取授权用户的 UUID
 * 
 * 使用方法:
 * 1. 创建 Telegram Bot 并获取 Token
 * 2. 实现自己的后端 API 来管理用户授权
 */
export class TelegramUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'telegram-bot';

  constructor(config: UUIDProviderConfig, priority = 30) {
    super(config, priority);
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    if (!this.config.endpoint) {
      throw new Error('Telegram API endpoint is required');
    }

    const response = await this.fetchWithTimeout(this.config.endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bot ${this.config.authToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Telegram API returned ${response.status}`);
    }

    const data = await response.json() as { users?: { uuid: string }[] };
    return data.users?.map((u) => u.uuid) ?? [];
  }
}

// ============================================================================
// 示例 4: 从 GitHub Gist 获取 UUID
// ============================================================================

/**
 * GitHub Gist UUID 提供者
 * 从 GitHub Gist 获取 UUID 列表
 * 
 * Gist 内容格式（每行一个 UUID）:
 * ```
 * uuid-1
 * uuid-2
 * uuid-3
 * ```
 */
export class GistUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'github-gist';
  private readonly gistRawUrl: string;

  constructor(gistRawUrl: string, priority = 40) {
    super({ enabled: true }, priority);
    this.gistRawUrl = gistRawUrl;
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    const response = await fetch(this.gistRawUrl);

    if (!response.ok) {
      throw new Error(`GitHub Gist returned ${response.status}`);
    }

    const text = await response.text();
    
    // 解析每行作为一个 UUID
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
}

// ============================================================================
// 示例 5: 带过期时间的 UUID 提供者
// ============================================================================

/**
 * 带过期时间的 UUID 提供者
 * 支持 UUID 有效期管理
 */
export interface TimedUUID {
  uuid: string;
  expiresAt: string; // ISO 8601 格式
}

export class TimedUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'timed-uuids';

  constructor(config: UUIDProviderConfig, priority = 25) {
    super(config, priority);
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    if (!this.config.endpoint) {
      throw new Error('API endpoint is required');
    }

    const response = await this.fetchWithTimeout(this.config.endpoint);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json() as { uuids: TimedUUID[] };
    const now = new Date();

    // 过滤掉已过期的 UUID
    return data.uuids
      .filter((item) => new Date(item.expiresAt) > now)
      .map((item) => item.uuid);
  }
}

// ============================================================================
// 使用说明
// ============================================================================

/**
 * 如何使用自定义提供者:
 * 
 * 1. 在 src/index.ts 的 initializeUUIDManager 函数中注册提供者:
 * 
 * ```typescript
 * import { KVUUIDProvider, GistUUIDProvider } from './providers/example-custom';
 * 
 * function initializeUUIDManager(defaultUUID: string, env: WorkerEnv): UUIDProviderManager {
 *   const manager = createUUIDManager(defaultUUID);
 * 
 *   // 注册 KV 提供者（需要在 env 中有 KV 绑定）
 *   if (env.UUID_KV) {
 *     manager.register(new KVUUIDProvider(env.UUID_KV));
 *   }
 * 
 *   // 注册 Gist 提供者
 *   manager.register(new GistUUIDProvider(
 *     'https://gist.githubusercontent.com/user/id/raw/uuids.txt'
 *   ));
 * 
 *   return manager;
 * }
 * ```
 * 
 * 2. 确保在 wrangler.jsonc 中配置必要的绑定（KV、D1 等）
 * 
 * 3. 优先级说明:
 *    - 数字越小优先级越高
 *    - 相同 UUID 会保留高优先级提供者的归属
 *    - 建议优先级范围: 0-100
 */
