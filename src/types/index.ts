/**
 * Tunnel Worker 类型定义
 * 定义项目中使用的所有 TypeScript 类型和接口
 */

// ============================================================================
// 环境变量类型
// ============================================================================

/**
 * Worker 环境变量接口
 * 在 wrangler.jsonc 中配置或通过 Cloudflare Dashboard 设置
 * 敏感信息（如密钥）应使用 wrangler secret put 命令设置
 */
export interface WorkerEnv {
  /** 默认 UUID，用于验证客户端 */
  UUID?: string;
  /** 代理 IP，用于 TCP 连接重试时的备用地址 */
  PROXY_IP?: string;
  /** DNS 服务器地址，默认使用 Cloudflare DNS */
  DNS_SERVER?: string;
  
  // =========================================================================
  // API 安全配置
  // =========================================================================
  
  /** API 访问密钥，保护 /api/* 端点 */
  API_KEY?: string;
  /** 开发模式标记，设置为 "true" 启用默认 UUID */
  DEV_MODE?: string;
  
  // =========================================================================
  // Remnawave API 配置
  // =========================================================================
  
  /** Remnawave API 地址 (如: https://panel.example.com) */
  RW_API_URL?: string;
  /** Remnawave API 密钥 */
  RW_API_KEY?: string;
  /** UUID 缓存时间（秒），默认 300 */
  UUID_CACHE_TTL?: string;

  // =========================================================================
  // Mux 配置
  // =========================================================================
  
  /** 是否启用 Mux 多路复用，默认 "true" */
  MUX_ENABLED?: string;
  /** Mux 连接超时时间（秒），默认 300 */
  MUX_TIMEOUT?: string;
}

// ============================================================================
// 协议类型
// ============================================================================

/**
 * 协议头解析结果
 */
export interface HeaderResult {
  /** 是否解析出错 */
  hasError: boolean;
  /** 错误信息 */
  message?: string;
  /** 远程地址 */
  addressRemote?: string;
  /** 地址类型: 1=IPv4, 2=域名, 3=IPv6 */
  addressType?: number;
  /** 远程端口 */
  portRemote?: number;
  /** 原始数据开始索引 */
  rawDataIndex?: number;
  /** 协议版本 */
  protocolVersion?: Uint8Array;
  /** 是否为 UDP 连接 */
  isUDP?: boolean;
  /** 是否为 Mux 多路复用连接 */
  isMux?: boolean;
}

/**
 * 命令类型
 */
export const enum ProxyCommand {
  TCP = 0x01,
  UDP = 0x02,
  MUX = 0x03,
}

/**
 * 地址类型枚举
 */
export const enum AddressType {
  IPv4 = 1,
  Domain = 2,
  IPv6 = 3,
}

// ============================================================================
// UUID 提供者类型
// ============================================================================

/**
 * UUID 提供者接口
 * 所有 UUID 获取平台需要实现此接口
 */
export interface UUIDProvider {
  /** 提供者名称 */
  readonly name: string;
  
  /** 提供者优先级，数字越小优先级越高 */
  readonly priority: number;
  
  /**
   * 获取可用的 UUID 列表
   * @returns Promise<string[]> UUID 数组
   */
  fetchUUIDs(): Promise<string[]>;
  
  /**
   * 验证提供者是否可用
   * @returns Promise<boolean> 是否可用
   */
  isAvailable(): Promise<boolean>;
}

/**
 * UUID 提供者配置
 */
export interface UUIDProviderConfig {
  /** 是否启用此提供者 */
  enabled: boolean;
  /** API 端点 */
  endpoint?: string;
  /** 认证令牌 */
  authToken?: string;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 请求超时时间（毫秒） */
  timeout?: number;
}

/**
 * UUID 验证结果
 */
export interface UUIDValidationResult {
  /** 是否有效 */
  isValid: boolean;
  /** UUID 来源提供者 */
  provider?: string;
  /** 过期时间（如果有） */
  expiresAt?: Date;
}

// ============================================================================
// 连接类型
// ============================================================================

/**
 * 远程 Socket 包装器
 * 用于在多个函数间共享 socket 引用
 */
export interface RemoteSocketWrapper {
  value: Socket | null;
}

/**
 * 日志函数类型
 */
export type LogFunction = (info: string, event?: string) => void;

// ============================================================================
// 配置输出类型
// ============================================================================

/**
 * 客户端配置类型
 */
export type ClientConfigType = 'v2ray' | 'clash-meta' | 'sing-box' | 'all';

/**
 * 配置生成选项
 */
export interface ConfigGeneratorOptions {
  /** 用户 UUID */
  userID: string;
  /** 服务器主机名 */
  hostName: string;
  /** 服务器端口，默认 443 */
  port?: number;
  /** WebSocket 路径 */
  path?: string;
  /** 是否启用 TLS */
  tls?: boolean;
  /** 配置备注名称 */
  remarks?: string;
}

// ============================================================================
// WebSocket 状态常量
// ============================================================================

/**
 * WebSocket 就绪状态
 */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type WebSocketReadyState = typeof WS_READY_STATE[keyof typeof WS_READY_STATE];

