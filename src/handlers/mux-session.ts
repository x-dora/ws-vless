/**
 * Mux 会话管理模块
 * 管理 Mux.Cool 多路复用连接中的所有子连接
 */

// @ts-ignore - Cloudflare Workers 特有模块
import { connect } from 'cloudflare:sockets';

import type { LogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import {
  MuxStatus,
  MuxNetwork,
  MuxOption,
  parseMuxFrame,
  buildMuxKeepFrame,
  buildMuxEndFrame,
  type MuxFrame,
  type SubConnection,
} from '../core/mux';
import { safeCloseWebSocket } from '../utils/_websocket';
import { DEFAULT_DNS_SERVER } from '../config';

// ============================================================================
// Cloudflare Workers 调度器类型
// ============================================================================

/**
 * 创建可靠的超时 Promise（兼容 Cloudflare Workers）
 * 在 Workers 中 setTimeout 可能不可靠，优先使用 scheduler.wait()
 */
function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    // 优先使用 scheduler.wait()（Cloudflare Workers 原生 API）
    // @ts-ignore - scheduler 是 Cloudflare Workers 全局对象
    if (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function') {
      // @ts-ignore
      scheduler.wait(ms).then(() => reject(new Error('Connect timeout')));
    } else {
      // 回退到 setTimeout（可能在某些情况下不可靠）
      setTimeout(() => reject(new Error('Connect timeout')), ms);
    }
  });
}

// ============================================================================
// Cloudflare Workers 子请求限制
// ============================================================================

/**
 * Cloudflare Workers 子请求限制
 * - 免费计划：50 个子请求/请求
 * - 付费计划：1000 个子请求/请求
 * 
 * 注意：这是累计限制，不是并发限制
 * 一旦创建了 50 个 TCP 连接，即使之前的已关闭，也不能再创建新的
 */
const MAX_SUBREQUESTS = 48; // 预留 2 个给 DNS 查询等

// ============================================================================
// Mux 会话类型
// ============================================================================

/**
 * Mux 会话配置
 */
export interface MuxSessionOptions {
  /** WebSocket 连接 */
  webSocket: WebSocket;
  /** 协议响应头 */
  responseHeader: Uint8Array;
  /** 日志函数 */
  log: LogFunction;
  /** 代理 IP（用于 TCP 重试） */
  proxyIP?: string;
  /** DNS 服务器地址 */
  dnsServer?: string;
  /** 连接超时时间（毫秒） */
  timeout?: number;
}

// ============================================================================
// Mux 会话管理器
// ============================================================================

/**
 * Mux 会话管理器
 * 管理一个 Mux 主连接中的所有子连接
 */
export class MuxSession {
  /** 子连接映射表 */
  private connections: Map<number, SubConnection> = new Map();
  
  /** WebSocket 连接 */
  private webSocket: WebSocket;
  
  /** 协议响应头 */
  private responseHeader: Uint8Array;
  
  /** 是否已发送响应头 */
  private headerSent: boolean = false;
  
  /** 日志函数 */
  private log: LogFunction;
  
  /** 代理 IP */
  private proxyIP?: string;
  
  /** DNS 服务器 */
  private dnsServer: string;
  
  /** 连接超时时间 */
  private timeout: number;
  
  /** 数据缓冲区（用于处理不完整的帧） */
  private buffer: Uint8Array = new Uint8Array(0);

  /** 已创建的 TCP 连接总数（累计，用于子请求限制） */
  private totalTCPConnections: number = 0;

  /** 是否已达到子请求上限 */
  private limitReached: boolean = false;

  constructor(options: MuxSessionOptions) {
    this.webSocket = options.webSocket;
    this.responseHeader = options.responseHeader;
    this.log = options.log;
    this.proxyIP = options.proxyIP;
    this.dnsServer = options.dnsServer || DEFAULT_DNS_SERVER;
    this.timeout = options.timeout || 300000; // 默认 5 分钟
  }

