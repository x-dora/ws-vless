/**
 * 处理器模块导出
 */

export { handleVlessOverWS, type VlessHandlerOptions } from './vless';
export { handleTCPOutBound, remoteSocketToWS } from './tcp';
export { handleUDPOutBound, type UDPWriteFunction } from './udp';

// 导出 UUID 验证器相关
export { 
  createUUIDValidator, 
  createSingleUUIDValidator,
  type UUIDValidator 
} from '../protocol/vless-header';
