/**
 * UUID 提供者基类模块
 *
 * 这里保留公共的 fetch 超时与配置访问能力，不再承载 provider 级缓存。
 * 缓存策略交给上层 manager / cache store 统一管理。
 */

import type { UUIDProvider, UUIDProviderConfig } from '../types';
import { providerLogger } from '../utils/logger';
import { fetchWithBudget } from '../utils/subrequest-budget';

export abstract class BaseUUIDProvider implements UUIDProvider {
  public abstract readonly name: string;
  public readonly priority: number;
  protected readonly config: UUIDProviderConfig;

  constructor(config: UUIDProviderConfig, priority = 100) {
    this.config = config;
    this.priority = priority;
  }

  async fetchUUIDs(): Promise<string[]> {
    if (!this.config.enabled) {
      return [];
    }

    return await this.doFetchUUIDs();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const uuids = await this.fetchUUIDs();
      return uuids.length > 0;
    } catch (error) {
      providerLogger.error(`[${this.name}] availability check failed:`, error);
      return false;
    }
  }

  protected abstract doFetchUUIDs(): Promise<string[]>;

  protected async fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const timeout = this.config.timeout || 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetchWithBudget(
        this.config.budget,
        url,
        {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.config.headers,
            ...options.headers,
          },
        },
        `${this.name} fetch`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export class StaticUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'static';
  private readonly staticUUIDs: string[];

  constructor(uuids: string[], priority = 0) {
    super({ enabled: true }, priority);
    this.staticUUIDs = uuids;
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    return this.staticUUIDs;
  }

  async isAvailable(): Promise<boolean> {
    return this.staticUUIDs.length > 0;
  }
}

export class HttpApiUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'http-api';

  constructor(config: UUIDProviderConfig, priority = 50) {
    super(config, priority);
  }

  protected async doFetchUUIDs(): Promise<string[]> {
    if (!this.config.endpoint) {
      throw new Error('HTTP API endpoint is required');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }

    const response = await this.fetchWithTimeout(this.config.endpoint, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP API returned ${response.status}`);
    }

    const data = (await response.json()) as unknown;

    if (Array.isArray(data)) {
      return data.filter((item): item is string => typeof item === 'string');
    }

    if (
      data &&
      typeof data === 'object' &&
      'uuids' in data &&
      Array.isArray((data as { uuids: unknown[] }).uuids)
    ) {
      return (data as { uuids: unknown[] }).uuids.filter(
        (item): item is string => typeof item === 'string',
      );
    }

    throw new Error('Invalid API response format');
  }
}