  /**
   * 处理传入的 Mux 数据
   * @param data 原始数据
   */
  async processData(data: ArrayBuffer): Promise<void> {
    // 合并缓冲区 - 确保创建全新的 ArrayBuffer
    const incoming = new Uint8Array(data);
    const combined = new Uint8Array(this.buffer.length + incoming.length);
    combined.set(this.buffer, 0);
    combined.set(incoming, this.buffer.length);
    
    // 处理位置
    let offset = 0;
    const totalLength = combined.length;
    
    // 防止死循环的最大迭代次数
    let maxIterations = 1000;
    
    // 收集所有解析出的帧
    const frames: MuxFrame[] = [];

    // 第一阶段：顺序解析所有完整的帧
    while (offset < totalLength && maxIterations-- > 0) {
      const remainingLength = totalLength - offset;
      
      // 检查最小长度
      if (remainingLength < 2) {
        break;
      }
      
      // 创建剩余数据的独立副本用于解析
      const remainingData = combined.slice(offset, totalLength);
      const result = parseMuxFrame(remainingData.buffer);
      
      if (result.hasError) {
        // 数据不完整，等待更多数据
        if (result.message?.includes('Incomplete') || result.message?.includes('too short')) {
          break;
        }
        // 解析错误
        this.log(`Mux parse error: ${result.message}`);
        break;
      }

      const { frame } = result;
      
      // 防止 frameLength 为 0 导致死循环
      if (frame.frameLength <= 0) {
        this.log(`Mux invalid frameLength: ${frame.frameLength}`);
        break;
      }
      
      // 收集帧
      frames.push(frame);
      
      // 移动偏移量
      offset += frame.frameLength;
    }

    // 保留未处理的数据 - 创建独立副本
    if (offset < totalLength) {
      this.buffer = combined.slice(offset);
    } else {
      this.buffer = new Uint8Array(0);
    }
    
    // 第二阶段：并行处理所有帧（不等待完成）
    // 每个帧的处理都是独立的异步任务，不阻塞当前调用
    for (const frame of frames) {
      // 直接启动帧处理，不等待结果
      // handleFrame 内部会异步处理连接，不会阻塞后续帧
      this.handleFrame(frame).catch(err => {
        this.log(`Mux handleFrame error: ${err}`);
      });
    }
  }
  
  /**
   * 处理单个 Mux 帧
   * @param frame Mux 帧
   */
  private async handleFrame(frame: MuxFrame): Promise<void> {
    const { metadata, newConnection, udpAddress, data } = frame;
    const { id, status } = metadata;

    switch (status) {
      case MuxStatus.New:
        // handleNewConnection 是同步的，内部启动异步连接处理
        this.handleNewConnection(id, newConnection!, data);
        break;

      case MuxStatus.Keep:
        await this.handleKeepConnection(id, data, udpAddress);
        break;

      case MuxStatus.End:
        await this.handleEndConnection(id, data);
        break;

      case MuxStatus.KeepAlive:
        // KeepAlive 帧，丢弃数据（如果有）
        break;
    }
  }

  /**
   * 处理新建子连接
   */
  private handleNewConnection(
    id: number,
    conn: NonNullable<MuxFrame['newConnection']>,
    data?: Uint8Array
  ): void {
    // TCP 连接需要检查子请求限制
    if (conn.network === MuxNetwork.TCP) {
      // 检查是否已达到子请求上限
      if (this.limitReached || this.totalTCPConnections >= MAX_SUBREQUESTS) {
        this.limitReached = true;
        this.log(`Mux New REJECTED (limit): id=${id}, ${conn.address}:${conn.port}, total=${this.totalTCPConnections}/${MAX_SUBREQUESTS}`);
        // 直接发送 End 帧拒绝连接
        this.sendEndFrame(id);
        return;
      }

      // 增加计数（在创建连接前计数，防止并发问题）
      this.totalTCPConnections++;
      this.log(`Mux New: id=${id}, ${conn.address}:${conn.port} [${this.totalTCPConnections}/${MAX_SUBREQUESTS}]`);
    } else {
      this.log(`Mux New (UDP): id=${id}, ${conn.address}:${conn.port}`);
    }

    // 创建子连接记录 - 先添加到 Map，再处理连接
    const subConn: SubConnection = {
      id,
      address: conn.address,
      port: conn.port,
      network: conn.network,
      closed: false,
      createdAt: Date.now(),
      ready: false,
      pendingData: [],
    };
    
    // 先添加到 Map，确保回调中能找到
    this.connections.set(id, subConn);

    if (conn.network === MuxNetwork.TCP) {
      // TCP 连接 - 使用 Promise 链式调用，不阻塞当前执行
      this.handleTCPSubConnection(subConn, data).catch(err => {
        this.log(`TCP sub error id=${id}: ${err}`);
      });
    } else {
      // UDP 连接（主要用于 DNS）
      this.handleUDPSubConnection(subConn, data).catch(err => {
        this.log(`UDP sub error id=${id}: ${err}`);
      });
    }
  }

