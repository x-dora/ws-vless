/**
 * UUID 工具模块
 * 提供 UUID 验证、转换和生成功能
 */

// ============================================================================
// UUID 验证
// ============================================================================

/**
 * UUID v4 正则表达式
 * 严格匹配 RFC 4122 标准的 UUID v4 格式
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 通用 UUID 正则表达式（不限制版本）
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 验证字符串是否为有效的 UUID
 * @param uuid 待验证的字符串
 * @param strict 是否严格验证 UUID v4 格式
 * @returns boolean 是否有效
 */
export function isValidUUID(uuid: string, strict = false): boolean {
  if (!uuid || typeof uuid !== 'string') {
    return false;
  }
  return strict ? UUID_V4_REGEX.test(uuid) : UUID_REGEX.test(uuid);
}

// ============================================================================
// UUID 转换
// ============================================================================

/**
 * 字节到十六进制映射表
 * 预计算以提高转换性能
 */
const byteToHex: string[] = [];
for (let i = 0; i < 256; i++) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

/**
 * 将字节数组转换为 UUID 字符串（不验证）
 * @param arr 16 字节的 Uint8Array
 * @param offset 起始偏移量
 * @returns UUID 字符串
 */
export function unsafeStringify(arr: Uint8Array, offset = 0): string {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

/**
 * 将字节数组转换为 UUID 字符串（带验证）
 * @param arr 16 字节的 Uint8Array
 * @param offset 起始偏移量
 * @returns UUID 字符串
 * @throws TypeError 如果转换结果不是有效 UUID
 */
export function stringify(arr: Uint8Array, offset = 0): string {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw new TypeError('Stringified UUID is invalid');
  }
  return uuid;
}

/**
 * 将 UUID 字符串转换为字节数组
 * @param uuid UUID 字符串
 * @returns 16 字节的 Uint8Array
 * @throws Error 如果 UUID 格式无效
 */
export function parse(uuid: string): Uint8Array {
  if (!isValidUUID(uuid)) {
    throw new Error('Invalid UUID format');
  }
  
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  
  return bytes;
}

/**
 * 比较两个 UUID 是否相等
 * @param uuid1 第一个 UUID（字符串或字节数组）
 * @param uuid2 第二个 UUID（字符串或字节数组）
 * @returns boolean 是否相等
 */
export function compareUUID(
  uuid1: string | Uint8Array,
  uuid2: string | Uint8Array
): boolean {
  const str1 = typeof uuid1 === 'string' ? uuid1.toLowerCase() : unsafeStringify(uuid1);
  const str2 = typeof uuid2 === 'string' ? uuid2.toLowerCase() : unsafeStringify(uuid2);
  return str1 === str2;
}
