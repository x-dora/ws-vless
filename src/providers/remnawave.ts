/**
 * Remnawave API UUID 提供者
 * 
 * 从 Remnawave 面板 API 获取用户 UUID 列表
 * 文档: https://docs.rw/api#tag/users-controller/GET/api/users
 * 
 * 使用 Cache API 进行本地缓存，解决 Worker 无状态问题
 */

import type { UUIDProvider, UUIDProviderConfig } from '../types';
import { isValidUUID } from '../utils/uuid';
import { createLogger } from '../utils/logger';
import { 
  CacheAPIStore,
  DEFAULT_CACHE_CONFIG,
} from '../cache';

const log = createLogger('Remnawave');

// 使用 Cache API 作为提供者级别的缓存
const providerCache = new CacheAPIStore();

// ============================================================================
// Remnawave API 响应类型
// ============================================================================

/**
 * Remnawave 用户对象
 * 根据 API 文档定义
 */
interface RemnawaveUser {
  /** 用户 VLESS UUID（用于认证和流量统计） */
  vlessUuid: string;
  /** 用户名 */
  username?: string;
  /** 用户状态 */
  status?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 其他字段 */
  [key: string]: unknown;
}

/**
 * Remnawave API 响应
 * 支持多种格式：
 * - { response: { users: [...] } }
 * - { users: [...] }
 * - { data: [...] }
 * - [...]
 */
interface RemnawaveApiResponse {
  /** 嵌套响应格式 */
  response?: {
    users?: RemnawaveUser[];
    total?: number;
  };
  /** 用户列表 */
  users?: RemnawaveUser[];
  /** 或者直接返回数组 */
  data?: RemnawaveUser[];
  /** 分页信息 */
  total?: number;
  /** 错误信息 */
  error?: string;
  message?: string;
}

// ============================================================================
// Remnawave UUID 提供者配置
// ============================================================================

/**
 * Remnawave 提供者配置
 */
export interface RemnawaveProviderConfig {
  /** API 基础地址 (如: https://panel.example.com) */
  apiUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 请求超时时间（毫秒），默认 10000 */
  timeout?: number;
  /** 缓存时间（秒），默认 300 */
  cacheTTL?: number;
  /** 是否只获取启用的用户，默认 true */
  enabledOnly?: boolean;
}

// ============================================================================
// Remnawave UUID 提供者
// ============================================================================

/**
 * Remnawave UUID 提供者
 * 从 Remnawave 面板获取有效用户的 UUID
 */
export class RemnawaveUUIDProvider implements UUIDProvider {
  public readonly name = 'remnawave';
  public readonly priority: number;
  
  private readonly config: RemnawaveProviderConfig;
  private readonly cacheTTL: number;

  constructor(config: RemnawaveProviderConfig, priority = 20) {
    this.config = config;
    this.priority = priority;
    this.cacheTTL = config.cacheTTL ?? DEFAULT_CACHE_CONFIG.uuidCacheTTL;
  }

  /**
   * 获取可用的 UUID 列表
   * 优先从缓存获取，缓存未命中时从 API 获取
   */
  async fetchUUIDs(): Promise<string[]> {
    // 1. 尝试从缓存获取
    const cached = await providerCache.getCachedUUIDs(this.name);
    if (cached) {
      log.debug(`Cache hit: ${cached.uuids.length} UUIDs`);
      return cached.uuids;
    }

    // 2. 缓存未命中，从 API 获取
    log.debug('Cache miss, fetching from API...');
    const uuids = await this.fetchFromApi();

    // 3. 存入缓存
    if (uuids.length > 0) {
      await providerCache.setCachedUUIDs(this.name, uuids, this.cacheTTL);
    }

    return uuids;
  }

  /**
   * 从 Remnawave API 获取用户列表
   */
  private async fetchFromApi(): Promise<string[]> {
    const { apiUrl, apiKey, timeout = 10000, enabledOnly = true } = this.config;

    // 构建 API URL
    const url = new URL('/api/users', apiUrl);
    
    // 创建带超时的请求
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as RemnawaveApiResponse;

      // 解析响应，支持多种格式
      const users = this.parseUsers(data);

      // 过滤并提取 UUID（使用 vlessUuid 字段）
      const uuids: string[] = [];
      
      for (const user of users) {
        // 验证 vlessUuid 格式
        if (!user.vlessUuid || !isValidUUID(user.vlessUuid)) {
          continue;
        }
        // 如果只获取启用的用户
        if (enabledOnly && user.enabled === false) {
          continue;
        }
        // 检查状态（如果有）
        if (user.status && user.status.toLowerCase() === 'disabled') {
          continue;
        }
        
        const normalizedUuid = user.vlessUuid.toLowerCase();
        uuids.push(normalizedUuid);
      }

      log.info(`Fetched ${uuids.length} UUIDs from API`);
      return uuids;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.error(`Request timeout after ${timeout}ms`);
      } else {
        log.error('API request failed:', error);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 解析 API 响应中的用户数据
   * 支持多种响应格式
   */
  private parseUsers(data: RemnawaveApiResponse | RemnawaveUser[]): RemnawaveUser[] {
    // 直接返回数组
    if (Array.isArray(data)) {
      return data;
    }

    // { response: { users: [...] } } 格式（Remnawave 标准格式）
    if (data.response && data.response.users && Array.isArray(data.response.users)) {
      return data.response.users;
    }

    // { users: [...] } 格式
    if (data.users && Array.isArray(data.users)) {
      return data.users;
    }

    // { data: [...] } 格式
    if (data.data && Array.isArray(data.data)) {
      return data.data;
    }

    // 如果响应包含错误
    if (data.error || data.message) {
      throw new Error(data.error || data.message);
    }

    log.warn('Unknown response format:', Object.keys(data));
    return [];
  }

  /**
   * 验证提供者是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      // 检查配置
      if (!this.config.apiUrl || !this.config.apiKey) {
        return false;
      }

      // 尝试获取 UUID
      const uuids = await this.fetchUUIDs();
      return uuids.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 强制刷新缓存
   */
  async refresh(): Promise<string[]> {
    log.debug('Force refreshing...');
    // 先删除旧缓存
    await providerCache.deleteCachedUUIDs(this.name);
    // 重新获取
    const uuids = await this.fetchFromApi();
    if (uuids.length > 0) {
      await providerCache.setCachedUUIDs(this.name, uuids, this.cacheTTL);
    }
    return uuids;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Remnawave 提供者（如果配置有效）
 * @param apiUrl API 地址
 * @param apiKey API 密钥
 * @param options 额外选项
 * @returns 提供者实例，如果配置无效则返回 null
 */
export function createRemnawaveProvider(
  apiUrl: string | undefined,
  apiKey: string | undefined,
  options?: {
    priority?: number;
    cacheTTL?: number;
    timeout?: number;
  }
): RemnawaveUUIDProvider | null {
  // 如果地址或密钥为空，不创建提供者
  if (!apiUrl || !apiKey) {
    log.debug('Skipped: API URL or Key not configured');
    return null;
  }

  // 验证 URL 格式
  try {
    new URL(apiUrl);
  } catch {
    log.error('Invalid API URL:', apiUrl);
    return null;
  }

  return new RemnawaveUUIDProvider({
    apiUrl,
    apiKey,
    ...options,
  }, options?.priority ?? 20);
}
