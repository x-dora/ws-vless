/**
 * 核心协议模块导出
 */

// 协议头解析
export {
  createResponseHeader,
  createSingleUUIDValidator,
  createUUIDValidator,
  processHeader,
  type UUIDValidator,
} from './header';

// Mux.Cool 多路复用
export {
  buildMuxEndFrame,
  // 构建
  buildMuxFrame,
  buildMuxKeepAliveFrame,
  buildMuxKeepFrame,
  // 解析
  isMuxConnection,
  type MuxFrame,
  // 类型
  type MuxMetadata,
  MuxNetwork,
  type MuxNewConnection,
  MuxOption,
  type MuxParseResult,
  // 常量
  MuxStatus,
  type MuxUDPAddress,
  parseMuxFrame,
  type SubConnection,
} from './mux';
