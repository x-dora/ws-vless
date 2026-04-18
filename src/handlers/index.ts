/**
 * 处理器模块导出
 */

// 导出 UUID 验证器相关
export {
  createSingleUUIDValidator,
  createUUIDValidator,
  type UUIDValidator,
} from '../core/header';
// 主连接处理
export {
  type ConnectionHandlerOptions,
  handleTunnelOverWS,
} from './connection';
// Mux 会话管理
export {
  createMuxSession,
  MuxSession,
  type MuxSessionOptions,
} from './mux-session';
// TCP 处理
export { handleTCPOutBound, remoteSocketToWS } from './tcp';
// UDP 处理
export { handleUDPOutBound, type UDPWriteFunction } from './udp';
