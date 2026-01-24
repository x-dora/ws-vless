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
    if (
      socket.readyState === WS_READY_STATE.OPEN ||
      socket.readyState === WS_READY_STATE.CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error:', error);
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
// WebSocket 流处理
// ============================================================================

/**
 * 创建可读的 WebSocket 流
 * 将 WebSocket 消息转换为 ReadableStream
 * @param webSocketServer WebSocket 服务端实例
 * @param earlyDataHeader 早期数据头（用于 ws 0-RTT）
 * @param log 日志函数
 * @returns ReadableStream 可读流
 */
export function makeReadableWebSocketStream(
  webSocketServer: any,
  earlyDataHeader: string,
  log: (info: string, event?: string) => void
): ReadableStream<ArrayBuffer> {
  let readableStreamCancel = false;

  const stream = new ReadableStream<ArrayBuffer>({
    start(controller) {
      // 监听 WebSocket 消息事件
      webSocketServer.addEventListener('message', (event: MessageEvent) => {
        if (readableStreamCancel) {
          return;
        }
        const message = event.data;
        controller.enqueue(message);
      });

      // 监听 WebSocket 关闭事件
      // 客户端关闭了 client -> server 流
      // 但 server -> client 流仍然开放，需要调用 close() 完全关闭
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) {
          return;
        }
        controller.close();
      });

      // 监听 WebSocket 错误事件
      webSocketServer.addEventListener('error', (err: Event) => {
        log('WebSocket server error');
        controller.error(err);
      });

      // 处理 WebSocket 0-RTT 早期数据
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    pull(_controller) {
      // 背压处理：如果流已满，可以在这里实现停止读取
      // https://streams.spec.whatwg.org/#example-rs-push-backpressure
    },

    cancel(reason) {
      // 取消原因：
      // 1. pipe 到 WritableStream 时发生错误
      // 2. 手动取消流
      if (readableStreamCancel) {
        return;
      }
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });

  return stream;
}

// ============================================================================
// 编码辅助
// ============================================================================

/**
 * Base64 解码结果
 */
interface Base64DecodeResult {
  earlyData?: ArrayBuffer;
  error?: unknown;
}

/**
 * 将 Base64 字符串解码为 ArrayBuffer
 * 支持 URL 安全的 Base64（RFC 4648）
 * @param base64Str Base64 编码的字符串
 * @returns 解码结果
 */
function base64ToArrayBuffer(base64Str: string): Base64DecodeResult {
  if (!base64Str) {
    return { error: null };
  }

  try {
    // Go 使用修改过的 URL 安全 Base64（RFC 4648）
    // JavaScript 的 atob 不支持，需要转换
    const normalizedBase64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalizedBase64);
    const arrayBuffer = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}
