/**
 * VLESS WebSocket 处理模块
 * 处理 VLESS over WebSocket 连接
 */

import type { RemoteSocketWrapper, LogFunction } from '../types';
import { 
  processVlessHeader, 
  createVlessResponseHeader,
  type UUIDValidator,
} from '../protocol/vless-header';
import { makeReadableWebSocketStream } from '../utils/_websocket';
import { handleTCPOutBound } from './tcp';
import { handleUDPOutBound, type UDPWriteFunction } from './udp';

// ============================================================================
// VLESS 处理配置
// ============================================================================

/**
 * VLESS 处理选项
 */
export interface VlessHandlerOptions {
  /** UUID 验证器函数，验证连接的 UUID 是否有效 */
  validateUUID: UUIDValidator;
  /** 代理 IP（用于 TCP 重试） */
  proxyIP?: string;
  /** DNS 服务器地址 */
  dnsServer?: string;
}

// ============================================================================
// WebSocket 升级处理
// ============================================================================

/**
 * 处理 VLESS over WebSocket 请求
 * 
 * @param request 传入的 HTTP 请求
 * @param options VLESS 处理选项
 * @returns WebSocket 升级响应
 */
export async function handleVlessOverWS(
  request: Request,
  options: VlessHandlerOptions
): Promise<Response> {
  const { validateUUID, proxyIP, dnsServer } = options;

  // 创建 WebSocket 对
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  // 接受 WebSocket 连接
  webSocket.accept();

  // 连接信息（用于日志）
  let address = '';
  let portWithRandomLog = '';

  /**
   * 日志函数
   */
  const log: LogFunction = (info: string, event?: string) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };

  // 获取早期数据（WebSocket 0-RTT）
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  // 创建可读的 WebSocket 流
  const readableWebSocketStream = makeReadableWebSocketStream(
    webSocket,
    earlyDataHeader,
    log
  );

  // 远程 socket 包装器（用于在函数间共享）
  const remoteSocketWrapper: RemoteSocketWrapper = {
    value: null,
  };

  // UDP 相关状态
  let udpStreamWrite: UDPWriteFunction | null = null;
  let isDns = false;

  // 处理 WebSocket 数据流
  // ws --> remote
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk: ArrayBuffer, controller) {
          // 处理 DNS UDP 流
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(new Uint8Array(chunk));
          }

          // 如果已有远程连接，直接转发数据
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          // 首次连接：解析 VLESS 协议头，使用验证器验证 UUID
          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlessHeader(chunk, validateUUID);

          // 更新日志信息
          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 4)} ${
            isUDP ? 'udp' : 'tcp'
          }`;

          // 处理解析错误
          if (hasError) {
            throw new Error(message);
          }

          // UDP 处理（仅支持 DNS）
          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only supports DNS (port 53)');
            }
          }

          // 创建 VLESS 响应头
          const vlessResponseHeader = createVlessResponseHeader(vlessVersion);

          // 提取原始客户端数据
          const rawClientData = new Uint8Array(chunk.slice(rawDataIndex));

          // 根据协议类型处理
          if (isDns) {
            // DNS 查询
            const { write } = await handleUDPOutBound(
              webSocket,
              vlessResponseHeader,
              log,
              dnsServer
            );
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
          } else {
            // TCP 连接
            handleTCPOutBound(
              remoteSocketWrapper,
              addressRemote,
              portRemote,
              rawClientData,
              webSocket,
              vlessResponseHeader,
              log,
              proxyIP
            );
          }
        },

        close() {
          log('ReadableWebSocketStream closed');
        },

        abort(reason) {
          log('ReadableWebSocketStream aborted', JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('ReadableWebSocketStream pipeTo error', String(err));
    });

  // 返回 WebSocket 升级响应
  return new Response(null, {
    status: 101,
    // @ts-ignore - webSocket 属性是 Cloudflare Workers 的 WebSocket 升级响应特有
    webSocket: client,
  });
}