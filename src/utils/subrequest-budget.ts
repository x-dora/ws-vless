/**
 * 统一出站预算管理
 *
 * 用于在单次 Worker 请求中统一统计并限制：
 * - fetch
 * - Cache API
 * - KV / D1
 * - TCP connect
 * - DoH / 统计上报等外部请求
 */

/**
 * 预算快照
 */
export interface SubrequestBudgetSnapshot {
  /** 预算上限 */
  limit: number;
  /** 已消耗数量 */
  used: number;
  /** 剩余额度 */
  remaining: number;
  /** 是否已耗尽 */
  exhausted: boolean;
}

/**
 * 预算配置
 */
export interface SubrequestBudgetOptions {
  /** 预算上限 */
  limit: number;
}

/**
 * 子请求预算耗尽错误
 */
export class SubrequestBudgetExceededError extends Error {
  /** 预算上限 */
  public readonly limit: number;
  /** 已消耗数量 */
  public readonly used: number;
  /** 剩余额度 */
  public readonly remaining: number;
  /** 触发上下文 */
  public readonly operation?: string;

  constructor(limit: number, used: number, operation?: string) {
    super(
      operation
        ? `Subrequest budget exceeded (${used}/${limit}) while ${operation}`
        : `Subrequest budget exceeded (${used}/${limit})`,
    );
    this.name = 'SubrequestBudgetExceededError';
    this.limit = limit;
    this.used = used;
    this.remaining = Math.max(0, limit - used);
    this.operation = operation;
  }
}

/**
 * 统一出站预算
 */
export class SubrequestBudget {
  /** 预算上限 */
  public readonly limit: number;

  private usedCount = 0;
  private exhausted = false;

  constructor(options: SubrequestBudgetOptions | number) {
    const rawLimit = typeof options === 'number' ? options : options.limit;
    this.limit = normalizeLimit(rawLimit);
  }

  /**
   * 消耗预算
   * @param amount 消耗数量，默认 1
   * @param operation 触发上下文
   * @returns 消耗后的已用数量
   */
  consume(amount: number = 1, operation?: string): number {
    const cost = normalizeCost(amount);
    if (cost <= 0) {
      return this.usedCount;
    }

    if (this.exhausted || this.usedCount + cost > this.limit) {
      this.exhausted = true;
      throw new SubrequestBudgetExceededError(this.limit, this.usedCount, operation);
    }

    this.usedCount += cost;
    if (this.usedCount >= this.limit) {
      this.exhausted = true;
    }

    return this.usedCount;
  }

  /**
   * 获取剩余额度
   */
  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  /**
   * 获取已消耗数量
   */
  get used(): number {
    return this.usedCount;
  }

  /**
   * 是否已耗尽
   */
  get isExhausted(): boolean {
    return this.exhausted || this.usedCount >= this.limit;
  }

  /**
   * 获取快照
   */
  snapshot(): SubrequestBudgetSnapshot {
    return {
      limit: this.limit,
      used: this.usedCount,
      remaining: this.remaining,
      exhausted: this.isExhausted,
    };
  }

  /**
   * 生成简短描述
   */
  describe(): string {
    return `${this.usedCount}/${this.limit}`;
  }
}

/**
 * 判断是否为预算耗尽错误
 */
export function isSubrequestBudgetExceededError(
  error: unknown,
): error is SubrequestBudgetExceededError {
  return error instanceof Error && error.name === 'SubrequestBudgetExceededError';
}

/**
 * 创建预算实例
 */
export function createSubrequestBudget(limit: number): SubrequestBudget {
  return new SubrequestBudget(limit);
}

/**
 * 基于预算执行 fetch
 */
export async function fetchWithBudget(
  budget: SubrequestBudget | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
  operation: string = 'fetch',
): Promise<Response> {
  budget?.consume(1, operation);
  return await fetch(input, init);
}

/**
 * 创建带预算的 fetcher，适合传递给需要 typeof fetch 的 API
 */
export function createBudgetedFetcher(
  budget: SubrequestBudget | undefined,
  operation: string = 'fetch',
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithBudget(budget, input, init, operation)) as typeof fetch;
}

function normalizeLimit(limit: number): number {
  const normalized = Number.isFinite(limit) ? Math.floor(limit) : 0;
  return normalized > 0 ? normalized : 1;
}

function normalizeCost(amount: number): number {
  const normalized = Number.isFinite(amount) ? Math.floor(amount) : 0;
  return normalized > 0 ? normalized : 0;
}
