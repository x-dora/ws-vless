# Remnawave Node 模拟器

模拟 remnawave/node 节点行为的 Python 脚本，用于接收 Worker 流量上报并响应 Remnawave 主机轮询。

## 功能特性

- **HTTPS + mTLS 双向认证** - 完整的证书验证
- **JWT Bearer Token 验证** - RS256 算法
- **zstd/gzip 压缩** - 自动解压请求体
- **xrayConfig 解析** - 从配置中提取 inbound/outbound 标签和 uuid->email 映射
- **分离的统计类型** - 用户统计和出入站统计独立维护
- **数据持久化** - JSON 文件存储，自动保存

## 架构原理

```
┌─────────────┐      WebSocket      ┌─────────────────┐
│   客户端     │ ──────────────────> │ Cloudflare Worker │
│  (v2ray等)  │                      │    (ws-vless)    │
└─────────────┘                      └────────┬────────┘
                                              │
                                              │ HTTP POST
                                              │ /worker/report
                                              ▼
┌─────────────────┐                  ┌─────────────────┐
│ Remnawave 主机   │  HTTPS + mTLS   │   mock_node.py   │
│   (面板服务器)   │ <─────────────> │ (流量统计服务)    │
└─────────────────┘      + JWT       └─────────────────┘
```

### 数据流程

1. 主机调用 `/node/xray/start` 启动节点 → 从 xrayConfig 提取标签和 uuid->email 映射
2. 主机调用 `/node/handler/add-users` 同步用户 → 建立 vlessUuid -> userId 映射
3. 用户通过 Worker 连接 → Worker 上报 vlessUuid 流量到 `/worker/report`
4. 主机调用 `/node/stats/get-users-stats` → 返回按 email 统计的流量
5. 主机调用 `/node/stats/get-combined-stats` → 返回按 inbound/outbound 统计的流量

## 关键概念

### 用户标识转换

| 字段 | 说明 | 来源 |
|------|------|------|
| `vlessUuid` | VLESS 协议 UUID | Worker 上报 |
| `email` | Xray 流量统计标识 | xrayConfig.inbounds[].settings.clients[].email |
| `userId` | Remnawave 用户 ID | /node/handler/add-users |

流量上报时，mock_node.py 会：
1. 首先尝试将 UUID 转换为 email（从 xrayConfig 获取）
2. 如果没有 email 映射，使用 UUID 本身作为标识

### 统计类型

1. **用户统计** (`get-users-stats`): 按 email/UUID 统计每个用户的流量
2. **出入站统计** (`get-combined-stats`): 按 inbound/outbound tag 统计总流量

两种统计独立维护，重置操作互不影响。

### 认证机制

Node 使用三层认证：

1. **HTTPS** - 传输加密
2. **mTLS** - 双向证书认证（客户端和服务器都需要证书）
3. **JWT** - Bearer Token 认证（RS256 算法）

所有认证信息来自 `SECRET_KEY` (base64 编码的 JSON):

```json
{
    "nodeCertPem": "-----BEGIN CERTIFICATE-----...",
    "nodeKeyPem": "-----BEGIN PRIVATE KEY-----...",
    "caCertPem": "-----BEGIN CERTIFICATE-----...",
    "jwtPublicKey": "-----BEGIN PUBLIC KEY-----..."
}
```

## 安装依赖

```bash
# 必需
pip install PyJWT cryptography

# 可选（支持 zstd 压缩）
pip install zstandard
```

## 使用方法

### 1. 开发模式（无认证，HTTP）

```bash
python mock_node.py --port 2222 --no-auth --debug
```

适用于本地开发测试。

### 2. 简化模式（HTTPS + JWT，无 mTLS）

```bash
python mock_node.py --port 2222 --secret-key "eyJub2Rl..." --no-mtls
```

适用于不需要客户端证书验证的场景。

### 3. 完整模式（HTTPS + mTLS + JWT）

```bash
python mock_node.py --port 2222 --secret-key "eyJub2Rl..."
```

完全模拟 remnawave/node 的认证行为。

### 4. 指定数据文件

```bash
python mock_node.py --port 2222 --no-auth --data-file /path/to/stats.json
```

数据默认保存在 `stats_data.json`，每 60 秒自动保存。

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port, -p` | 监听端口 | 2222 |
| `--secret-key, -s` | Remnawave SECRET_KEY | 无 |
| `--no-mtls` | 禁用 mTLS（仅 HTTPS + JWT） | 启用 |
| `--no-auth` | 禁用所有认证（HTTP 模式） | 禁用 |
| `--data-file` | 数据持久化文件路径 | stats_data.json |
| `--debug, -d` | 启用调试日志 | 禁用 |

## API 接口

### Worker 上报接口（无需 JWT）

```bash
# 单条上报
POST /worker/report
Content-Type: application/json

{
    "uuid": "d342d11e-d424-4583-b36e-524ab1f0afa4",
    "uplink": 1024,
    "downlink": 2048,
    "inboundTag": "VLESS_WS",    # 可选
    "outboundTag": "DIRECT"      # 可选
}

# 批量上报
POST /worker/batch-report
Content-Type: application/json

{
    "reports": [
        {"uuid": "uuid1", "uplink": 1024, "downlink": 2048},
        {"uuid": "uuid2", "uplink": 512, "downlink": 1024}
    ]
}

