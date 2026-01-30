/**
 * 统一日志模块
 * 
 * 支持日志级别控制，减少生产环境日志输出
 */

/**
 * 日志级别
 */
export const enum LogLevel {
  /** 关闭所有日志 */
  OFF = 0,
  /** 错误日志 */
  ERROR = 1,
  /** 警告日志 */
  WARN = 2,
  /** 普通信息 */
  INFO = 3,
  /** 调试信息 */
  DEBUG = 4,
}

/**
 * 日志级别名称
 */
const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.OFF]: 'OFF',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
};

/**
 * 全局日志级别
 * 生产环境默认 WARN，开发环境默认 DEBUG
 */
let globalLogLevel: LogLevel = LogLevel.WARN;

/**
 * 设置全局日志级别
 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * 根据环境初始化日志级别
 * @param devMode 是否开发模式
 * @param logLevel 自定义日志级别（可选）
 */
export function initLogger(devMode: boolean, logLevel?: string): void {
  if (logLevel) {
    const level = parseLogLevel(logLevel);
    if (level !== null) {
      globalLogLevel = level;
      return;
    }
  }
  // 默认：开发模式 DEBUG，生产模式 WARN
  globalLogLevel = devMode ? LogLevel.DEBUG : LogLevel.WARN;
}

/**
 * 解析日志级别字符串
 */
function parseLogLevel(level: string): LogLevel | null {
  const upper = level.toUpperCase();
  switch (upper) {
    case 'OFF': return LogLevel.OFF;
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN': return LogLevel.WARN;
    case 'INFO': return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    default: return null;
  }
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
  return globalLogLevel;
}

/**
 * 日志记录器
 */
export class Logger {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * 格式化日志前缀
   */
  private fmt(level: string): string {
    return `[${level}] [${this.name}]`;
  }

  /**
   * 错误日志（始终输出，除非 OFF）
   */
  error(...args: unknown[]): void {
    if (globalLogLevel >= LogLevel.ERROR) {
      console.error(this.fmt('ERROR'), ...args);
    }
  }

  /**
   * 警告日志
   */
  warn(...args: unknown[]): void {
    if (globalLogLevel >= LogLevel.WARN) {
      console.warn(this.fmt('WARN'), ...args);
    }
  }

  /**
   * 信息日志
   */
  info(...args: unknown[]): void {
    if (globalLogLevel >= LogLevel.INFO) {
      console.log(this.fmt('INFO'), ...args);
    }
  }

  /**
   * 调试日志
   */
  debug(...args: unknown[]): void {
    if (globalLogLevel >= LogLevel.DEBUG) {
      console.log(this.fmt('DEBUG'), ...args);
    }
  }

  // ==========================================================================
  // 缓存专用日志
  // ==========================================================================

  /**
   * 缓存命中日志 (INFO 级别)
   */
  cacheHit(level: string, key: string): void {
    if (globalLogLevel >= LogLevel.INFO) {
      console.log(`[INFO] [${this.name}] ✓ ${level} hit: ${key}`);
    }
  }

  /**
   * 缓存未命中日志 (DEBUG 级别)
   */
  cacheMiss(level: string, key: string): void {
    if (globalLogLevel >= LogLevel.DEBUG) {
      console.log(`[DEBUG] [${this.name}] ✗ ${level} miss: ${key}`);
    }
  }

  /**
   * 缓存写入日志 (DEBUG 级别)
   */
  cacheWrite(level: string, key: string): void {
    if (globalLogLevel >= LogLevel.DEBUG) {
      console.log(`[DEBUG] [${this.name}] → ${level} write: ${key}`);
    }
  }

  /**
   * 创建子日志器
   */
  child(name: string): Logger {
    return new Logger(`${this.name}:${name}`);
  }
}

/**
 * 创建日志器
 */
export function createLogger(name: string): Logger {
  return new Logger(name);
}

// 预创建常用日志器
export const cacheLogger = createLogger('Cache');
export const muxLogger = createLogger('Mux');
export const initLogger$ = createLogger('Init');
export const providerLogger = createLogger('Provider');
export const connLogger = createLogger('Conn');
export const tcpLogger = createLogger('TCP');

// ============================================================================
// 连接日志辅助函数
// ============================================================================

/**
 * 创建带上下文的日志函数
 * 用于 connection.ts 中的连接处理日志
 * 
 * @param getPrefix 获取日志前缀的函数（动态获取，如 () => "address:port"）
 * @returns 日志函数对象
 */
export function createConnLog(getPrefix: () => string) {
  return {
    /** 调试日志（仅开发环境） */
    debug: (info: string, event?: string) => {
      if (globalLogLevel >= LogLevel.DEBUG) {
        console.log(`[${getPrefix()}] ${info}`, event || '');
      }
    },
    /** 信息日志 */
    info: (info: string, event?: string) => {
      if (globalLogLevel >= LogLevel.INFO) {
        console.log(`[${getPrefix()}] ${info}`, event || '');
      }
    },
    /** 警告日志 */
    warn: (info: string, event?: string) => {
      if (globalLogLevel >= LogLevel.WARN) {
        console.warn(`[${getPrefix()}] ${info}`, event || '');
      }
    },
    /** 错误日志 */
    error: (info: string, event?: string) => {
      if (globalLogLevel >= LogLevel.ERROR) {
        console.error(`[${getPrefix()}] ${info}`, event || '');
      }
    },
  };
}
