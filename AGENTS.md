# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

基于 Cloudflare Workers 的 VLESS 代理服务，支持 WebSocket 传输、TCP/UDP 代理、Mux.Cool 多路复用。采用 TypeScript OOP 分层架构。

## 常用命令

```bash
pnpm dev              # 本地开发 (wrangler dev)
pnpm start            # 启动本地开发
pnpm deploy           # 部署到 Cloudflare Workers
pnpm test             # 运行所有测试 (vitest)
npx vitest run test/xxx.spec.ts  # 运行单个测试文件
pnpm format           # 格式化代码 (biome)
pnpm lint             # Lint 检查 (biome)
pnpm check            # 综合检查 (biome check)
pnpm cf-typegen       # 生成 Cloudflare 类型定义
```

## 架构

**模式**: OOP 分层架构，依赖通过构造函数注入。`getWorkerApp(env)` 工厂函数使用 WeakMap 缓存实例。

**请求流程**:
```
Client → Worker fetch() → WorkerApp
  → HttpRouter (API 请求 / 配置查询)
  → WebSocketGateway → TunnelConnectionSession
    → processHeader() 解析 VLESS 头
    → TcpTransport / UdpDnsTransport / MuxSession → 远程
```

**关键层**:
- `src/app/worker-app.ts` — `WorkerApp` 应用主类，协调路由和网关
- `src/app/app-context.ts` — `AppContext` 组装全局服务图（配置、认证、指标、UUID 管理器）
- `src/core/header.ts` — `processHeader()` VLESS 协议头解析，`createUUIDValidator()` UUID 验证器
- `src/core/mux.ts` — Mux.Cool 协议帧解析/构建 (`parseMuxFrame`, `buildMuxFrame`)
- `src/handlers/connection.ts` — `WebSocketGateway` + `TunnelConnectionSession` 连接生命周期
- `src/handlers/tcp.ts` — `TcpTransport` TCP 传输，支持直连/Proxy IP/NAT64 三级回退
- `src/handlers/udp.ts` — `UdpDnsTransport` UDP/DNS 代理，使用 DoH
- `src/handlers/mux-session.ts` — `MuxSession` 多路复用会话管理
- `src/providers/` — UUID 提供者策略模式，`UUIDProviderManager` 管理多种实现（静态/HTTP API/Remnawave）
- `src/cache/` — 分层缓存：L1 Cache API + L2 KV/D1，`TieredCache` 逐级回退
- `src/config/request-overrides.ts` — WebSocket 查询参数覆盖（`PROXY_IP`, `NAT64_PREFIXES`）

## 开发环境

- **包管理器**: pnpm
- **代码质量**: Biome（格式化+Lint），pre-commit hooks 自动运行 `biome check` + `vitest related`
- **测试框架**: Vitest + `@cloudflare/vitest-pool-workers`，配置在 `vitest.config.mts`
- **编辑器**: VSCode，Biome 为默认格式化工具，保存时自动格式化

## 重要约定

- UUID 验证通过 `createUUIDValidator(validUUIDs)` 创建闭包验证器
- 传输层使用 `WriteQueue`（`src/utils/_websocket.ts`）防止并发写入 WebSocket
- `SubrequestBudget`（`src/utils/subrequest-budget.ts`）管理 Cloudflare Workers 子请求限制（默认 48）
- 日志级别通过 `LOG_LEVEL` 环境变量控制（OFF/ERROR/WARN/INFO/DEBUG），生产默认 WARN
- Mux 协议使用 `subarray` 零拷贝，TCP 使用 8KB 分块写入
- `worker-configuration.d.ts` 是 `wrangler types` 自动生成文件，除非明确在做类型定义刷新，否则不要把它当成需要手工维护的业务文件，也不要因为其中的格式差异单独阻塞审查
- 本地 Vitest / Miniflare 里出现的 `compatibility_date` 回退或兼容性日志，当前先视为环境告警；只有在实际功能回归或类型/测试失败时才需要优先处理

## 测试验证

- **本地单测** (`pnpm test`)：修改任何核心逻辑后必须优先执行，用于快速验证代码基础正确性。
- **本地端到端冒烟测试** (`bash tools/quick_test.sh`)：本地开发完成后执行，用于验证完整的代理请求链路（会自动处理 10808 与 8787 端口检查）。
- **远程实机环境验证** (`bash tools/quick_test.sh --remote`)：在推送代码前或需要测试 Cloudflare 特有真实环境（如网络回退、D1/KV 线上表现）时使用。
- **并发压力测试** (`bash tools/proxy_concurrent_test.sh`)：在修改了连接处理、Mux 多路复用、缓存池等核心性能相关代码后执行，以确保高并发环境下的内存与稳定性。
- 复测场景: IPv4 直连、IPv6 直连、NAT64 回退，关键日志 `Connecting to` / `Connected to`
- 验收标准: `pnpm test` 通过 + 三种连接场景可用
