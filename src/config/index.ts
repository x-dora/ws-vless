/**
 * 配置管理模块
 * 集中管理所有配置项和默认值
 */

import type { WorkerEnv } from '../types';

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认 UUID（仅用于开发测试，生产环境应通过环境变量设置）
 */
export const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

/**
 * 默认代理 IP（留空表示直连）
 */
export const DEFAULT_PROXY_IP = '';

/**
 * 默认 DNS 服务器
 */
export const DEFAULT_DNS_SERVER = 'https://1.1.1.1/dns-query';

/**
 * WebSocket Early Data 路径参数
 */
export const WS_EARLY_DATA_PARAM = '?ed=2048';

/**
 * 默认服务器端口
 */
export const DEFAULT_PORT = 443;

// ============================================================================
// 配置管理类
// ============================================================================

/**
 * 运行时配置
 * 从环境变量和默认值合并生成
 */
export class RuntimeConfig {
  /** 用户 UUID */
  public readonly userID: string;
  
  /** 代理 IP */
  public readonly proxyIP: string;
  
  /** DNS 服务器地址 */
  public readonly dnsServer: string;

  constructor(env: WorkerEnv) {
    this.userID = env.UUID || DEFAULT_UUID;
    this.proxyIP = env.PROXY_IP || DEFAULT_PROXY_IP;
    this.dnsServer = env.DNS_SERVER || DEFAULT_DNS_SERVER;
  }

  /**
   * 验证配置是否有效
   * 不再抛出错误，而是使用默认值
   */
  validate(): void {
    // 使用默认 UUID 作为回退，不再抛出错误
    // UUID 格式验证在 UUID 工具模块中处理
  }
}

// ============================================================================
// 配置工厂
// ============================================================================

let cachedConfig: RuntimeConfig | null = null;

/**
 * 获取运行时配置
 * @param env Worker 环境变量
 * @returns RuntimeConfig 实例
 */
export function getConfig(env: WorkerEnv): RuntimeConfig {
  // 每次请求都重新创建配置，以支持动态环境变量
  cachedConfig = new RuntimeConfig(env);
  cachedConfig.validate();
  return cachedConfig;
}
