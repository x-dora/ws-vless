/**
 * TCP 出站处理模块
 * 处理代理 TCP 连接
 */

import { connect } from 'cloudflare:sockets';
import type { TrafficTracker } from '../services/stats-reporter';
import type { ConnLogFunction, RemoteSocketWrapper } from '../types';
import { WS_READY_STATE } from '../types';
import { safeCloseWebSocket } from '../utils/_websocket';
import type { OutboundRetryOptions } from '../utils/nat64';
import { formatSocketHostname, resolveRetryTarget } from '../utils/nat64';

// ============================================================================
// TCP 连接处理
// ============================================================================

/**
 * 处理 TCP 出站连接
 * 建立到远程服务器的 TCP 连接并桥接 WebSocket
 *
 * @param remoteSocket 远程 socket 包装器
 * @param addressRemote 远程地址
 * @param portRemote 远程端口
 * @param rawClientData 原始客户端数据
 * @param webSocket WebSocket 连接
 * @param responseHeader 协议响应头
 * @param log 日志函数
 * @param proxyIP 代理 IP（用于重试）
 * @param trafficTracker 流量追踪器（可选）
 */
export async function handleTCPOutBound(
  remoteSocket: RemoteSocketWrapper,
  addressRemote: string,
  addressType: number | undefined,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  responseHeader: Uint8Array,
  log: ConnLogFunction,
  retryOptions?: OutboundRetryOptions,
  trafficTracker?: TrafficTracker | null,
): Promise<void> {
  let retryAttempted = false;

  /**
   * 连接到远程服务器并写入初始数据
   * @param address 目标地址
   * @param port 目标端口
   * @returns TCP socket 实例
   */
  async function connectAndWrite(
    address: string,
    port: number,
    mode: 'direct' | 'proxy-ip' | 'nat64',
  ): Promise<Socket> {
    const hostname = formatSocketHostname(address);
    const tcpSocket: Socket = connect({
      hostname,
      port: port,
    });

    remoteSocket.value = tcpSocket;
    log.debug(
      mode === 'direct'
        ? `Connecting to ${hostname}:${port}`
        : `Connecting via ${mode} ${hostname}:${port}`,
    );

    await tcpSocket.opened;
    log.debug(`Connected to ${hostname}:${port}`);

    // 写入初始数据（通常是 TLS Client Hello）
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();

    // 追踪上行流量
    trafficTracker?.addUplink(rawClientData.byteLength);

    return tcpSocket;
  }

  /**
   * 重试连接（优先显式代理 IP，否则走 NAT64）
   */
  async function retry(reason: string): Promise<boolean> {
    if (retryAttempted) {
      return false;
    }

    retryAttempted = true;
    const target = await resolveRetryTarget(addressRemote, addressType, retryOptions ?? {});
    if (!target) {
      log.debug(`No retry target available (${reason})`);
      return false;
    }

    log.debug(`Retrying connection via ${target.mode} ${target.address}:${portRemote} (${reason})`);
    let tcpSocket: Socket;
    try {
      tcpSocket = await connectAndWrite(target.address, portRemote, target.mode);
    } catch (error) {
      log.warn(`Retry connect failed (${target.mode}): ${String(error)}`);
      return false;
    }

    // 无论重试成功与否，最终都要关闭 WebSocket
    tcpSocket.closed
      .catch((error: unknown) => {
        log.error('Retry tcpSocket closed error:', String(error));
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });

    // 将远程数据转发到 WebSocket
    await remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log, trafficTracker);
    return true;
  }

  try {
    // 首先尝试直连
    const tcpSocket = await connectAndWrite(addressRemote, portRemote, 'direct');

    // 将远程数据转发到 WebSocket，如果没有数据则重试
    await remoteSocketToWS(
      tcpSocket,
      webSocket,
      responseHeader,
      async () => retry('no incoming data'),
      log,
      trafficTracker,
    );
  } catch (error) {
    if (retryAttempted) {
      throw error;
    }
    log.warn('Initial TCP connect failed, attempting fallback', String(error));
    const retried = await retry('initial connect failure');
    if (!retried) {
      safeCloseWebSocket(webSocket);
    }
  }
}

// ============================================================================
// 数据转发
// ============================================================================

/**
 * 将远程 Socket 数据转发到 WebSocket
 *
 * @param remoteSocket 远程 TCP socket
 * @param webSocket WebSocket 连接
 * @param responseHeader 协议响应头
 * @param retry 重试函数（可选）
 * @param log 日志函数
 * @param trafficTracker 流量追踪器（可选）
 */
export async function remoteSocketToWS(
  remoteSocket: Socket,
  webSocket: WebSocket,
  responseHeader: Uint8Array | null,
  retry: (() => Promise<boolean>) | null,
  log: ConnLogFunction,
  trafficTracker?: TrafficTracker | null,
): Promise<void> {
  let header: Uint8Array | null = responseHeader;
  let hasIncomingData = false;
  let streamError: unknown = null;

  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {
          // 初始化
        },

        async write(chunk: Uint8Array, controller) {
          if (chunk.byteLength > 0) {
            hasIncomingData = true;
          }

          // 追踪下行流量
          trafficTracker?.addDownlink(chunk.byteLength);

          // 检查 WebSocket 状态
          if (webSocket.readyState !== WS_READY_STATE.OPEN) {
            controller.error('WebSocket is not open');
            return;
          }

          // 发送数据
          if (header) {
            // 第一次发送需要附加响应头
            const combined = await new Blob([header, chunk]).arrayBuffer();
            webSocket.send(combined);
            header = null;
          } else {
            webSocket.send(chunk);
          }
        },

        close() {
          log.debug(`Remote connection readable closed, hasIncomingData: ${hasIncomingData}`);
          // 不主动关闭 WebSocket，让客户端发起关闭
          // 避免 HTTP ERR_CONTENT_LENGTH_MISMATCH 问题
        },

        abort(reason) {
          log.error('Remote connection readable aborted:', String(reason));
        },
      }),
    )
    .catch((error: unknown) => {
      streamError = error;
      log.error('remoteSocketToWS exception:', String(error));
    });

  // 如果没有收到数据且有重试函数，执行重试
  // 这通常发生在 CF 连接 socket 时出现问题
  if (!hasIncomingData && retry) {
    log.debug('No incoming data, retrying...');
    const retried = await retry();
    if (retried) {
      return;
    }
    safeCloseWebSocket(webSocket);
    return;
  }

  if (streamError || !hasIncomingData) {
    safeCloseWebSocket(webSocket);
  }
}
