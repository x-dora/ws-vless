/**
 * 协议头解析模块
 * 实现代理协议的头部解析
 */

import type { HeaderResult } from '../types';
import { AddressType, ProxyCommand } from '../types';
import { stringify } from '../utils/uuid';
import { isMuxConnection } from './mux';

// ============================================================================
// 协议常量
// ============================================================================

/**
 * 读取协议命令前的最小长度
 * 版本(1) + UUID(16) + 附加信息长度(1) + 命令(1)
 */
const MIN_COMMAND_HEADER_LENGTH = 19;

/**
 * 统一的短包错误信息
 * 用于分片/流式读取时提示继续累积数据
 */
const BUFFER_TOO_SHORT_MESSAGE = 'Invalid data: buffer too short';

/**
 * UUID 字段位置
 */
const UUID_START = 1;
const UUID_END = 17;

/**
 * 附加信息长度字段位置
 */
const OPT_LENGTH_INDEX = 17;

// ============================================================================
// UUID 验证器类型
// ============================================================================

/**
 * UUID 验证器函数类型
 * 接受一个 UUID 字符串，返回是否有效
 */
export type UUIDValidator = (uuid: string) => boolean;

/**
 * 创建基于 UUID 列表的验证器
 * @param validUUIDs 有效的 UUID 列表
 * @returns UUID 验证器函数
 */
export function createUUIDValidator(validUUIDs: string[]): UUIDValidator {
  // 使用 Set 提高查找效率，统一转换为小写
  const uuidSet = new Set(validUUIDs.map((uuid) => uuid.toLowerCase()));
  return (uuid: string) => uuidSet.has(uuid.toLowerCase());
}

/**
 * 创建单 UUID 验证器
 * @param userID 用户 UUID
 * @returns UUID 验证器函数
 */
export function createSingleUUIDValidator(userID: string): UUIDValidator {
  const normalizedID = userID.toLowerCase();
  return (uuid: string) => uuid.toLowerCase() === normalizedID;
}

// ============================================================================
// 协议解析
// ============================================================================

/**
 * 解析协议头
 * @param buffer 接收到的二进制数据
 * @param validateUUID UUID 验证器函数，验证 UUID 是否有效
 * @returns HeaderResult 解析结果
 */
export function processHeader(buffer: ArrayBuffer, validateUUID: UUIDValidator): HeaderResult {
  const bytes = new Uint8Array(buffer);

  // 至少需要读取到 command 字段
  if (bytes.byteLength < MIN_COMMAND_HEADER_LENGTH) {
    return {
      hasError: true,
      message: BUFFER_TOO_SHORT_MESSAGE,
    };
  }

  // 提取协议版本（第一个字节）
  const version = bytes.subarray(0, 1);

  // 提取并验证 UUID
  const receivedUUID = stringify(bytes.subarray(UUID_START, UUID_END));
  if (!validateUUID(receivedUUID)) {
    return {
      hasError: true,
      message: 'Invalid user: UUID not authorized',
    };
  }

  // 读取附加信息长度（当前跳过附加信息）
  const optLength = bytes[OPT_LENGTH_INDEX];

  // 读取命令类型
  const commandIndex = 18 + optLength;
  if (bytes.byteLength < commandIndex + 1) {
    return {
      hasError: true,
      message: BUFFER_TOO_SHORT_MESSAGE,
    };
  }
  const command = bytes[commandIndex];

  // 验证命令类型
  let isUDP = false;
  let isMux = false;

  if (command === ProxyCommand.TCP) {
    // TCP 命令
  } else if (command === ProxyCommand.UDP) {
    isUDP = true;
  } else if (command === ProxyCommand.MUX) {
    isMux = true;
  } else {
    return {
      hasError: true,
      message: `Unsupported command: ${command}. Supported: TCP(0x01), UDP(0x02), MUX(0x03).`,
    };
  }

  // MUX 命令的特殊处理：后面直接是 Mux 帧数据，不需要解析端口和地址
  if (isMux) {
    return {
      hasError: false,
      addressRemote: 'mux.cool',
      addressType: AddressType.Domain,
      portRemote: 0,
      rawDataIndex: commandIndex + 1, // Mux 帧紧跟在 command 之后
      protocolVersion: version,
      isUDP: false,
      isMux: true,
      userUUID: receivedUUID,
    };
  }

  // 读取端口（大端序）
  const portIndex = commandIndex + 1;
  if (bytes.byteLength < portIndex + 2) {
    return {
      hasError: true,
      message: BUFFER_TOO_SHORT_MESSAGE,
    };
  }
  const portRemote = (bytes[portIndex] << 8) | bytes[portIndex + 1];

  // 读取地址
  const addressTypeIndex = portIndex + 2;
  const addressResult = parseAddress(bytes, addressTypeIndex);
  if (addressResult.hasError) {
    return addressResult;
  }

  const { addressValue, addressType, endIndex } = addressResult;
  if (!addressValue || addressType === undefined || endIndex === undefined) {
    return {
      hasError: true,
      message: 'Invalid address parse result',
    };
  }

  // 检测是否为 Mux.Cool 连接（通过地址判断，例如目标是 v1.mux.cool）
  if (isMuxConnection(addressValue)) {
    isMux = true;
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: endIndex,
    protocolVersion: version,
    isUDP,
    isMux,
    userUUID: receivedUUID,
  };
}

