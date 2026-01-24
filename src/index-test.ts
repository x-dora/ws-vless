
import type { WorkerEnv } from './types';
import { getConfig } from './config';
import { isValidUUID } from './utils/uuid';
import { handleVlessOverWS } from './handlers/vless';
import { createUUIDValidator } from './protocol/vless-header';
import { generateVlessConfig } from './output/config-generator';
import { 
  createUUIDManager, 
  StaticUUIDProvider, 
  HttpApiUUIDProvider,
  createRemnawaveProvider,
  type UUIDProviderManager 
} from './providers';

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

        // 创建 WebSocket 对
        const webSocketPair = new WebSocketPair();
        return new Response('Hello World', { status: 200 });
    }
}