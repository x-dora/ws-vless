/**
 * 核心协议模块导出
 */

// 协议头解析
export {
  processHeader,
  createResponseHeader,
  createUUIDValidator,
  createSingleUUIDValidator,
  type UUIDValidator,
} from './header';

// Mux.Cool 多路复用
export {
  // 常量
  MuxStatus,
  MuxOption,
  MuxNetwork,
  // 解析
  isMuxConnection,
  parseMuxFrame,
  // 构建
  buildMuxFrame,
  buildMuxKeepFrame,
  buildMuxEndFrame,
  buildMuxKeepAliveFrame,
  // 类型
  type MuxMetadata,
  type MuxNewConnection,
  type MuxUDPAddress,
  type MuxFrame,
  type MuxParseResult,
  type SubConnection,
} from './mux';
