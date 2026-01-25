/**
 * WebSocket 连接处理模块
 * 处理代理协议的 WebSocket 连接（支持普通连接和 Mux 多路复用）
 */

import type { RemoteSocketWrapper, LogFunction } from '../types';
import { 
  processHeader, 
  createResponseHeader,
  type UUIDValidator,
} from '../core/header';
import { isMuxConnection } from '../core/mux';
import { makeReadableWebSocketStream } from '../utils/_websocket';
import { handleTCPOutBound } from './tcp';
import { handleUDPOutBound, type UDPWriteFunction } from './udp';
import { createMuxSession, type MuxSession } from './mux-session';

// ============================================================================
// 处理配置
// ============================================================================

/**
 * 连接处理选项
 */
export interface ConnectionHandlerOptions {
  /** UUID 验证器函数，验证连接的 UUID 是否有效 */
  validateUUID: UUIDValidator;
  /** 代理 IP（用于 TCP 重试） */
  proxyIP?: string;
  /** DNS 服务器地址 */
  dnsServer?: string;
  /** 是否启用 Mux 多路复用 */
  muxEnabled?: boolean;
}

// ============================================================================
// WebSocket 升级处理
// ============================================================================

/**
 * 处理 WebSocket 代理请求
 * 
 * @param request 传入的 HTTP 请求
 * @param options 处理选项
 * @returns WebSocket 升级响应
 */
export async function handleTunnelOverWS(
  request: Request,
  options: ConnectionHandlerOptions
): Promise<Response> {
  const { validateUUID, proxyIP, dnsServer, muxEnabled = true } = options;

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

  // Mux 会话（如果是 Mux 连接）
  let muxSession: MuxSession | null = null;

  // 处理 WebSocket 数据流
  // ws --> remote
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk: ArrayBuffer, controller) {
          // 处理 Mux 数据
          if (muxSession) {
            await muxSession.processData(chunk);
            return;
          }

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

          // 首次连接：解析协议头，使用验证器验证 UUID
          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            protocolVersion = new Uint8Array([0, 0]),
            isUDP,
            isMux,
          } = processHeader(chunk, validateUUID);

          // 更新日志信息
          address = addressRemote;
          const connectionType = isMux ? 'mux' : (isUDP ? 'udp' : 'tcp');
          portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 4)} ${connectionType}`;

          // 处理解析错误
          if (hasError) {
            throw new Error(message);
          }

          // 创建响应头
          const responseHeader = createResponseHeader(protocolVersion);

          // 提取原始客户端数据
          const rawClientData = new Uint8Array(chunk.slice(rawDataIndex));

          // 根据连接类型处理
          if (isMux && muxEnabled) {
            // Mux 多路复用连接
            log('Mux connection established');
            muxSession = createMuxSession({
              webSocket,
              responseHeader,
              log,
              proxyIP,
              dnsServer,
            });
            
            // 处理初始数据
            if (rawClientData.length > 0) {
              await muxSession.processData(rawClientData.buffer);
            }
          } else if (isUDP) {
            // UDP 处理（仅支持 DNS）
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only supports DNS (port 53)');
            }

            // DNS 查询
            const { write } = await handleUDPOutBound(
              webSocket,
              responseHeader,
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
              responseHeader,
              log,
              proxyIP
            );
          }
        },

        close() {
          log('ReadableWebSocketStream closed');
          // 清理 Mux 会话
          if (muxSession) {
            muxSession.close();
          }
        },

        abort(reason) {
          log('ReadableWebSocketStream aborted', JSON.stringify(reason));
          // 清理 Mux 会话
          if (muxSession) {
            muxSession.close();
          }
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

