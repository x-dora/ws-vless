# Remnawave Node 模拟器

模拟 remnawave/node 节点行为的 Python 脚本，支持 **HTTPS + mTLS** 认证。

## 架构原理

```
┌─────────────┐      WebSocket      ┌─────────────────┐
│   客户端     │ ──────────────────> │ Cloudflare Worker │
│  (v2ray等)  │                      │    (ws-vless)    │
└─────────────┘                      └────────┬────────┘
                                              │
                                              │ HTTP POST (uuid)
                                              │ /worker/report
                                              ▼
┌─────────────────┐                  ┌─────────────────┐
│ Remnawave 主机   │  HTTPS + mTLS   │   mock_node.py   │
│   (面板服务器)   │ <─────────────> │ (流量统计服务)    │
└─────────────────┘      + JWT       └─────────────────┘

数据流程：
1. 主机调用 /node/handler/add-users 同步用户 → 建立 vlessUuid -> userId 映射
2. 用户通过 Worker 连接 → Worker 上报 vlessUuid 流量
3. 主机调用 /node/stats/get-users-stats → 返回 userId 的流量统计
```

## 关键概念

### UUID vs userId

| 字段 | 说明 | 示例 |
|------|------|------|
| `vlessUuid` | VLESS 协议使用的 UUID | `d342d11e-d424-4583-b36e-524ab1f0afa4` |
| `userId` | Remnawave 面板的用户标识 | `user@example.com` 或 `user_12345` |

- Worker 使用 `vlessUuid` 验证用户身份
- Remnawave 流量统计使用 `userId` (即 `username` 字段)
- mock_node.py 自动维护两者的映射关系

### 认证机制

Node 使用三层认证：

1. **HTTPS** - 传输加密
2. **mTLS** - 双向证书认证（客户端和服务器都需要证书）
3. **JWT** - Bearer Token 认证（每个请求都需要）

所有认证信息都来自 `SECRET_KEY` (base64 编码的 JSON):
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
# 基础运行（无 JWT 验证）
python mock_node.py --port 2222 --no-auth

# 完整功能需要安装
pip install PyJWT cryptography
```

## 使用方法

### 1. 开发模式（无认证，HTTP）

```bash
python mock_node.py --port 2222 --no-auth --debug
```

### 2. 简化模式（HTTPS + JWT，无 mTLS）

```bash
python mock_node.py --port 2222 --secret-key "eyJub2Rl..." --no-mtls
```

### 3. 完整模式（HTTPS + mTLS + JWT）

```bash
python mock_node.py --port 2222 --secret-key "eyJub2Rl..."
```

### 4. 配置 Worker

在 Worker 环境变量中添加：

```bash
# .dev.vars 或 Cloudflare Dashboard
STATS_REPORT_URL=http://your-server:2222/worker/report
# STATS_REPORT_TOKEN=your-token  # 如果需要
```

### 5. 配置 Remnawave 面板

在 Remnawave 面板添加节点时：
- 节点地址: `your-server`
- 节点端口: `2222`
- SECRET_KEY: 使用与启动脚本相同的密钥

## API 接口

### Worker 上报接口（无需 JWT）

```bash
# 单条上报（使用 vlessUuid）
POST /worker/report
{
    "uuid": "d342d11e-d424-4583-b36e-524ab1f0afa4",
    "uplink": 1024,
    "downlink": 2048
}

# 批量上报
POST /worker/batch-report
{
    "reports": [
        {"uuid": "uuid1", "uplink": 1024, "downlink": 2048},
        {"uuid": "uuid2", "uplink": 512, "downlink": 1024}
    ]
}

# 手动添加 UUID -> userId 映射
POST /worker/add-mapping
{
    "uuid": "d342d11e-d424-4583-b36e-524ab1f0afa4",
    "userId": "user@example.com"
}
```

### Remnawave 兼容接口（需要 JWT）

```bash
# 获取用户流量统计（返回 userId 作为 username）
POST /node/stats/get-users-stats
Authorization: Bearer <jwt-token>
{"reset": false}

