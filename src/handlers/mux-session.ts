/**
 * Mux 会话管理模块
 * 管理 Mux.Cool 多路复用连接中的所有子连接
 * 
 * 参考 Xray-core 的 mux 实现优化：
 * - 分块写入（8KB 块）
 * - 写入队列防止并发问题
 * - 更好的会话统计
 * - KeepAlive 心跳支持
 */

// @ts-ignore - Cloudflare Workers 特有模块
import { connect } from 'cloudflare:sockets';

import type { ConnLogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import {
  MuxStatus,
  MuxNetwork,
  MuxOption,
  parseMuxFrame,
  buildMuxKeepFrame,
  buildMuxEndFrame,
  buildMuxKeepAliveFrame,
  type MuxFrame,
  type SubConnection,
} from '../core/mux';
import { safeCloseWebSocket } from '../utils/_websocket';
import { DEFAULT_DNS_SERVER } from '../config';

// ============================================================================
// 常量配置
// ============================================================================

/**
 * Cloudflare Workers 子请求限制
 * - 免费计划：50 个子请求/请求
 * - 付费计划：1000 个子请求/请求
 */
const MAX_SUBREQUESTS = 48;

/**
 * 最大数据块大小（参考 Xray 的 8KB）
 */
const MAX_CHUNK_SIZE = 8 * 1024;

/**
 * 写入队列最大长度
 */
const MAX_WRITE_QUEUE = 100;

/**
 * 连接超时时间（毫秒）
 */
const CONNECT_TIMEOUT_MS = 3000;

/**
 * DNS 查询超时时间（毫秒）
 */
const DNS_TIMEOUT_MS = 5000;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建可靠的超时 Promise（兼容 Cloudflare Workers）
 */
function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    // @ts-ignore - scheduler 是 Cloudflare Workers 全局对象
    if (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function') {
      // @ts-ignore
      scheduler.wait(ms).then(() => reject(new Error('Connect timeout')));
    } else {
      setTimeout(() => reject(new Error('Connect timeout')), ms);
    }
  });
}

/**
 * 将数据分割成指定大小的块（零拷贝版本）
 * 使用 subarray 返回原数组的视图，避免数据拷贝
 */
function* splitIntoChunks(data: Uint8Array, chunkSize: number): Generator<Uint8Array> {
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    yield data.subarray(offset, end);
    offset = end;
  }
}

// ============================================================================
// 写入队列（参考 Xray 的 Writer 设计）
// ============================================================================

/**
 * WebSocket 写入队列（优化版）
 * 确保帧按顺序发送，避免并发写入问题
 * 
 * 优化：使用索引代替 shift()，避免数组元素移动开销
 */
class WriteQueue {
  private queue: Uint8Array[] = [];
  private head = 0; // 队列头索引
  private processing = false;
  private webSocket: WebSocket;
  private responseHeader: Uint8Array;
  private headerSent = false;

  constructor(webSocket: WebSocket, responseHeader: Uint8Array) {
    this.webSocket = webSocket;
    this.responseHeader = responseHeader;
  }

  /**
   * 将数据加入发送队列
   */
  enqueue(data: Uint8Array): boolean {
    const effectiveLength = this.queue.length - this.head;
    if (effectiveLength >= MAX_WRITE_QUEUE) {
      return false; // 队列满了
    }
    this.queue.push(data);
    this.processQueue();
    return true;
  }

  /**
   * 处理发送队列
   */
  private processQueue(): void {
    if (this.processing || this.head >= this.queue.length) {
      return;
    }

    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) {
      this.queue = [];
      this.head = 0;
      return;
    }

    this.processing = true;

    while (this.head < this.queue.length) {
      const data = this.queue[this.head++];
      
      try {
        if (!this.headerSent) {
          // 第一次发送需要附加响应头
          const combined = new Uint8Array(this.responseHeader.length + data.length);
          combined.set(this.responseHeader);
          combined.set(data, this.responseHeader.length);
          this.webSocket.send(combined);
          this.headerSent = true;
        } else {
          this.webSocket.send(data);
        }
      } catch {
        // 发送失败，停止处理
        break;
      }
    }

    // 定期压缩队列，避免内存泄漏
    if (this.head > 64 && this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
    }

    this.processing = false;
  }

  get isHeaderSent(): boolean {
    return this.headerSent;
  }
}

