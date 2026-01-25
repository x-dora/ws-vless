/**
 * 客户端配置生成模块
 * 生成各种客户端（V2Ray、Clash、Sing-box 等）的配置
 */

import type { ConfigGeneratorOptions, ClientConfigType } from '../types';
import { DEFAULT_PORT, WS_EARLY_DATA_PARAM } from '../config';

// ============================================================================
// 配置生成器
// ============================================================================

/**
 * 配置生成器类
 * 支持生成多种客户端格式的配置
 */
export class ConfigGenerator {
  private readonly options: Required<ConfigGeneratorOptions>;

  constructor(options: ConfigGeneratorOptions) {
    this.options = {
      userID: options.userID,
      hostName: options.hostName,
      port: options.port ?? DEFAULT_PORT,
      path: options.path ?? `/${WS_EARLY_DATA_PARAM}`,
      tls: options.tls ?? true,
      remarks: options.remarks ?? options.hostName,
    };
  }

  /**
   * 生成指定类型的配置
   * @param type 配置类型
   * @returns 配置字符串
   */
  generate(type: ClientConfigType): string {
    switch (type) {
      case 'v2ray':
        return this.generateV2rayLink();
      case 'clash-meta':
        return this.generateClashMeta();
      case 'sing-box':
        return this.generateSingBox();
      case 'all':
        return this.generateAll();
      default:
        return this.generateAll();
    }
  }

  /**
   * 生成 V2Ray 链接
   */
  generateV2rayLink(): string {
    const { userID, hostName, port, path, tls, remarks } = this.options;
    const encodedPath = encodeURIComponent(path);
    
    const params = new URLSearchParams({
      encryption: 'none',
      security: tls ? 'tls' : 'none',
      sni: hostName,
      fp: 'randomized',
      type: 'ws',
      host: hostName,
      path: encodedPath,
    });

    return `vless://${userID}@${hostName}:${port}?${params.toString()}#${encodeURIComponent(remarks)}`;
  }

  /**
   * 生成 Clash Meta 配置
   */
  generateClashMeta(): string {
    const { userID, hostName, port, path, tls, remarks } = this.options;

    const config = {
      type: 'vless',
      name: remarks,
      server: hostName,
      port: port,
      uuid: userID,
      network: 'ws',
      tls: tls,
      udp: false,
      sni: hostName,
      'client-fingerprint': 'chrome',
      'ws-opts': {
        path: path,
        headers: {
          host: hostName,
        },
      },
    };

    return this.toYaml(config);
  }

  /**
   * 生成 Sing-box 配置
   */
  generateSingBox(): string {
    const { userID, hostName, port, path, tls, remarks } = this.options;

    const config = {
      type: 'vless',
      tag: remarks,
      server: hostName,
      server_port: port,
      uuid: userID,
      tls: tls
        ? {
            enabled: true,
            server_name: hostName,
            utls: {
              enabled: true,
              fingerprint: 'chrome',
            },
          }
        : undefined,
      transport: {
        type: 'ws',
        path: path,
        headers: {
          Host: hostName,
        },
      },
    };

    return JSON.stringify(config, null, 2);
  }

  /**
   * 生成所有格式的配置（带分隔符）
   */
  generateAll(): string {
    const { hostName } = this.options;
    const separator = '---------------------------------------------------------------';
    const header = '################################################################';

    return `
${header}
v2ray
${separator}
${this.generateV2rayLink()}
${separator}
${header}
clash-meta
${separator}
${this.generateClashMeta()}
${separator}
${header}
sing-box
${separator}
${this.generateSingBox()}
${separator}
${header}
`.trim();
  }

  /**
   * 简单的对象转 YAML 格式
   * 仅支持基本类型，用于 Clash 配置
   */
  private toYaml(obj: Record<string, unknown>, indent = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);

    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        lines.push(`${prefix}${key}:`);
        lines.push(this.toYaml(value as Record<string, unknown>, indent + 1));
      } else if (typeof value === 'boolean') {
        lines.push(`${prefix}${key}: ${value}`);
      } else if (typeof value === 'number') {
        lines.push(`${prefix}${key}: ${value}`);
      } else if (typeof value === 'string') {
        // 如果字符串包含特殊字符，用引号包裹
        if (value.includes(':') || value.includes('#') || value.includes('/')) {
          lines.push(`${prefix}${key}: "${value}"`);
        } else {
          lines.push(`${prefix}${key}: ${value}`);
        }
      }
    }

    return lines.join('\n');
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 快速生成配置
 * @param userID 用户 UUID
 * @param hostName 服务器主机名
 * @param type 配置类型
 * @returns 配置字符串
 */
export function generateConfig(
  userID: string,
  hostName: string,
  type: ClientConfigType = 'all'
): string {
  const generator = new ConfigGenerator({ userID, hostName });
  return generator.generate(type);
}
