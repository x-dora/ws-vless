/**
 * 编码工具模块
 * 提供各种编码和解码功能
 */

// ============================================================================
// Base64 编解码
// ============================================================================

/**
 * 将 ArrayBuffer 编码为 Base64 字符串
 * @param buffer ArrayBuffer 或 Uint8Array
 * @returns Base64 字符串
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 将 Base64 字符串解码为 ArrayBuffer
 * 支持标准 Base64 和 URL 安全 Base64
 * @param base64Str Base64 字符串
 * @returns Uint8Array
 * @throws Error 如果解码失败
 */
export function base64ToArrayBuffer(base64Str: string): Uint8Array {
  // 转换 URL 安全 Base64 到标准 Base64
  const normalizedBase64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalizedBase64);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}

/**
 * 将字符串编码为 URL 安全的 Base64
 * @param str 输入字符串
 * @returns URL 安全的 Base64 字符串
 */
export function toUrlSafeBase64(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================================================
// 十六进制编解码
// ============================================================================

/**
 * 将 ArrayBuffer 编码为十六进制字符串
 * @param buffer ArrayBuffer 或 Uint8Array
 * @returns 十六进制字符串
 */
export function arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 将十六进制字符串解码为 Uint8Array
 * @param hex 十六进制字符串
 * @returns Uint8Array
 * @throws Error 如果输入不是有效的十六进制字符串
 */
export function hexToArrayBuffer(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (isNaN(byte)) {
      throw new Error('Invalid hex character');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

// ============================================================================
// 数值编解码
// ============================================================================

/**
 * 将 16 位无符号整数转换为大端序字节数组
 * @param value 16 位无符号整数
 * @returns 2 字节的 Uint8Array
 */
export function uint16ToBytes(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/**
 * 从大端序字节数组读取 16 位无符号整数
 * @param bytes 字节数组
 * @param offset 起始偏移量
 * @returns 16 位无符号整数
 */
export function bytesToUint16(bytes: ArrayBuffer, offset = 0): number {
  return new DataView(bytes).getUint16(offset);
}

// ============================================================================
// 文本编解码
// ============================================================================

/**
 * 将 ArrayBuffer 解码为 UTF-8 字符串
 * @param buffer ArrayBuffer 或 Uint8Array
 * @returns UTF-8 字符串
 */
export function arrayBufferToString(buffer: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

/**
 * 将 UTF-8 字符串编码为 Uint8Array
 * @param str UTF-8 字符串
 * @returns Uint8Array
 */
export function stringToArrayBuffer(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}
