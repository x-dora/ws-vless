# ws-vless

基于 Cloudflare Worker 的 VLESS 代理服务，支持 WebSocket 传输。

## 功能特性

- **VLESS over WebSocket** - 标准协议实现
- **TCP 和 UDP 代理** - 支持 DNS 查询代理
- **Mux.Cool 多路复用** - 减少连接数，提高性能
- **多 UUID 支持** - 支持多用户同时使用
- **面板集成** - 支持 Remnawave 等面板获取用户
- **分层缓存** - Cache API (L1) + KV/D1 (L2)
- **流量统计** - 支持上报流量到统计服务

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发

复制 `.dev.vars.example` 为 `.dev.vars` 并配置：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```ini
# 必需：API 密钥
API_KEY=your-api-key

# 可选：Remnawave 面板集成
RW_API_URL=https://your-remnawave-panel.com
RW_API_KEY=your-remnawave-api-key

# 可选：流量统计上报
STATS_REPORT_URL=http://your-server:2222/worker/report

# 开发模式（启用默认 UUID）
DEV_MODE=true
UUID=your-test-uuid
```

启动开发服务器：

```bash
npm run dev
```

### 3. 部署

```bash
npm run deploy
```

部署后在 Cloudflare Dashboard 设置环境变量：
- Workers & Pages > ws-vless > Settings > Variables

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `API_KEY` | 是 | API 端点访问密钥 |
| `RW_API_URL` | 否 | Remnawave API 地址 |
| `RW_API_KEY` | 否 | Remnawave API 密钥 |
| `UUID` | 否 | 默认 UUID（仅开发模式生效） |
| `DEV_MODE` | 否 | 设置为 `true` 启用开发模式 |
| `UUID_CACHE_TTL` | 否 | 缓存时间（秒），默认 300 |
| `STATS_REPORT_URL` | 否 | 流量统计上报地址 |
| `STATS_REPORT_TOKEN` | 否 | 流量统计上报认证 Token |
| `MUX_ENABLED` | 否 | Mux 多路复用开关，默认 true |
| `PROXY_IP` | 否 | 代理 IP 地址 |
| `DNS_SERVER` | 否 | DNS 服务器地址 |
| `LOG_LEVEL` | 否 | 日志级别：OFF/ERROR/WARN/INFO/DEBUG |

## API 端点

所有 API 端点需要密钥认证：
- Header: `X-API-Key: your-key` 或 `Authorization: Bearer your-key`
- Query: `?key=your-key`

| 端点 | 说明 |
|------|------|
| `GET /` | 服务状态和 Cloudflare 信息 |
| `GET /{uuid}` | 用户配置信息 |
| `GET /api/uuids` | 获取所有有效 UUID |
| `GET /api/uuids/refresh` | 强制刷新 UUID 缓存 |
| `GET /api/stats` | 获取提供者统计信息 |

## 架构

```
┌─────────────────┐     WebSocket      ┌─────────────────────┐
│    客户端        │ ─────────────────> │  Cloudflare Worker  │
│   (v2ray等)     │                    │      (ws-vless)     │
└─────────────────┘                    └──────────┬──────────┘
                                                  │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             │                             │
                    ▼                             ▼                             ▼
           ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
           │   Cache API     │          │   Remnawave     │          │   统计服务       │
           │   (L1 缓存)      │          │   (用户管理)    │          │  (流量上报)      │
           └─────────────────┘          └─────────────────┘          └─────────────────┘
```

### 分层缓存

```
L1: Cache API (边缘节点，始终启用)
    ↓ 未命中
L2: KV / D1 (持久化存储，可选)
    ↓ 未命中
原始请求 (Remnawave API 等)
```

## 项目结构

```
src/
├── index.ts              # Worker 主入口
├── config/               # 配置管理
├── core/                 # 核心协议实现
│   ├── header.ts         # 协议头解析
│   └── mux.ts            # Mux 多路复用
├── handlers/             # 请求处理器
│   ├── connection.ts     # 连接处理
│   ├── tcp.ts            # TCP 代理
│   ├── udp.ts            # UDP 代理
│   └── mux-session.ts    # Mux 会话管理
├── cache/                # 缓存实现
│   ├── cache-api.ts      # Cache API (L1)
│   ├── kv.ts             # KV 存储 (L2)
│   ├── d1.ts             # D1 数据库 (L2)
│   └── tiered.ts         # 分层缓存
├── providers/            # UUID 提供者
│   ├── base.ts           # 基础接口
│   └── remnawave.ts      # Remnawave 集成
├── services/             # 服务
│   └── stats-reporter.ts # 流量统计上报
├── types/                # 类型定义
└── utils/                # 工具函数
    ├── encoding.ts       # 编码工具
    ├── logger.ts         # 日志
    └── uuid.ts           # UUID 工具

scripts/
└── mock_node.py          # Remnawave Node 模拟器

test/
└── index.spec.ts         # 测试文件
```

## 配置缓存存储

### KV 存储（推荐）

```bash
# 创建 KV 命名空间
wrangler kv namespace create UUID_KV

# 在 wrangler.jsonc 中添加绑定
```

### D1 数据库

```bash
# 创建数据库
wrangler d1 create uuid-cache

# 初始化表结构
wrangler d1 execute uuid-cache --command="CREATE TABLE IF NOT EXISTS uuid_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"
wrangler d1 execute uuid-cache --command="CREATE INDEX IF NOT EXISTS idx_expires_at ON uuid_cache(expires_at)"
```

## 开发

### 运行测试

```bash
npm test
```

### 生成类型

```bash
npm run cf-typegen
```

## 工具脚本

### mock_node.py

Remnawave Node 模拟器，用于本地测试流量统计功能。详见 [scripts/README.md](scripts/README.md)。

```bash
# 开发模式（无认证）
python scripts/mock_node.py --port 2222 --no-auth

# 完整模式（HTTPS + mTLS + JWT）
python scripts/mock_node.py --port 2222 --secret-key "eyJub2Rl..."
```

## 客户端配置

支持 v2rayN、Clash 等客户端，使用 WebSocket 传输：

- 地址: `your-worker.workers.dev`
- 端口: `443`
- UUID: 你的用户 UUID
- 传输: `ws`
- TLS: 启用

## License

MIT
