/**
 * VLESS 协议头解析模块
 * 实现 VLESS 协议的头部解析
 * 
 * 协议规范参考:
 * - https://xtls.github.io/development/protocols/vless.html
 * - https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw
 */

import type { VlessHeaderResult } from '../types';
import { AddressType, VlessCommand } from '../types';
import { stringify } from '../utils/uuid';

// ============================================================================
// 协议常量
// ============================================================================

/**
 * VLESS 协议头最小长度
 * 版本(1) + UUID(16) + 附加信息长度(1) + 命令(1) + 端口(2) + 地址类型(1) = 22
 * 加上最小地址长度(1或4)，至少需要 24 字节
 */
const MIN_HEADER_LENGTH = 24;

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
  const uuidSet = new Set(validUUIDs.map(uuid => uuid.toLowerCase()));
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
 * 解析 VLESS 协议头
 * @param vlessBuffer 接收到的二进制数据
 * @param validateUUID UUID 验证器函数，验证 UUID 是否有效
 * @returns VlessHeaderResult 解析结果
 */
export function processVlessHeader(
  vlessBuffer: ArrayBuffer,
  validateUUID: UUIDValidator
): VlessHeaderResult {
  // 验证最小长度
  if (vlessBuffer.byteLength < MIN_HEADER_LENGTH) {
    return {
      hasError: true,
      message: 'Invalid data: buffer too short',
    };
  }

  // 提取协议版本（第一个字节）
  const version = new Uint8Array(vlessBuffer.slice(0, 1));

  // 提取并验证 UUID
  const receivedUUID = stringify(new Uint8Array(vlessBuffer.slice(UUID_START, UUID_END)));
  if (!validateUUID(receivedUUID)) {
    return {
      hasError: true,
      message: 'Invalid user: UUID not authorized',
    };
  }

  // 读取附加信息长度（当前跳过附加信息）
  const optLength = new Uint8Array(vlessBuffer.slice(OPT_LENGTH_INDEX, OPT_LENGTH_INDEX + 1))[0];

  // 读取命令类型
  const commandIndex = 18 + optLength;
  const command = new Uint8Array(vlessBuffer.slice(commandIndex, commandIndex + 1))[0];

  // 验证命令类型
  let isUDP = false;
  if (command === VlessCommand.TCP) {
    // TCP 命令
  } else if (command === VlessCommand.UDP) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `Unsupported command: ${command}. Only TCP(0x01) and UDP(0x02) are supported.`,
    };
  }

  // 读取端口（大端序）
  const portIndex = commandIndex + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  // 读取地址
  const addressResult = parseAddress(vlessBuffer, portIndex + 2);
  if (addressResult.hasError) {
    return addressResult;
  }

  return {
    hasError: false,
    addressRemote: addressResult.addressValue,
    addressType: addressResult.addressType,
    portRemote,
    rawDataIndex: addressResult.endIndex,
    vlessVersion: version,
    isUDP,
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
 * 解析 VLESS 协议中的地址字段
 * @param buffer 协议数据
 * @param startIndex 地址字段起始位置
 * @returns AddressParseResult 解析结果
 */
function parseAddress(buffer: ArrayBuffer, startIndex: number): AddressParseResult {
  const addressTypeByte = new Uint8Array(buffer.slice(startIndex, startIndex + 1))[0];
  const addressValueIndex = startIndex + 1;

  let addressLength = 0;
  let addressValue = '';

  switch (addressTypeByte) {
    case AddressType.IPv4:
      // IPv4: 4 字节，格式如 192.168.1.1
      addressLength = 4;
      addressValue = new Uint8Array(
        buffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;

    case AddressType.Domain:
      // 域名: 第一个字节是长度，后面是域名字符串
      addressLength = new Uint8Array(
        buffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      const domainStartIndex = addressValueIndex + 1;
      addressValue = new TextDecoder().decode(
        buffer.slice(domainStartIndex, domainStartIndex + addressLength)
      );
      // 域名的实际结束位置需要额外加1（长度字节）
      return {
        hasError: false,
        addressValue,
        addressType: addressTypeByte,
        endIndex: domainStartIndex + addressLength,
      };

    case AddressType.IPv6:
      // IPv6: 16 字节，格式如 2001:0db8:85a3:0000:0000:8a2e:0370:7334
      addressLength = 16;
      const dataView = new DataView(
        buffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6Parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6Parts.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6Parts.join(':');
      break;

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
 * 创建 VLESS 响应头
 * @param version 协议版本
 * @returns 2 字节的响应头
 */
export function createVlessResponseHeader(version: Uint8Array): Uint8Array {
  // 响应格式: [版本, 附加信息长度(0)]
  return new Uint8Array([version[0], 0]);
}
