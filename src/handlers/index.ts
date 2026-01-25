/**
 * 处理器模块导出
 */

// 主连接处理
export { 
  handleTunnelOverWS, 
  type ConnectionHandlerOptions,
} from './connection';

// TCP 处理
export { handleTCPOutBound, remoteSocketToWS } from './tcp';

// UDP 处理
export { handleUDPOutBound, type UDPWriteFunction } from './udp';

// Mux 会话管理
export { 
  MuxSession, 
  createMuxSession, 
  type MuxSessionOptions 
} from './mux-session';

// 导出 UUID 验证器相关
export { 
  createUUIDValidator, 
  createSingleUUIDValidator,
  type UUIDValidator 
} from '../core/header';