  /**
   * 处理 TCP 子连接
   * 使用 Promise 链式调用确保不阻塞事件循环
   */
  private async handleTCPSubConnection(
    subConn: SubConnection,
    initialData?: Uint8Array
  ): Promise<void> {
    try {
      // 建立 TCP 连接 - connect() 本身是同步的，立即返回 Socket 对象
      const tcpSocket: Socket = connect({
        hostname: subConn.address,
        port: subConn.port,
      });

      subConn.socket = tcpSocket;
      
      // 等待连接建立（带超时，3秒快速失败）
      // 使用 createTimeoutPromise 确保在 Workers 中超时可靠
      try {
        await Promise.race([
          tcpSocket.opened,
          createTimeoutPromise(3000)
        ]);
      } catch (connectError) {
        this.log(`TCP connect error id=${subConn.id}: ${connectError}`);
        this.sendEndFrame(subConn.id);
        subConn.closed = true;
        // 尝试关闭 socket
        try {
          tcpSocket.close();
        } catch {}
        return;
      }
      
      // 获取并保持 writer 锁定，避免并发写入问题
      subConn.writer = tcpSocket.writable.getWriter();
      
      // 标记连接就绪
      subConn.ready = true;

      // 写入初始数据
      if (initialData && initialData.length > 0 && !subConn.closed) {
        try {
          await subConn.writer.write(initialData);
        } catch {
          // 忽略写入错误
        }
      }
      
      // 发送所有待发送数据（在连接建立期间收到的 Keep 帧数据）
      while (subConn.pendingData.length > 0 && !subConn.closed) {
        const pendingChunk = subConn.pendingData.shift()!;
        try {
          if (!subConn.closed) {
            await subConn.writer.write(pendingChunk);
          }
        } catch {
          // 忽略写入错误，可能是连接已关闭
          break;
        }
      }

      // 从远程读取数据并发送到 WebSocket（非阻塞）
      this.pipeRemoteToWebSocket(subConn.id, tcpSocket);

    } catch (error) {
      this.log(`TCP error id=${subConn.id}: ${error}`);
      this.sendEndFrame(subConn.id);
      subConn.closed = true;
    }
  }

  /**
   * 处理 UDP 子连接（DNS）
   */
  private async handleUDPSubConnection(
    subConn: SubConnection,
    data?: Uint8Array
  ): Promise<void> {
    if (!data || data.length === 0) {
      return;
    }

    // 目前仅支持 DNS（端口 53）
    if (subConn.port !== 53) {
      this.log(`UDP only supports DNS (port 53), got port ${subConn.port}`);
      this.sendEndFrame(subConn.id);
      return;
    }

    await this.handleDNSQuery(subConn.id, data);
  }

  /**
   * 处理 DNS 查询
   */
  private async handleDNSQuery(id: number, dnsQuery: Uint8Array): Promise<void> {
    try {
      // 创建带超时的 AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.dnsServer, {
        method: 'POST',
        headers: {
          'content-type': 'application/dns-message',
        },
        body: dnsQuery,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const dnsResult = await response.arrayBuffer();
      
      // 构建并发送响应
      const responseData = new Uint8Array(dnsResult);
      this.sendDataToWebSocket(id, responseData);
      
      this.log(`DNS query success, response size: ${dnsResult.byteLength}`);
    } catch (error) {
      this.log(`DNS query error: ${error}`);
    }
  }

  /**
   * 处理保持子连接（传输数据）
   */
  private async handleKeepConnection(
    id: number,
    data?: Uint8Array,
    _udpAddress?: MuxFrame['udpAddress']
  ): Promise<void> {
    const subConn = this.connections.get(id);
    if (!subConn || subConn.closed) {
      return;
    }

    if (data && data.length > 0 && !subConn.closed) {
      if (subConn.network === MuxNetwork.TCP) {
        if (subConn.ready && subConn.writer) {
          // 连接已就绪，直接发送数据
          try {
            // 再次检查是否关闭（避免竞态）
            if (!subConn.closed) {
              await subConn.writer.write(data);
            }
          } catch (error) {
            // 只在非关闭错误时记录
            if (!subConn.closed) {
              this.log(`TCP write error id=${id}: ${error}`);
              this.closeSubConnection(id);
            }
          }
        } else {
          // 连接未就绪，将数据加入队列
          subConn.pendingData.push(data);
        }
      } else if (subConn.network === MuxNetwork.UDP) {
        // UDP 数据（DNS）
        await this.handleDNSQuery(id, data);
      }
    }
  }

