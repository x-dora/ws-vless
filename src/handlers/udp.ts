/**
 * UDP 出站处理模块
 * 处理 VLESS UDP 代理连接（主要用于 DNS 查询）
 */

import type { LogFunction } from '../types';
import { WS_READY_STATE } from '../types';
import { DEFAULT_DNS_SERVER } from '../config';

// ============================================================================
// UDP/DNS 处理
// ============================================================================

/**
 * UDP 写入函数类型
 */
export type UDPWriteFunction = (chunk: Uint8Array) => void;

/**
 * 处理 UDP 出站连接
 * 目前仅支持 DNS 查询（端口 53）
 * 
 * @param webSocket WebSocket 连接
 * @param vlessResponseHeader VLESS 响应头
 * @param log 日志函数
 * @param dnsServer DNS 服务器地址
 * @returns 包含写入函数的对象
 */
export async function handleUDPOutBound(
  webSocket: any,
  vlessResponseHeader: Uint8Array,
  log: LogFunction,
  dnsServer: string = DEFAULT_DNS_SERVER
): Promise<{ write: UDPWriteFunction }> {
  let isVlessHeaderSent = false;

  // 创建 TransformStream 来解析 UDP 数据包
  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    start() {
      // 初始化
    },

    transform(chunk, controller) {
      // UDP 消息格式: 前 2 字节是 UDP 数据长度
      // TODO: 这里存在 bug，UDP 数据包可能跨越多个 WebSocket 消息
      for (let index = 0; index < chunk.byteLength; ) {
        // 读取 UDP 包长度（2 字节，大端序）
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer.buffer).getUint16(0);

        // 提取 UDP 数据
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPacketLength)
        );

        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },

    flush() {
      // 清理
    },
  });

  // 处理 DNS 查询
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          // 通过 DoH (DNS over HTTPS) 发送 DNS 查询
          const response = await fetch(dnsServer, {
            method: 'POST',
            headers: {
              'content-type': 'application/dns-message',
            },
            body: chunk,
          });

          const dnsQueryResult = await response.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;

          // 构建 UDP 响应长度前缀
          const udpSizeBuffer = new Uint8Array([
            (udpSize >> 8) & 0xff,
            udpSize & 0xff,
          ]);

          // 发送响应
          if (webSocket.readyState === WS_READY_STATE.OPEN) {
            log(`DoH success, DNS response length: ${udpSize}`);

            if (isVlessHeaderSent) {
              // 后续响应不需要 VLESS 头
              const combined = await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer();
              webSocket.send(combined);
            } else {
              // 第一次响应需要附加 VLESS 头
              const combined = await new Blob([
                vlessResponseHeader,
                udpSizeBuffer,
                dnsQueryResult,
              ]).arrayBuffer();
              webSocket.send(combined);
              isVlessHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log(`DNS UDP error: ${error}`);
    });

  // 获取写入器
  const writer = transformStream.writable.getWriter();

  return {
    /**
     * 写入 UDP 数据
     * @param chunk UDP 数据
     */
    write(chunk: Uint8Array): void {
      writer.write(chunk);
    },
  };
}