// ============================================================================
// 会话统计（参考 Xray 的 SessionManager）
// ============================================================================

/**
 * 会话统计信息
 */
export interface SessionStats {
  /** 累计创建的 TCP 连接数 */
  totalTCPConnections: number;
  /** 累计创建的 UDP 连接数 */
  totalUDPConnections: number;
  /** 当前活跃连接数 */
  activeConnections: number;
  /** 已发送的字节数 */
  bytesSent: number;
  /** 已接收的字节数 */
  bytesReceived: number;
  /** 是否达到子请求上限 */
  limitReached: boolean;
  /** 会话开始时间 */
  startTime: number;
  /** 最后活动时间 */
  lastActivityTime: number;
}

// ============================================================================
// Mux 会话配置
// ============================================================================

export interface MuxSessionOptions {
  webSocket: WebSocket;
  responseHeader: Uint8Array;
  log: ConnLogFunction;
  proxyIP?: string;
  dnsServer?: string;
  timeout?: number;
  /** 最大子请求数（默认 48） */
  maxSubrequests?: number;
}

// ============================================================================
// Mux 会话管理器
// ============================================================================

/**
 * Mux 会话管理器
 * 参考 Xray-core 的 ServerWorker 设计
 */
export class MuxSession {
  // 子连接管理
  private connections: Map<number, SubConnection> = new Map();
  
  /**
   * 已结束的会话 ID 集合
   * 用于防止对同一个已关闭会话重复发送 End 帧
   * 参考 Xray 的 Session.closed 标志，但适配已从 Map 删除的场景
   */
  private endedSessions: Set<number> = new Set();
  
  /** 已结束会话集合的最大容量，防止内存泄漏 */
  private static readonly MAX_ENDED_SESSIONS = 256;
  
  // WebSocket 相关
  private webSocket: WebSocket;
  private writeQueue: WriteQueue;
  private log: ConnLogFunction;
  
  // 配置
  private proxyIP?: string;
  private dnsServer: string;
  private timeout: number;
  private maxSubrequests: number;
  
  // 缓冲区
  private buffer: Uint8Array = new Uint8Array(0);
  
  // 统计信息
  private stats: SessionStats;
  
  // 状态标记
  private closed = false;

  constructor(options: MuxSessionOptions) {
    this.webSocket = options.webSocket;
    this.writeQueue = new WriteQueue(options.webSocket, options.responseHeader);
    this.log = options.log;
    this.proxyIP = options.proxyIP;
    this.dnsServer = options.dnsServer || DEFAULT_DNS_SERVER;
    this.timeout = options.timeout || 300000;
    this.maxSubrequests = options.maxSubrequests || MAX_SUBREQUESTS;
    
    // 初始化统计
    this.stats = {
      totalTCPConnections: 0,
      totalUDPConnections: 0,
      activeConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      limitReached: false,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
    };
  }

  // ==========================================================================
  // 数据处理（零拷贝优化版）
  // ==========================================================================

  /**
   * 处理传入的 Mux 数据
   * 
   * 优化策略：
   * 1. 如果没有缓冲数据，直接在原数组上解析，避免任何拷贝
   * 2. 只在必要时（有未完整帧）才进行缓冲区合并
   * 3. 使用 parseMuxFrame 的 offset 参数避免 slice
   */
  async processData(data: ArrayBuffer): Promise<void> {
    if (this.closed) return;
    
    this.stats.bytesReceived += data.byteLength;
    this.stats.lastActivityTime = Date.now();
    
    const incoming = new Uint8Array(data);
    
    // 优化：如果没有缓冲数据，直接在 incoming 上解析
    let bytes: Uint8Array;
    if (this.buffer.length === 0) {
      bytes = incoming;
    } else {
      // 只在必要时合并缓冲区
      bytes = new Uint8Array(this.buffer.length + incoming.length);
      bytes.set(this.buffer, 0);
      bytes.set(incoming, this.buffer.length);
      this.buffer = new Uint8Array(0); // 清空旧缓冲区
    }
    
    // 解析帧 - 直接在原数组上使用 offset，避免 slice
    let offset = 0;
    const totalLength = bytes.length;
    const frames: MuxFrame[] = [];
    let maxIterations = 1000;

    while (offset < totalLength && maxIterations-- > 0) {
      const remainingLength = totalLength - offset;
      if (remainingLength < 2) break;
      
      // 直接传入 offset，避免创建新数组
      const result = parseMuxFrame(bytes, offset, remainingLength);
      
      if (result.hasError) {
        if (result.message?.includes('Incomplete') || result.message?.includes('too short')) {
          break;
        }
        this.log.warn(`Mux parse error: ${result.message}`);
        break;
      }

      const { frame } = result;
      if (frame.frameLength <= 0) {
        this.log.warn(`Mux invalid frameLength: ${frame.frameLength}`);
        break;
      }
      
      frames.push(frame);
      offset += frame.frameLength;
    }

    // 保留未处理的数据（只在有剩余时才拷贝）
    if (offset < totalLength) {
      this.buffer = bytes.slice(offset);
    }
    
    // 处理所有帧
    for (const frame of frames) {
      this.handleFrame(frame).catch(err => {
        this.log.error(`Mux handleFrame error: ${err}`);
      });
    }
  }

