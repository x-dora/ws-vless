/**
 * Tunnel Worker 主入口
 * Cloudflare Worker 实现的代理服务
 * 
 * 功能特性:
 * - 支持代理协议 over WebSocket
 * - 支持 TCP 和 UDP (DNS) 代理
 * - 支持 Mux.Cool 多路复用协议
 * - 支持多 UUID 验证（所有有效 UUID 都可以连接）
 * - 支持多平台 UUID 获取（Remnawave 等）
 * - 使用 Cache API 缓存 UUID 列表
 * - 生成多种客户端配置格式
 * - API 端点需要密钥保护
 * - 默认 UUID 仅在开发模式生效
 * 
 * @author Your Name
 * @license MIT
 */
;
import type { WorkerEnv } from './types';
import { getConfig } from './config';
import { isValidUUID } from './utils/uuid';
import { createLogger, initLogger, LogLevel } from './utils/logger';
import { handleTunnelOverWS } from './handlers/connection';
import { createUUIDValidator } from './core/header';
import { 
  createUUIDManager, 
  StaticUUIDProvider, 
  HttpApiUUIDProvider,
  createRemnawaveProvider,
  type UUIDProviderManager 
} from './providers';

const log = createLogger('Init');

// ============================================================================
// 安全工具函数
// ============================================================================

/**
 * 检查是否为开发模式
 * 通过 DEV_MODE 环境变量控制，默认为 false（生产模式）
 */
function isDevMode(env: WorkerEnv): boolean {
  return env.DEV_MODE === 'true';
}

/**
 * 验证 API 密钥
 * @param request HTTP 请求
 * @param apiKey 配置的 API 密钥
 * @returns 验证结果
 */
function validateApiKey(request: Request, apiKey: string | undefined): { valid: boolean; error?: string } {
  // 如果没有设置 API_KEY，禁止访问 API
  if (!apiKey) {
    return { valid: false, error: 'API access disabled: API_KEY not configured' };
  }

  // 从请求头或查询参数获取密钥
  const url = new URL(request.url);
  const headerKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
  const queryKey = url.searchParams.get('key');
  const providedKey = headerKey || queryKey;

  if (!providedKey) {
    return { valid: false, error: 'API key required. Use X-API-Key header or ?key= query parameter' };
  }

  if (providedKey !== apiKey) {
    return { valid: false, error: 'Invalid API key' };
  }

  return { valid: true };
}

// ============================================================================
// Worker 导出
// ============================================================================

