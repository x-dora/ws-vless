/**
 * Mux.Cool 多路复用协议实现
 * 
 * 协议规范: https://xtls.github.io/development/protocols/muxcool.html
 * 
 * Mux.Cool 是一个多路复用传输协议，用于在一条已建立的数据流中传输多个独立的子连接。
 * 当主连接的目标地址为 "v1.mux.cool" 时，表示使用 Mux.Cool 协议。
 */

import { AddressType } from '../types';

// ============================================================================
// 协议常量
// ============================================================================

/**
 * Mux.Cool 协议标识地址
 * 当目标地址为此值时，表示使用 Mux.Cool 多路复用
 */
const MUX_COOL_ADDRESS: string = 'v1.mux.cool';

/**
 * Mux 状态码（命令类型）
 */
export const enum MuxStatus {
  /** 新建子连接 */
  New = 0x01,
  /** 保持子连接（传输数据） */
  Keep = 0x02,
  /** 关闭子连接 */
  End = 0x03,
  /** 保持主连接（心跳） */
  KeepAlive = 0x04,
}

/**
 * Mux 选项标志
 */
export const enum MuxOption {
  /** 有额外数据 */
  Data = 0x01,
}

/**
 * Mux 网络类型
 */
export const enum MuxNetwork {
  TCP = 0x01,
  UDP = 0x02,
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Mux 帧元数据
 */
export interface MuxMetadata {
  /** 子连接 ID */
  id: number;
  /** 命令状态 */
  status: MuxStatus;
  /** 选项标志 */
  option: number;
  /** 是否有数据 */
  hasData: boolean;
}

/**
 * Mux 新建连接信息
 */
export interface MuxNewConnection {
  /** 网络类型 (TCP/UDP) */
  network: MuxNetwork;
  /** 目标端口 */
  port: number;
  /** 地址类型 */
  addressType: AddressType;
  /** 目标地址 */
  address: string;
  /** Global ID (XUDP) - 可选 */
  globalId?: Uint8Array;
}

/**
 * Mux UDP 地址信息（Keep 帧中的 UDP 地址）
 */
export interface MuxUDPAddress {
  /** 网络类型 */
  network: MuxNetwork;
  /** 目标端口 */
  port: number;
  /** 地址类型 */
  addressType: AddressType;
  /** 目标地址 */
  address: string;
}

/**
 * Mux 帧解析结果
 */
export interface MuxFrame {
  /** 元数据 */
  metadata: MuxMetadata;
  /** 新建连接信息（仅 New 状态） */
  newConnection?: MuxNewConnection;
  /** UDP 地址（Keep 状态且为 UDP 时） */
  udpAddress?: MuxUDPAddress;
  /** 数据内容 */
  data?: Uint8Array;
  /** 帧总长度（用于确定下一帧位置） */
  frameLength: number;
}

/**
 * Mux 解析错误
 */
export interface MuxParseError {
  hasError: true;
  message: string;
}

/**
 * Mux 解析成功
 */
export interface MuxParseSuccess {
  hasError: false;
  frame: MuxFrame;
}

export type MuxParseResult = MuxParseError | MuxParseSuccess;

// ============================================================================
// 子连接状态管理
// ============================================================================

/**
 * 子连接状态
 */
export interface SubConnection {
  /** 子连接 ID */
  id: number;
  /** 目标地址 */
  address: string;
  /** 目标端口 */
  port: number;
  /** 网络类型 */
  network: MuxNetwork;
  /** TCP Socket（TCP 连接时） */
  socket?: Socket;
  /** TCP Writer（保持锁定状态避免并发问题） */
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  /** 是否已关闭 */
  closed: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 连接是否就绪（TCP 连接已建立） */
  ready: boolean;
  /** 待发送数据队列（连接建立前暂存） */
  pendingData: Uint8Array[];
}

// ============================================================================
// 协议解析
// ============================================================================

/**
 * 检测是否为 Mux.Cool 连接
 * @param address 目标地址
 * @returns 是否为 Mux 连接
 */
export function isMuxConnection(address: string): boolean {
  return address === MUX_COOL_ADDRESS;
}

/**
 * 解析 Mux 帧
 * @param buffer 数据缓冲区
 * @param offset 起始偏移（默认 0）
 * @returns 解析结果
 */
export function parseMuxFrame(buffer: ArrayBuffer, offset: number = 0): MuxParseResult {
  const view = new DataView(buffer, offset);
  const bytes = new Uint8Array(buffer, offset);

  // 检查最小长度（元数据长度字段 2 字节）
  if (bytes.length < 2) {
    return {
      hasError: true,
      message: 'Buffer too short for Mux frame',
    };
  }

  // 读取元数据长度
  const metadataLength = view.getUint16(0);
  
  // 检查是否有足够的元数据
  if (bytes.length < 2 + metadataLength) {
    return {
      hasError: true,
      message: 'Incomplete Mux metadata',
    };
  }

  // 至少需要 ID(2) + Status(1) + Option(1) = 4 字节元数据
  if (metadataLength < 4) {
    return {
      hasError: true,
      message: 'Mux metadata too short',
    };
  }

  // 解析基础元数据
  const id = view.getUint16(2);
  const status = bytes[4] as MuxStatus;
  const option = bytes[5];
  const hasData = (option & MuxOption.Data) !== 0;

  const metadata: MuxMetadata = { id, status, option, hasData };

  let frameLength = 2 + metadataLength;
  let newConnection: MuxNewConnection | undefined;
  let udpAddress: MuxUDPAddress | undefined;
  let data: Uint8Array | undefined;

  // 根据状态解析额外信息
  switch (status) {
    case MuxStatus.New: {
      // 新建连接：网络类型(1) + 端口(2) + 地址类型(1) + 地址 + GlobalID(8, XUDP)
      const network = bytes[6] as MuxNetwork;
      const port = view.getUint16(7);
      const addressType = bytes[9] as AddressType;
      
      const { address, length: addrLen } = parseAddress(bytes, 10, addressType);
      
      // XUDP Global ID（8 字节，如果有的话）
      let globalId: Uint8Array | undefined;
      const expectedMetaLen = 4 + 1 + 2 + 1 + addrLen + 8; // 基础 + 网络 + 端口 + 地址类型 + 地址 + GlobalID
      if (metadataLength >= expectedMetaLen - 4) { // 减去基础的4字节
        globalId = bytes.slice(10 + addrLen, 10 + addrLen + 8);
      }

      newConnection = { network, port, addressType, address, globalId };
      break;
    }

    case MuxStatus.Keep: {
      // UDP Keep 帧包含地址信息
      if (metadataLength > 4) {
        const network = bytes[6] as MuxNetwork;
        if (network === MuxNetwork.UDP) {
          const port = view.getUint16(7);
          const addressType = bytes[9] as AddressType;
          const { address } = parseAddress(bytes, 10, addressType);
          udpAddress = { network, port, addressType, address };
        }
      }
      break;
    }

    case MuxStatus.End:
    case MuxStatus.KeepAlive:
      // 这些状态不需要额外解析
      break;

    default:
      return {
        hasError: true,
        message: `Unknown Mux status: ${status}`,
      };
  }

  // 解析数据部分
  if (hasData) {
    // 数据格式: 长度(2) + 数据
    if (bytes.length < frameLength + 2) {
      return {
        hasError: true,
        message: 'Incomplete Mux data length',
      };
    }

    const dataView = new DataView(buffer, offset + frameLength);
    const dataLength = dataView.getUint16(0);
    
    if (bytes.length < frameLength + 2 + dataLength) {
      return {
        hasError: true,
        message: 'Incomplete Mux data',
      };
    }

    data = bytes.slice(frameLength + 2, frameLength + 2 + dataLength);
    frameLength += 2 + dataLength;
  }

  return {
    hasError: false,
    frame: {
      metadata,
      newConnection,
      udpAddress,
      data,
      frameLength,
    },
  };
}

/**
 * 解析地址
 */
function parseAddress(
  bytes: Uint8Array,
  offset: number,
  addressType: AddressType
): { address: string; length: number } {
  switch (addressType) {
    case AddressType.IPv4: {
      const address = Array.from(bytes.slice(offset, offset + 4)).join('.');
      return { address, length: 4 };
    }

    case AddressType.Domain: {
      const domainLength = bytes[offset];
      const address = new TextDecoder().decode(
        bytes.slice(offset + 1, offset + 1 + domainLength)
      );
      return { address, length: 1 + domainLength };
    }

    case AddressType.IPv6: {
      const parts: string[] = [];
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
      for (let i = 0; i < 8; i++) {
        parts.push(view.getUint16(i * 2).toString(16));
      }
      return { address: parts.join(':'), length: 16 };
    }

    default:
      return { address: '', length: 0 };
  }
}

// ============================================================================
// 帧构建
// ============================================================================

/**
 * 构建 Mux 帧
 * @param id 子连接 ID
 * @param status 状态
 * @param option 选项
 * @param metadata 额外元数据（新建连接信息等）
 * @param data 数据
 * @returns 构建的帧
 */
export function buildMuxFrame(
  id: number,
  status: MuxStatus,
  option: number,
  metadata?: Uint8Array,
  data?: Uint8Array
): Uint8Array {
  // 计算元数据长度
  const baseMetaLength = 4; // ID(2) + Status(1) + Option(1)
  const extraMetaLength = metadata?.length || 0;
  const metadataLength = baseMetaLength + extraMetaLength;

  // 计算总长度
  let totalLength = 2 + metadataLength; // 元数据长度字段 + 元数据
  if (data && data.length > 0) {
    totalLength += 2 + data.length; // 数据长度字段 + 数据
  }

  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);

  // 写入元数据长度
  view.setUint16(0, metadataLength);

  // 写入基础元数据
  view.setUint16(2, id);
  frame[4] = status;
  frame[5] = option;

  // 写入额外元数据
  if (metadata && metadata.length > 0) {
    frame.set(metadata, 6);
  }

  // 写入数据
  if (data && data.length > 0) {
    const dataOffset = 2 + metadataLength;
    view.setUint16(dataOffset, data.length);
    frame.set(data, dataOffset + 2);
  }

  return frame;
}

/**
 * 构建 Keep 响应帧（用于 TCP）
 * @param id 子连接 ID
 * @param data 数据
 * @returns 构建的帧
 */
export function buildMuxKeepFrame(id: number, data?: Uint8Array): Uint8Array {
  const hasData = data && data.length > 0;
  const option = hasData ? MuxOption.Data : 0;
  return buildMuxFrame(id, MuxStatus.Keep, option, undefined, data);
}

/**
 * 构建 End 帧
 * @param id 子连接 ID
 * @returns 构建的帧
 */
export function buildMuxEndFrame(id: number): Uint8Array {
  return buildMuxFrame(id, MuxStatus.End, 0);
}

/**
 * 构建 KeepAlive 帧
 * @returns 构建的帧
 */
export function buildMuxKeepAliveFrame(): Uint8Array {
  // ID 可为随机值
  const randomId = Math.floor(Math.random() * 65535);
  return buildMuxFrame(randomId, MuxStatus.KeepAlive, 0);
}