# 响应
{
    "response": {
        "users": [
            {"username": "user@example.com", "uplink": 1024, "downlink": 2048}
        ]
    }
}

# 批量添加用户（自动提取 UUID -> userId 映射）
POST /node/handler/add-users
Authorization: Bearer <jwt-token>
{
    "affectedInboundTags": ["vless-ws"],
    "users": [
        {
            "userData": {
                "userId": "user@example.com",
                "vlessUuid": "d342d11e-d424-4583-b36e-524ab1f0afa4",
                "hashUuid": "...",
                "trojanPassword": "...",
                "ssPassword": "..."
            },
            "inboundData": [{"type": "vless", "tag": "vless-ws", "flow": ""}]
        }
    ]
}
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

# 安装 JWT 支持
RUN pip install --no-cache-dir PyJWT cryptography

COPY mock_node.py .

EXPOSE 2222

# 默认使用环境变量中的 SECRET_KEY
CMD ["python", "mock_node.py", "--port", "2222"]
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
      # 从 Remnawave 面板获取
      - SECRET_KEY=${SECRET_KEY}
    command: >
      python mock_node.py 
        --port 2222 
        --secret-key "${SECRET_KEY}"
    restart: always
```

## 工作流程详解

### 完整数据流

```
1. [Remnawave 面板] 创建用户
   └─> userData: {userId: "user@example.com", vlessUuid: "abc-123-..."}

2. [Remnawave 面板] 同步用户到节点
   └─> POST /node/handler/add-users (带 JWT)
       └─> [mock_node.py] 记录映射: "abc-123-..." → "user@example.com"

3. [用户] 通过 v2ray 连接 Worker
   └─> Worker 验证 vlessUuid: "abc-123-..."

4. [用户] 传输数据
   └─> Worker 记录流量: uplink=1024, downlink=2048

5. [Worker] 连接断开后上报
   └─> POST /worker/report {uuid: "abc-123-...", uplink: 1024, downlink: 2048}
       └─> [mock_node.py] 转换: "abc-123-..." → "user@example.com"
           └─> 累加流量统计

6. [Remnawave 面板] 定期轮询流量
   └─> POST /node/stats/get-users-stats (带 JWT)
       └─> 响应: {users: [{username: "user@example.com", uplink: 1024, downlink: 2048}]}
```

### 映射缺失时的处理

如果 Worker 上报的 UUID 没有对应的 userId 映射（例如主机还没同步用户），mock_node.py 会：
1. 使用 UUID 本身作为 username
2. 等待主机调用 add-users 后建立映射
3. 后续上报会正确转换

## 注意事项

1. **网络可达性** - Worker 需要能访问 mock_node.py 所在服务器
2. **用户同步顺序** - Remnawave 主机会在用户连接前同步用户，确保映射存在
3. **数据持久化** - 当前实现数据存储在内存中，重启会丢失
4. **流量重置** - 主机调用 `get-users-stats` 时可设置 `reset: true` 清零统计

## 与官方 Node 的区别

| 功能 | 官方 Node | mock_node.py |
|------|-----------|--------------|
| 协议后端 | Xray Core | 无（接收 Worker 上报） |
| 流量来源 | Xray gRPC API | Worker HTTP 上报 |
| 用户管理 | 写入 Xray | 仅记录映射 |
| 部署方式 | Docker | Python 脚本 |

## 故障排查

### Worker 无法上报

```bash
# 检查网络连通性
curl -X POST http://your-server:2222/worker/report \
  -H "Content-Type: application/json" \
  -d '{"uuid":"test-uuid","uplink":100,"downlink":200}'
```

### JWT 验证失败

```bash
# 检查 JWT 公钥是否正确加载
# 启用 debug 日志
python mock_node.py --port 2222 --secret-key "..." --debug
```

### 流量统计为空

1. 检查 `/mappings` 接口是否有映射
2. 确认主机已调用 `/node/handler/add-users`
3. 检查 Worker 是否正确配置 `STATS_REPORT_URL`