  // ==========================================================================
  // 帧处理（参考 Xray 的 handleFrame）
  // ==========================================================================
  
  private async handleFrame(frame: MuxFrame): Promise<void> {
    const { metadata, newConnection, udpAddress, data } = frame;
    const { id, status } = metadata;

    switch (status) {
      case MuxStatus.New:
        this.handleNewConnection(id, newConnection!, data);
        break;

      case MuxStatus.Keep:
        await this.handleKeepConnection(id, data, udpAddress);
        break;

      case MuxStatus.End:
        await this.handleEndConnection(id, data);
        break;

      case MuxStatus.KeepAlive:
        // 参考 Xray：丢弃 KeepAlive 数据
        this.stats.lastActivityTime = Date.now();
        break;
    }
  }

  // ==========================================================================
  // 新建连接（参考 Xray 的 handleStatusNew）
  // ==========================================================================

  private handleNewConnection(
    id: number,
    conn: NonNullable<MuxFrame['newConnection']>,
    data?: Uint8Array
  ): void {
    const isTCP = conn.network === MuxNetwork.TCP;
    
    // 新连接：从已结束集合中移除（ID 可能被复用）
    this.endedSessions.delete(id);
    
    // 检查子请求限制
    if (isTCP) {
      if (this.stats.limitReached || this.stats.totalTCPConnections >= this.maxSubrequests) {
        this.stats.limitReached = true;
        this.log.warn(`Mux REJECTED: id=${id}, ${conn.address}:${conn.port} [limit: ${this.stats.totalTCPConnections}/${this.maxSubrequests}]`);
        this.sendEndFrame(id);
        this.markSessionEnded(id);
        return;
      }
      this.stats.totalTCPConnections++;
      this.log.debug(`Mux New: id=${id}, ${conn.address}:${conn.port} [${this.stats.totalTCPConnections}/${this.maxSubrequests}]`);
    } else {
      this.stats.totalUDPConnections++;
      this.log.debug(`Mux New (UDP): id=${id}, ${conn.address}:${conn.port}`);
    }

    // 创建子连接
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
    
    this.connections.set(id, subConn);
    this.stats.activeConnections = this.connections.size;

    // 异步处理连接
    if (isTCP) {
      this.handleTCPSubConnection(subConn, data).catch(err => {
        this.log.error(`TCP error id=${id}: ${err}`);
      });
    } else {
      this.handleUDPSubConnection(subConn, data).catch(err => {
        this.log.error(`UDP error id=${id}: ${err}`);
      });
    }
  }

  // ==========================================================================
  // TCP 子连接处理（优化版）
  // ==========================================================================

