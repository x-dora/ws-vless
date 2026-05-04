/**
 * WebSocket 工具模块
 * 提供 WebSocket 相关的辅助函数
 */

import { WS_READY_STATE } from '../types';

// ============================================================================
// WebSocket 操作
// ============================================================================

/**
 * 安全关闭 WebSocket 连接
 * 避免在关闭时抛出异常
 * @param socket WebSocket 实例
 */
export function safeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE.OPEN || socket.readyState === WS_READY_STATE.CLOSING) {
      socket.close();
    }
  } catch {
    // 静默处理关闭异常，避免生产环境日志污染
  }
}

/**
 * 检查 WebSocket 是否处于可发送数据的状态
 * @param socket WebSocket 实例
 * @returns boolean 是否可以发送数据
 */
export function isWebSocketOpen(socket: WebSocket): boolean {
  return socket.readyState === WS_READY_STATE.OPEN;
}

// ============================================================================
// 编码辅助
// ============================================================================

/**
 * Base64 解码结果
 */
export interface Base64DecodeResult {
  earlyData?: Uint8Array;
  error?: unknown;
}

/**
 * 将 WebSocket early data 的 Base64 字符串解码为字节数组
 * 支持 URL 安全的 Base64（RFC 4648）
 * @param base64Str Base64 编码的字符串
 * @returns 解码结果
 */
export function decodeWebSocketEarlyData(base64Str: string): Base64DecodeResult {
  if (!base64Str) {
    return { error: null };
  }

  try {
    // Go 使用修改过的 URL 安全 Base64（RFC 4648）
    // JavaScript 的 atob 不支持，需要转换
    const normalizedBase64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalizedBase64);
    const earlyData = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    return { earlyData, error: null };
  } catch (error) {
    return { error };
  }
}