  /**
   * 处理关闭子连接
   */
  private async handleEndConnection(id: number, data?: Uint8Array): Promise<void> {
    this.log(`Mux End: id=${id}`);

    const subConn = this.connections.get(id);
    if (!subConn) {
      return;
    }

    // 如果有最后的数据，先发送
    if (data && data.length > 0 && subConn.writer && subConn.ready && !subConn.closed) {
      try {
        await subConn.writer.write(data);
      } catch {
        // 忽略错误
      }
    }

    this.closeSubConnection(id);
  }

  /**
   * 关闭子连接
   */
  private closeSubConnection(id: number): void {
    const subConn = this.connections.get(id);
    if (!subConn) {
      return;
    }

    subConn.closed = true;

    // 释放 writer 并关闭 socket
    if (subConn.writer) {
      try {
        subConn.writer.releaseLock();
      } catch {
        // 忽略错误
      }
    }

    if (subConn.socket) {
      try {
        subConn.socket.close();
      } catch {
        // 忽略关闭错误
      }
    }

    this.connections.delete(id);
  }

  /**
   * 将远程 Socket 数据管道到 WebSocket
   */
  private pipeRemoteToWebSocket(id: number, socket: Socket): void {
    socket.readable
      .pipeTo(
        new WritableStream({
          write: (chunk: Uint8Array) => {
            this.sendDataToWebSocket(id, chunk);
          },
          close: () => {
            this.sendEndFrame(id);
            this.connections.delete(id);
          },
          abort: () => {
            this.sendEndFrame(id);
            this.connections.delete(id);
          },
        })
      )
      .catch(() => {
        // 忽略管道错误
      });
  }

  /**
   * 发送数据到 WebSocket
   */
  private sendDataToWebSocket(id: number, data: Uint8Array): void {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) {
      this.log(`Mux Skip send id=${id}: WebSocket not open`);
      return;
    }

    // 构建 Keep 帧
    const frame = buildMuxKeepFrame(id, data);
    // this.log(`Mux Send Keep: id=${id}, dataLen=${data.length}, frameLen=${frame.length}`);

    // 第一次发送需要附加响应头
    if (!this.headerSent) {
      const combined = new Uint8Array(this.responseHeader.length + frame.length);
      combined.set(this.responseHeader);
      combined.set(frame, this.responseHeader.length);
      this.webSocket.send(combined);
      this.headerSent = true;
    } else {
      this.webSocket.send(frame);
    }
  }

  /**
   * 发送 End 帧
   */
  private sendEndFrame(id: number): void {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) {
      return;
    }

    const frame = buildMuxEndFrame(id);
    
    if (!this.headerSent) {
      const combined = new Uint8Array(this.responseHeader.length + frame.length);
      combined.set(this.responseHeader);
      combined.set(frame, this.responseHeader.length);
      this.webSocket.send(combined);
      this.headerSent = true;
    } else {
      this.webSocket.send(frame);
    }
  }

  /**
   * 关闭会话
   */
  close(): void {
    // 关闭所有子连接
    for (const [id] of this.connections) {
      this.closeSubConnection(id);
    }
    this.connections.clear();

    // 安全关闭 WebSocket
    safeCloseWebSocket(this.webSocket);
  }

  /**
   * 获取活动连接数
   */
  get activeConnections(): number {
    return this.connections.size;
  }

  /**
   * 获取已创建的 TCP 连接总数
   */
  get totalTCPConnectionCount(): number {
    return this.totalTCPConnections;
  }

  /**
   * 检查是否已达到子请求上限
   */
  get isLimitReached(): boolean {
    return this.limitReached;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Mux 会话
 */
export function createMuxSession(options: MuxSessionOptions): MuxSession {
  return new MuxSession(options);
}