# 手动添加 UUID -> userId 映射（兼容旧版）
POST /worker/add-mapping
{
    "uuid": "d342d11e-d424-4583-b36e-524ab1f0afa4",
    "userId": "user@example.com"
}
```

### Remnawave 兼容接口（需要 JWT）

#### Xray 控制

```bash
# 启动 Xray（从 xrayConfig 提取标签和 uuid->email 映射）
POST /node/xray/start
{
    "xrayConfig": {
        "inbounds": [{
            "tag": "VLESS_WS",
            "settings": {
                "clients": [
                    {"id": "uuid-1", "email": "user1@example.com"},
                    {"id": "uuid-2", "email": "user2@example.com"}
                ]
            }
        }],
        "outbounds": [{"protocol": "freedom", "tag": "DIRECT"}]
    }
}

# 健康检查
GET /node/xray/healthcheck
# 响应: {"response": {"isAlive": true, "xrayVersion": "1.8.24"}}

# Xray 状态
GET /node/xray/status
# 响应: {"response": {"isRunning": true, "version": "1.8.24"}}
```

#### 流量统计

```bash
# 获取用户流量统计
POST /node/stats/get-users-stats
{"reset": false}

# 响应
{
    "response": {
        "users": [
            {"username": "user1@example.com", "uplink": 1024, "downlink": 2048}
        ]
    }
}

# 获取出入站统计
POST /node/stats/get-combined-stats
{"reset": false}

# 响应
{
    "response": {
        "inbounds": [{"inbound": "VLESS_WS", "uplink": 2048, "downlink": 4096}],
        "outbounds": [{"outbound": "DIRECT", "uplink": 2048, "downlink": 4096}]
    }
}

# 获取系统统计
GET /node/stats/get-system-stats
# 响应: {"response": {"numGoroutine": 50, "alloc": 20971520, "uptime": 3600}}
```

#### 用户管理

```bash
# 批量添加用户（自动提取 UUID -> userId 映射）
POST /node/handler/add-users
{
    "users": [
        {
            "userData": {
                "userId": "user@example.com",
                "vlessUuid": "d342d11e-d424-4583-b36e-524ab1f0afa4"
            }
        }
    ]
}

# 删除用户
POST /node/handler/remove-user
{"hashData": {"vlessUuid": "d342d11e-..."}}

# 获取入站用户数量
POST /node/handler/get-inbound-users-count
# 响应: {"response": {"count": 10}}
```

### 调试接口

```bash
# 获取详细统计
GET /stats

# 获取 UUID -> userId 映射
GET /mappings

# 健康检查
GET /health
```

## Docker 部署

### Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir PyJWT cryptography zstandard

COPY mock_node.py .

EXPOSE 2222

ENTRYPOINT ["python", "mock_node.py"]
CMD ["--port", "2222"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  mock-node:
    build: .
    ports:
      - "2222:2222"
    environment:
      - SECRET_KEY=${SECRET_KEY}
    volumes:
      - ./data:/app/data
    command: >
      python mock_node.py 
        --port 2222 
        --secret-key "${SECRET_KEY}"
        --data-file /app/data/stats.json
    restart: always
```

## 配置 Worker

在 Worker 环境变量中添加：

```bash
# .dev.vars 或 Cloudflare Dashboard
STATS_REPORT_URL=http://your-server:2222/worker/report
```

## 配置 Remnawave 面板

在 Remnawave 面板添加节点时：
- 节点地址: `your-server`
- 节点端口: `2222`
- SECRET_KEY: 使用与启动脚本相同的密钥

## 数据持久化

统计数据保存在 JSON 文件中，包含：

```json
{
    "users": [
        {
            "username": "user@example.com",
            "uplink": 1024,
            "downlink": 2048,
            "connections": 10,
            "last_seen": 1700000000.0
        }
    ],
    "uuid_to_email": {
        "d342d11e-...": "user@example.com"
    },
    "inbound_stats": {
        "VLESS_WS": {"uplink": 2048, "downlink": 4096}
    },
    "outbound_stats": {
        "DIRECT": {"uplink": 2048, "downlink": 4096}
    },
    "current_inbound_tag": "VLESS_WS",
    "current_outbound_tag": "DIRECT",
    "saved_at": "2024-01-01T00:00:00"
}
```

- 自动保存间隔：60 秒
- 程序退出时自动保存
- 启动时自动加载

## 与官方 Node 的区别

| 功能 | 官方 Node | mock_node.py |
|------|-----------|--------------|
| 协议后端 | Xray Core | 无（接收 Worker 上报） |
| 流量来源 | Xray gRPC API | Worker HTTP 上报 |
| 用户管理 | 写入 Xray 配置 | 仅记录映射 |
| 统计标识 | Xray email | email（从 xrayConfig 获取） |
| 出入站标签 | Xray 配置 | 从 xrayConfig 提取 |
| 部署方式 | Docker + Xray | Python 脚本 |

## 故障排查

### Worker 无法上报

```bash
# 检查网络连通性
curl -X POST http://your-server:2222/worker/report \
  -H "Content-Type: application/json" \
  -d '{"uuid":"test-uuid","uplink":100,"downlink":200}'

# 预期响应: {"success": true}
```

### JWT 验证失败

```bash
# 启用 debug 日志查看详细信息
python mock_node.py --port 2222 --secret-key "..." --debug
```

### 流量统计为空

1. 检查 `/stats` 接口是否有数据
2. 检查 `/node/xray/start` 是否被调用（提取 uuid->email 映射）
3. 确认 Worker 配置了正确的 `STATS_REPORT_URL`

### 映射缺失

如果 Worker 上报的 UUID 没有对应的 email 映射：
1. UUID 会直接作为 username 使用
2. 等待主机调用 `/node/xray/start` 发送 xrayConfig
3. 后续上报会使用正确的 email

### 压缩请求无法解析

```bash
# 安装 zstd 支持
pip install zstandard
```