// ============================================================================
// 地址解析
// ============================================================================

/**
 * 地址解析结果
 */
interface AddressParseResult {
  hasError: boolean;
  message?: string;
  addressValue?: string;
  addressType?: number;
  endIndex?: number;
}

/**
 * 解析协议中的地址字段
 * @param buffer 协议数据
 * @param startIndex 地址字段起始位置
 * @returns AddressParseResult 解析结果
 */
function parseAddress(buffer: Uint8Array, startIndex: number): AddressParseResult {
  if (buffer.byteLength < startIndex + 1) {
    return {
      hasError: true,
      message: BUFFER_TOO_SHORT_MESSAGE,
    };
  }

  const addressTypeByte = buffer[startIndex];
  const addressValueIndex = startIndex + 1;

  let addressLength = 0;
  let addressValue = '';

  switch (addressTypeByte) {
    case AddressType.IPv4:
      // IPv4: 4 字节，格式如 192.168.1.1
      addressLength = 4;
      if (buffer.byteLength < addressValueIndex + addressLength) {
        return {
          hasError: true,
          message: BUFFER_TOO_SHORT_MESSAGE,
        };
      }
      addressValue = buffer
        .subarray(addressValueIndex, addressValueIndex + addressLength)
        .join('.');
      break;

    case AddressType.Domain: {
      // 域名: 第一个字节是长度，后面是域名字符串
      if (buffer.byteLength < addressValueIndex + 1) {
        return {
          hasError: true,
          message: BUFFER_TOO_SHORT_MESSAGE,
        };
      }
      addressLength = buffer[addressValueIndex];
      const domainStartIndex = addressValueIndex + 1;
      if (buffer.byteLength < domainStartIndex + addressLength) {
        return {
          hasError: true,
          message: BUFFER_TOO_SHORT_MESSAGE,
        };
      }
      addressValue = new TextDecoder().decode(
        buffer.subarray(domainStartIndex, domainStartIndex + addressLength),
      );
      // 域名的实际结束位置需要额外加1（长度字节）
      return {
        hasError: false,
        addressValue,
        addressType: addressTypeByte,
        endIndex: domainStartIndex + addressLength,
      };
    }

    case AddressType.IPv6: {
      // IPv6: 16 字节，格式如 2001:0db8:85a3:0000:0000:8a2e:0370:7334
      addressLength = 16;
      if (buffer.byteLength < addressValueIndex + addressLength) {
        return {
          hasError: true,
          message: BUFFER_TOO_SHORT_MESSAGE,
        };
      }
      const dataView = new DataView(
        buffer.buffer,
        buffer.byteOffset + addressValueIndex,
        addressLength,
      );
      const ipv6Parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6Parts.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6Parts.join(':');
      break;
    }

    default:
      return {
        hasError: true,
        message: `Invalid address type: ${addressTypeByte}`,
      };
  }

  // 验证地址值
  if (!addressValue) {
    return {
      hasError: true,
      message: `Empty address value for type ${addressTypeByte}`,
    };
  }

  return {
    hasError: false,
    addressValue,
    addressType: addressTypeByte,
    endIndex: addressValueIndex + addressLength,
  };
}

// ============================================================================
// 响应头构建
// ============================================================================

/**
 * 创建协议响应头
 * @param version 协议版本
 * @returns 2 字节的响应头
 */
export function createResponseHeader(version: Uint8Array): Uint8Array {
  // 响应格式: [版本, 附加信息长度(0)]
  return new Uint8Array([version[0], 0]);
}