  private async handleTCPSubConnection(
    subConn: SubConnection,
    initialData?: Uint8Array
  ): Promise<void> {
    try {
      const tcpSocket: Socket = connect({
        hostname: subConn.address,
        port: subConn.port,
      });

      subConn.socket = tcpSocket;
      
      // 等待连接（带超时）
      try {
        await Promise.race([
          tcpSocket.opened,
          createTimeoutPromise(CONNECT_TIMEOUT_MS)
        ]);
      } catch (error) {
        this.log.warn(`TCP connect error id=${subConn.id}: ${error}`);
        this.sendEndFrame(subConn.id);
        subConn.closed = true;
        try { tcpSocket.close(); } catch {}
        this.removeConnection(subConn.id);
        return;
      }
      
      subConn.writer = tcpSocket.writable.getWriter();
      subConn.ready = true;

      // 写入初始数据（分块）
      if (initialData && initialData.length > 0 && !subConn.closed) {
        await this.writeToSocket(subConn, initialData);
      }
      
      // 发送待处理数据
      while (subConn.pendingData.length > 0 && !subConn.closed) {
        const pendingChunk = subConn.pendingData.shift()!;
        await this.writeToSocket(subConn, pendingChunk);
      }

      // 管道远程数据到 WebSocket
      this.pipeRemoteToWebSocket(subConn.id, tcpSocket);

    } catch (error) {
      this.log.error(`TCP error id=${subConn.id}: ${error}`);
      this.sendEndFrame(subConn.id);
      subConn.closed = true;
      this.removeConnection(subConn.id);
    }
  }

  /**
   * 写入数据到 Socket（分块写入，参考 Xray 的 8KB 分块）
   */
  private async writeToSocket(subConn: SubConnection, data: Uint8Array): Promise<void> {
    if (!subConn.writer || subConn.closed) return;
    
    try {
      // 大数据分块发送
      if (data.length > MAX_CHUNK_SIZE) {
        for (const chunk of splitIntoChunks(data, MAX_CHUNK_SIZE)) {
          if (subConn.closed) break;
          await subConn.writer.write(chunk);
        }
      } else {
        await subConn.writer.write(data);
      }
    } catch (error) {
      if (!subConn.closed) {
        throw error;
      }
    }
  }

  // ==========================================================================
  // UDP 子连接处理
  // ==========================================================================

  private async handleUDPSubConnection(
    subConn: SubConnection,
    data?: Uint8Array
  ): Promise<void> {
    if (!data || data.length === 0) return;

    if (subConn.port !== 53) {
      this.log.warn(`UDP only supports DNS (port 53), got ${subConn.port}`);
      this.sendEndFrame(subConn.id);
      this.removeConnection(subConn.id);
      return;
    }

    await this.handleDNSQuery(subConn.id, data);
  }

  private async handleDNSQuery(id: number, dnsQuery: Uint8Array): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
      
      const response = await fetch(this.dnsServer, {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: dnsQuery,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const dnsResult = await response.arrayBuffer();
      
      this.sendDataToWebSocket(id, new Uint8Array(dnsResult));
      this.log.debug(`DNS success: ${dnsResult.byteLength} bytes`);
    } catch (error) {
      this.log.error(`DNS error: ${error}`);
    }
  }

  // ==========================================================================
  // Keep 连接处理（参考 Xray 的 handleStatusKeep）
  // ==========================================================================

  private async handleKeepConnection(
    id: number,
    data?: Uint8Array,
    _udpAddress?: MuxFrame['udpAddress']
  ): Promise<void> {
    const subConn = this.connections.get(id);
    
    // 参考 Xray：未找到会话时发送关闭帧通知对端
    // 但需要防止重复发送，避免"乒乓效应"导致日志爆炸
    if (!subConn) {
      if (!this.endedSessions.has(id)) {
        this.markSessionEnded(id);
        this.sendEndFrame(id);
      }
      // 如果已经发送过 End 帧，静默丢弃数据（参考 Xray 的 buf.Discard）
      return;
    }
    
    if (subConn.closed) return;

    if (data && data.length > 0) {
      if (subConn.network === MuxNetwork.TCP) {
        if (subConn.ready && subConn.writer) {
          try {
            await this.writeToSocket(subConn, data);
          } catch (error) {
            if (!subConn.closed) {
              this.log.error(`TCP write error id=${id}: ${error}`);
              this.closeSubConnection(id);
            }
          }
        } else {
          // 连接未就绪，加入队列
          subConn.pendingData.push(data);
        }
      } else if (subConn.network === MuxNetwork.UDP) {
        await this.handleDNSQuery(id, data);
      }
    }
  }

  // ==========================================================================
  // End 连接处理（参考 Xray 的 handleStatusEnd）
  // ==========================================================================

