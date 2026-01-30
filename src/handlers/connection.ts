/**
 * WebSocket 连接处理模块
 * 处理代理协议的 WebSocket 连接（支持普通连接和 Mux 多路复用）
 */

import type { RemoteSocketWrapper, ConnLogFunction } from '../types';
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
import { 
  TrafficTracker, 
  createStatsReporter, 
  type StatsReporterConfig 
} from '../services/stats-reporter';
import { createConnLog } from '../utils/logger';

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
  /** 流量上报配置（可选） */
  statsReporter?: StatsReporterConfig;
  /** waitUntil 函数（用于后台任务） */
  waitUntil?: (promise: Promise<unknown>) => void;
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
  const { validateUUID, proxyIP, dnsServer, muxEnabled = true, statsReporter, waitUntil } = options;

  // 创建 WebSocket 对
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  // 接受 WebSocket 连接
  webSocket.accept();

  // 连接信息（用于日志）
  let address = '';
  let portWithRandomLog = '';

  // 流量追踪器和上报函数
  let trafficTracker: TrafficTracker | null = null;
  const reportStats = statsReporter 
    ? createStatsReporter(statsReporter) 
    : async () => true;

  /**
   * 日志函数 - 使用统一日志系统
   * 根据 LOG_LEVEL 环境变量控制输出级别
   */
  const getLog = () => createConnLog(`${address}:${portWithRandomLog}`);
  // 兼容性 log 函数（用于传递给其他模块）
  const log: ConnLogFunction = getLog();

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
          // 处理 Mux 数据（流量由 muxSession 内部统计，关闭时获取）
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
            // 追踪上行流量
            trafficTracker?.addUplink(chunk.byteLength);
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
            userUUID,
          } = processHeader(chunk, validateUUID);

          // 更新日志信息
          address = addressRemote;
          const connectionType = isMux ? 'mux' : (isUDP ? 'udp' : 'tcp');
          portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 4)} ${connectionType}`;

          // 处理解析错误
          if (hasError) {
            throw new Error(message);
          }

          // 创建流量追踪器（如果启用了统计上报且有用户标识）
          if (statsReporter?.enabled && userUUID) {
            trafficTracker = new TrafficTracker(
              userUUID, 
              `${addressRemote}:${portRemote}`,
              connectionType as 'tcp' | 'udp' | 'mux'
            );
          }

          // 创建响应头
          const responseHeader = createResponseHeader(protocolVersion);

          // 提取原始客户端数据
          const rawClientData = new Uint8Array(chunk.slice(rawDataIndex));

          // 根据连接类型处理
          if (isMux && muxEnabled) {
            // Mux 多路复用连接（DEBUG 级别日志）
            log.debug('Mux connection established');
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
              proxyIP,
              trafficTracker
            );
          }
        },

        close() {
          log.debug('ReadableWebSocketStream closed');
          // 清理 Mux 会话并获取统计
          if (muxSession) {
            // 从 Mux 会话获取流量统计
            const muxStats = muxSession.getStats();
            if (trafficTracker) {
              // bytesReceived = 上行（客户端发送的数据）
              // bytesSent = 下行（发送给客户端的数据）
              trafficTracker.addUplink(muxStats.bytesReceived);
              trafficTracker.addDownlink(muxStats.bytesSent);
            }
            muxSession.close();
          }
          // 上报流量统计（使用 waitUntil 确保请求完成）
          if (trafficTracker) {
            const stats = trafficTracker.getStats();
            log.debug(`Traffic: ↑${stats.uplink} ↓${stats.downlink}`);
            if (!trafficTracker.isReported() && trafficTracker.hasTraffic()) {
              trafficTracker.markReported();
              const reportPromise = reportStats(stats)
                .then((ok) => ok ? log.debug('Stats reported') : log.warn('Stats report failed'))
                .catch((e) => log.error(`Stats report error: ${e}`));
              // 使用 waitUntil 确保上报请求在 Worker 结束后继续执行
              if (waitUntil) {
                waitUntil(reportPromise);
              }
            }
          }
        },

        abort(reason) {
          log.warn('ReadableWebSocketStream aborted', JSON.stringify(reason));
          // 清理 Mux 会话并获取统计
          if (muxSession) {
            const muxStats = muxSession.getStats();
            if (trafficTracker) {
              trafficTracker.addUplink(muxStats.bytesReceived);
              trafficTracker.addDownlink(muxStats.bytesSent);
            }
            muxSession.close();
          }
          // 上报流量统计（使用 waitUntil 确保请求完成）
          if (trafficTracker) {
            const stats = trafficTracker.getStats();
            log.debug(`Traffic: ↑${stats.uplink} ↓${stats.downlink}`);
            if (!trafficTracker.isReported() && trafficTracker.hasTraffic()) {
              trafficTracker.markReported();
              const reportPromise = reportStats(stats)
                .then((ok) => ok ? log.debug('Stats reported') : log.warn('Stats report failed'))
                .catch((e) => log.error(`Stats report error: ${e}`));
              if (waitUntil) {
                waitUntil(reportPromise);
              }
            }
          }
        },
      })
    )
    .catch((err) => {
      log.error('ReadableWebSocketStream pipeTo error', String(err));
    });

  // 返回 WebSocket 升级响应
  return new Response(null, {
    status: 101,
    // @ts-ignore - webSocket 属性是 Cloudflare Workers 的 WebSocket 升级响应特有
    webSocket: client,
  });
}

