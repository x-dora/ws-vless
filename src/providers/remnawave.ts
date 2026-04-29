/**
 * Remnawave API UUID 提供者
 *
 * 这里只负责从 Remnawave 面板拉取用户 UUID，不再持有 provider 级缓存。
 * 缓存统一交给上层 manager / cache store。
 */

import { createLogger } from '../utils/logger';
import type { SubrequestBudget } from '../utils/subrequest-budget';
import { isValidUUID } from '../utils/uuid';
import { BaseUUIDProvider } from './base';

const log = createLogger('Remnawave');

interface RemnawaveUser {
  vlessUuid: string;
  username?: string;
  status?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

interface RemnawaveApiResponse {
  response?: {
    users?: RemnawaveUser[];
    total?: number;
  };
  users?: RemnawaveUser[];
  data?: RemnawaveUser[];
  total?: number;
  error?: string;
  message?: string;
}

export interface RemnawaveProviderConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
  enabledOnly?: boolean;
  budget?: SubrequestBudget;
}

export class RemnawaveUUIDProvider extends BaseUUIDProvider {
  public readonly name = 'remnawave';

  constructor(
    private readonly _config: RemnawaveProviderConfig,
    priority = 20,
  ) {
    super(
      {
        enabled: true,
        timeout: _config.timeout,
        budget: _config.budget,
      },
      priority,
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: API schema is inconsistent and requires explicit fallback branches
  protected async doFetchUUIDs(): Promise<string[]> {
    const { apiUrl, apiKey, timeout = 10000, enabledOnly = true } = this._config;
    const url = new URL('/api/users', apiUrl);
    url.searchParams.set('size', '1000');

    try {
      const response = await this.fetchWithTimeout(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as RemnawaveApiResponse;
      const users = this.parseUsers(data);

      const uuids: string[] = [];
      for (const user of users) {
        if (!user.vlessUuid || !isValidUUID(user.vlessUuid)) {
          continue;
        }
        if (enabledOnly && user.enabled === false) {
          continue;
        }
        if (user.status && user.status.toLowerCase() === 'disabled') {
          continue;
        }

        uuids.push(user.vlessUuid.toLowerCase());
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
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this._config.apiUrl && this._config.apiKey) && (await super.isAvailable());
  }

  private parseUsers(data: RemnawaveApiResponse | RemnawaveUser[]): RemnawaveUser[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (data.response?.users && Array.isArray(data.response.users)) {
      return data.response.users;
    }

    if (data.users && Array.isArray(data.users)) {
      return data.users;
    }

    if (data.data && Array.isArray(data.data)) {
      return data.data;
    }

    if (data.error || data.message) {
      throw new Error(data.error || data.message);
    }

    log.warn('Unknown response format:', Object.keys(data));
    return [];
  }
}

export function createRemnawaveProvider(
  apiUrl: string | undefined,
  apiKey: string | undefined,
  options?: {
    priority?: number;
    timeout?: number;
    budget?: SubrequestBudget;
    enabledOnly?: boolean;
  },
): RemnawaveUUIDProvider | null {
  if (!apiUrl || !apiKey) {
    log.debug('Skipped: API URL or Key not configured');
    return null;
  }

  try {
    new URL(apiUrl);
  } catch {
    log.error('Invalid API URL:', apiUrl);
    return null;
  }

  return new RemnawaveUUIDProvider(
    {
      apiUrl,
      apiKey,
      timeout: options?.timeout,
      enabledOnly: options?.enabledOnly,
      budget: options?.budget,
    },
    options?.priority ?? 20,
  );
}