  private async handleEndConnection(id: number, data?: Uint8Array): Promise<void> {
    const subConn = this.connections.get(id);
    
    // 只有会话存在时才打印日志和处理，避免重复日志
    // 参考 Xray 的 handleStatusEnd：只在找到会话时才执行操作
    if (!subConn) {
      // 标记为已结束，防止后续 Keep 帧触发重复 End
      this.markSessionEnded(id);
      return;
    }

    this.log.debug(`Mux End: id=${id}`);

    // 先发送最后的数据
    if (data && data.length > 0 && subConn.writer && subConn.ready && !subConn.closed) {
      try {
        await this.writeToSocket(subConn, data);
      } catch {
        // 忽略
      }
    }

    this.closeSubConnection(id);
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  private closeSubConnection(id: number): void {
    const subConn = this.connections.get(id);
    if (!subConn) return;

    subConn.closed = true;

    if (subConn.writer) {
      try { subConn.writer.releaseLock(); } catch {}
    }

    if (subConn.socket) {
      try { subConn.socket.close(); } catch {}
    }

    this.removeConnection(id);
  }

  private removeConnection(id: number): void {
    this.connections.delete(id);
    this.stats.activeConnections = this.connections.size;
    // 标记为已结束，防止后续帧触发重复操作
    this.markSessionEnded(id);
  }

  /**
   * 标记会话为已结束
   * 用于防止对已关闭会话重复发送 End 帧
   */
  private markSessionEnded(id: number): void {
    // 如果集合过大，清理旧的条目防止内存泄漏
    if (this.endedSessions.size >= MuxSession.MAX_ENDED_SESSIONS) {
      // 简单策略：清空一半（实际生产环境可以用 LRU 等更复杂的策略）
      const entries = Array.from(this.endedSessions);
      const removeCount = Math.floor(entries.length / 2);
      for (let i = 0; i < removeCount; i++) {
        this.endedSessions.delete(entries[i]);
      }
    }
    this.endedSessions.add(id);
  }

  // ==========================================================================
  // 数据发送（使用写入队列）
  // ==========================================================================

  private pipeRemoteToWebSocket(id: number, socket: Socket): void {
    socket.readable
      .pipeTo(
        new WritableStream({
          write: (chunk: Uint8Array) => {
            // 大数据分块发送
            if (chunk.length > MAX_CHUNK_SIZE) {
              for (const subChunk of splitIntoChunks(chunk, MAX_CHUNK_SIZE)) {
                this.sendDataToWebSocket(id, subChunk);
              }
            } else {
              this.sendDataToWebSocket(id, chunk);
            }
          },
          close: () => {
            this.sendEndFrame(id);
            this.removeConnection(id);
          },
          abort: () => {
            this.sendEndFrame(id);
            this.removeConnection(id);
          },
        })
      )
      .catch(() => {});
  }

  private sendDataToWebSocket(id: number, data: Uint8Array): void {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) return;
    
    const frame = buildMuxKeepFrame(id, data);
    this.stats.bytesSent += frame.length;
    this.writeQueue.enqueue(frame);
  }

  private sendEndFrame(id: number): void {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) return;
    
    const frame = buildMuxEndFrame(id);
    this.writeQueue.enqueue(frame);
  }

  /**
   * 发送 KeepAlive 帧（心跳）
   */
  sendKeepAlive(): void {
    if (this.webSocket.readyState !== WS_READY_STATE.OPEN) return;
    
    const frame = buildMuxKeepAliveFrame();
    this.writeQueue.enqueue(frame);
  }

  // ==========================================================================
  // 公共接口
  // ==========================================================================

  /**
   * 关闭会话
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const [id] of this.connections) {
      this.closeSubConnection(id);
    }
    this.connections.clear();
    this.endedSessions.clear();
    this.stats.activeConnections = 0;

    safeCloseWebSocket(this.webSocket);
  }

  /**
   * 检查会话是否已关闭
   */
  get isClosed(): boolean {
    return this.closed;
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
    return this.stats.totalTCPConnections;
  }

  /**
   * 检查是否已达到子请求上限
   */
  get isLimitReached(): boolean {
    return this.stats.limitReached;
  }

  /**
   * 获取会话统计信息
   */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  /**
   * 检查会话是否空闲（可用于清理）
   * 参考 Xray 的 CloseIfNoSessionAndIdle
   */
  isIdle(maxIdleMs: number = 60000): boolean {
    return this.connections.size === 0 && 
           Date.now() - this.stats.lastActivityTime > maxIdleMs;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createMuxSession(options: MuxSessionOptions): MuxSession {
  return new MuxSession(options);
}