export default {
  /**
   * 处理传入的 HTTP 请求
   * @param request HTTP 请求
   * @param env 环境变量
   * @param ctx 执行上下文
   * @returns HTTP 响应
   */
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // 获取运行时配置
      const config = getConfig(env);

      // 获取缓存 TTL
      const cacheTTL = env.UUID_CACHE_TTL ? parseInt(env.UUID_CACHE_TTL as string, 10) : undefined;

      // 每次请求初始化 UUID 管理器
      // Worker 是无状态的，使用 Cache API 进行持久化
      const uuidManager = initializeUUIDManager(config.userID, env, cacheTTL);

      // 获取所有有效的 UUID 列表（优先从 Cache API 获取）
      const validUUIDs = await uuidManager.getAllUUIDs();
      
      // 创建 UUID 验证器（支持所有有效 UUID 连接）
      const validateUUID = createUUIDValidator(validUUIDs);

      // 检查是否是 WebSocket 升级请求
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader === 'websocket') {
        // 处理 WebSocket 代理连接
        const muxEnabled = env.MUX_ENABLED !== 'false'; // 默认启用
        return await handleTunnelOverWS(request, {
          validateUUID,
          proxyIP: config.proxyIP,
          dnsServer: config.dnsServer,
          muxEnabled,
        });
      }

      // 处理普通 HTTP 请求
      return await handleHttpRequest(request, validUUIDs, uuidManager, env);
    } catch (err) {
      const error = err as Error;
      log.error('Worker error:', error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};

// ============================================================================
// HTTP 请求处理
// ============================================================================

/**
 * 处理普通 HTTP 请求
 * @param request HTTP 请求
 * @param validUUIDs 有效的 UUID 列表
 * @param manager UUID 管理器
 * @param env 环境变量
 * @returns HTTP 响应
 */
async function handleHttpRequest(
  request: Request,
  validUUIDs: string[],
  manager: UUIDProviderManager,
  env: WorkerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const hostName = request.headers.get('Host') || url.hostname;

  // 检查是否是 API 路径
  if (url.pathname.startsWith('/api/')) {
    // API 端点需要密钥验证
    const authResult = validateApiKey(request, env.API_KEY);
    if (!authResult.valid) {
      return new Response(JSON.stringify({ error: authResult.error }, null, 2), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  switch (url.pathname) {
    case '/':
      // 根路径：返回服务器信息
      return handleRootPath(request);

    case '/api/uuids':
      // API：获取所有可用 UUID（需要密钥）
      return await handleUUIDsPath(manager);

    case '/api/uuids/refresh':
      // API：强制刷新 UUID 缓存（需要密钥）
      return await handleRefreshPath(manager);

    case '/api/stats':
      // API：获取提供者统计信息（需要密钥）
      return await handleStatsPath(manager);

    default:
      // 检查是否是有效 UUID 的配置请求
      const pathUUID = url.pathname.slice(1);
      if (isValidUUID(pathUUID)) {
        // 检查是否是有效的 UUID（在有效列表中）
        const normalizedUUID = pathUUID.toLowerCase();
        const isValidUser = validUUIDs.some(
          uuid => uuid.toLowerCase() === normalizedUUID
        );
        
        if (isValidUser) {
          return handleConfigPath(pathUUID, hostName);
        }
      }
      return new Response('Not Found', { status: 404 });
  }
}

/**
 * 处理根路径请求
 */
function handleRootPath(request: Request): Response {
  // 返回 Cloudflare 请求信息
  const cf = (request as unknown as { cf?: object }).cf;
  return new Response(JSON.stringify(cf || { message: 'Tunnel Worker Running' }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 处理配置路径请求
 */
function handleConfigPath(userID: string, hostName: string): Response {
  return new Response("Not implemented", {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 处理获取 UUID 列表请求
 */
async function handleUUIDsPath(manager: UUIDProviderManager): Promise<Response> {
  const uuids = await manager.getAllUUIDs();
  return new Response(JSON.stringify({ uuids, count: uuids.length }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 处理刷新 UUID 缓存请求
 */
async function handleRefreshPath(manager: UUIDProviderManager): Promise<Response> {
  await manager.refresh();
  const uuids = await manager.getAllUUIDs();
  return new Response(
    JSON.stringify({ message: 'Cache refreshed', uuids, count: uuids.length }, null, 2),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * 处理统计信息请求
 */
async function handleStatsPath(manager: UUIDProviderManager): Promise<Response> {
  const stats = await manager.getStats();
  return new Response(JSON.stringify(stats, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// UUID 管理器初始化
// ============================================================================

/**
 * 初始化 UUID 提供者管理器
 * 
 * 分层缓存架构：
 * - L1: Cache API（边缘节点，始终启用）
 * - L2: KV 或 D1（持久化，可选，KV 优先）
 * 
 * 注意：
 * - 默认 UUID 仅在开发模式（DEV_MODE=true）下生效
 * - 生产环境需要通过 API 提供者（如 Remnawave）获取 UUID
 * 
 * @param defaultUUID 默认 UUID（来自环境变量）
 * @param env 环境变量
 * @param cacheTTL 缓存 TTL（秒）
 * @returns 配置好的管理器实例
 */
function initializeUUIDManager(
  defaultUUID: string, 
  env: WorkerEnv,
  cacheTTL?: number
): UUIDProviderManager {
  const devMode = isDevMode(env);
  
  // 初始化日志级别：开发模式 DEBUG，生产模式 WARN
  // 可通过 LOG_LEVEL 环境变量覆盖：OFF, ERROR, WARN, INFO, DEBUG
  initLogger(devMode, env.LOG_LEVEL);
  
  // 生产模式下不使用默认 UUID，传入空字符串
  // 开发模式下使用 UUID 环境变量作为默认值
  const effectiveDefaultUUID = devMode ? defaultUUID : '';
  
  // 分层缓存：L1=CacheAPI, L2=KV/D1（可选）
  const manager = createUUIDManager(effectiveDefaultUUID, {
    cacheTTL,
    kv: env.UUID_KV,  // 如果配置了 KV，作为 L2
    d1: env.UUID_D1,  // 如果没有 KV 但有 D1，作为 L2
  });
  
  log.info(devMode ? 'Dev mode' : 'Prod mode', `Cache: ${manager.getCacheType()}`);

  // =========================================================================
  // Remnawave API 提供者
  // 如果配置了 RW_API_URL 和 RW_API_KEY，自动注册
  // =========================================================================
  const remnawaveProvider = createRemnawaveProvider(
    env.RW_API_URL,
    env.RW_API_KEY,
    { cacheTTL }
  );
  if (remnawaveProvider) {
    manager.register(remnawaveProvider);
    log.debug('Remnawave provider registered');
  }

  // =========================================================================
  // 在这里注册其他自定义 UUID 提供者
  // =========================================================================
  
  // 示例 1: 添加额外的静态 UUID（这些 UUID 都可以连接）
  // manager.register(new StaticUUIDProvider([
  //   'additional-uuid-1',
  //   'additional-uuid-2',
  // ], 10));

  // 示例 2: 从其他 HTTP API 获取 UUID 列表
  // manager.register(new HttpApiUUIDProvider({
  //   enabled: true,
  //   endpoint: 'https://your-api.example.com/uuids',
  //   authToken: env.API_TOKEN,
  //   timeout: 5000,
  // }, 30));

  return manager;
}

// ============================================================================
// 导出模块（方便测试和扩展）
// ============================================================================

export { 
  // 类型
  type WorkerEnv,
  
  // 配置
  getConfig,
  
  // UUID 工具
  isValidUUID,
  
  // 提供者
  createUUIDManager,
  StaticUUIDProvider,
  HttpApiUUIDProvider,
  
  // UUID 验证器
  createUUIDValidator,
};

// 核心协议
export * from './core';

// 处理器
export { handleTunnelOverWS } from './handlers/connection';
export { MuxSession, createMuxSession } from './handlers/mux-session';
