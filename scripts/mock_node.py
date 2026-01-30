#!/usr/bin/env python3
"""
Remnawave Node 模拟器 (HTTPS + mTLS)
完整模拟 remnawave/node 节点行为

功能：
1. HTTPS + mTLS 双向认证
2. JWT Bearer Token 验证
3. 接收 Worker 流量上报
4. 响应 Remnawave 主机轮询
5. 数据持久化（JSON 文件）

使用方法：
    # 完整模式（mTLS + JWT）
    python mock_node.py --port 2222 --secret-key "eyJub2Rl..."

    # 简化模式（仅 HTTPS，无 mTLS）
    python mock_node.py --port 2222 --secret-key "eyJub2Rl..." --no-mtls
    
    # 开发模式（HTTP，无认证）
    python mock_node.py --port 2222 --no-auth

    # 指定数据文件
    python mock_node.py --port 2222 --data-file /path/to/stats.json

SECRET_KEY 格式 (base64 编码的 JSON):
{
    "nodeCertPem": "-----BEGIN CERTIFICATE-----...",
    "nodeKeyPem": "-----BEGIN PRIVATE KEY-----...", 
    "caCertPem": "-----BEGIN CERTIFICATE-----...",
    "jwtPublicKey": "-----BEGIN PUBLIC KEY-----..."
}
"""

import argparse
import base64
import gzip
import json
import logging
import ssl
import tempfile
import threading
import time
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from urllib.parse import urlparse, parse_qs

# 尝试导入 zstd 库（用于解压缩）
try:
    import zstandard as zstd
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False
    print("提示: zstandard 未安装，zstd 压缩请求将无法处理。安装: pip install zstandard")

# 尝试导入 JWT 库（用于验证）
try:
    import jwt
    HAS_JWT = True
except ImportError:
    HAS_JWT = False
    print("警告: PyJWT 未安装，JWT 验证将被跳过。安装: pip install PyJWT cryptography")

# ============================================================================
# 配置
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


@dataclass
class UserStats:
    """用户流量统计
    
    注意：username 是 Remnawave 的 userId，不是 vless UUID
    """
    username: str         # Remnawave userId (不是 UUID!)
    uplink: int = 0       # 上行流量（字节）
    downlink: int = 0     # 下行流量（字节）
    connections: int = 0  # 连接次数
    last_seen: float = field(default_factory=time.time)


class UUIDMapping:
    """UUID -> userId 映射
    
    Worker 只知道 vless UUID，但流量统计需要用 Remnawave userId。
    这个类维护 UUID 到 userId 的映射关系。
    """
    
    def __init__(self):
        self._uuid_to_user: dict[str, str] = {}
        self._user_to_uuid: dict[str, str] = {}
        self._lock = threading.Lock()
    
    def add_mapping(self, uuid: str, user_id: str):
        """添加 UUID -> userId 映射"""
        uuid_lower = uuid.lower()
        with self._lock:
            self._uuid_to_user[uuid_lower] = user_id
            self._user_to_uuid[user_id] = uuid_lower
    
    def get_user_id(self, uuid: str) -> str:
        """从 UUID 获取 userId，如果没有映射则返回 UUID 本身"""
        with self._lock:
            return self._uuid_to_user.get(uuid.lower(), uuid)
    
    def get_uuid(self, user_id: str) -> Optional[str]:
        """从 userId 获取 UUID"""
        with self._lock:
            return self._user_to_uuid.get(user_id)
    
    def remove_by_uuid(self, uuid: str):
        """删除映射"""
        uuid_lower = uuid.lower()
        with self._lock:
            if uuid_lower in self._uuid_to_user:
                user_id = self._uuid_to_user.pop(uuid_lower)
                self._user_to_uuid.pop(user_id, None)
    
    def get_all_mappings(self) -> dict:
        """获取所有映射"""
        with self._lock:
            return dict(self._uuid_to_user)


class StatsStore:
    """流量统计存储（线程安全，支持持久化）
    
    维护两种统计（与 Xray 一致）：
    1. 用户统计 (get-users-stats): 按 userId 统计
    2. 出入站统计 (get-combined-stats): 按 inbound/outbound tag 统计
    """
    
    # 默认的出入站 tag
    DEFAULT_INBOUND_TAG = "VLESS_WS"
    DEFAULT_OUTBOUND_TAG = "DIRECT"
    
    def __init__(self, data_file: Optional[str] = None):
        self._stats: dict[str, UserStats] = {}
        self._lock = threading.Lock()
        self._start_time = time.time()
        self._uuid_mapping = UUIDMapping()
        self._data_file = data_file or "stats_data.json"
        self._save_interval = 60  # 每 60 秒自动保存
        self._last_save = time.time()
        self._dirty = False  # 标记是否有未保存的更改
        
        # 当前使用的出入站 tag（从 xrayConfig 获取）
        self._current_inbound_tag = self.DEFAULT_INBOUND_TAG
        self._current_outbound_tag = self.DEFAULT_OUTBOUND_TAG
        
        # 出入站统计（独立于用户统计）
        # 格式: { tag: { "uplink": int, "downlink": int } }
        self._inbound_stats: dict[str, dict] = {}
        self._outbound_stats: dict[str, dict] = {}
        
        # 加载持久化数据
        self._load_data()
        
        # 启动自动保存线程
        self._start_auto_save()
    
    def _load_data(self):
        """从文件加载数据"""
        if not os.path.exists(self._data_file):
            logger.info(f"数据文件不存在，将创建: {self._data_file}")
            return
        
        try:
            with open(self._data_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 恢复用户统计
            for user_data in data.get('users', []):
                user = UserStats(
                    username=user_data['username'],
                    uplink=user_data.get('uplink', 0),
                    downlink=user_data.get('downlink', 0),
                    connections=user_data.get('connections', 0),
                    last_seen=user_data.get('last_seen', time.time())
                )
                self._stats[user.username] = user
            
            # 恢复 UUID 映射
            for uuid, user_id in data.get('mappings', {}).items():
                self._uuid_mapping.add_mapping(uuid, user_id)
            
            # 恢复出入站统计
            self._inbound_stats = data.get('inbound_stats', {})
            self._outbound_stats = data.get('outbound_stats', {})
            
            logger.info(f"已加载 {len(self._stats)} 个用户统计, {len(data.get('mappings', {}))} 个映射")
        except Exception as e:
            logger.error(f"加载数据失败: {e}")
    
    def _save_data(self):
        """保存数据到文件"""
        try:
            with self._lock:
                data = {
                    'users': [
                        {
                            'username': u.username,
                            'uplink': u.uplink,
                            'downlink': u.downlink,
                            'connections': u.connections,
                            'last_seen': u.last_seen,
                        }
                        for u in self._stats.values()
                    ],
                    'mappings': self._uuid_mapping.get_all_mappings(),
                    'inbound_stats': self._inbound_stats,
                    'outbound_stats': self._outbound_stats,
                    'saved_at': datetime.now().isoformat(),
                }
            
            # 写入临时文件后重命名（原子操作）
            temp_file = self._data_file + '.tmp'
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(temp_file, self._data_file)
            
            self._dirty = False
            logger.debug(f"数据已保存到 {self._data_file}")
        except Exception as e:
            logger.error(f"保存数据失败: {e}")
    
    def _start_auto_save(self):
        """启动自动保存线程"""
        def auto_save_loop():
            while True:
                time.sleep(self._save_interval)
                if self._dirty:
                    self._save_data()
        
        thread = threading.Thread(target=auto_save_loop, daemon=True)
        thread.start()
    
    def save_now(self):
        """立即保存数据"""
        self._save_data()
    
    @property
    def uuid_mapping(self) -> UUIDMapping:
        return self._uuid_mapping
    
    def report(self, identifier: str, uplink: int, downlink: int, is_uuid: bool = True,
                inbound_tag: str = None, outbound_tag: str = None):
        """上报用户流量
        
        Args:
            identifier: 用户标识（UUID 或 userId）
            uplink: 上行流量（字节）
            downlink: 下行流量（字节）
            is_uuid: identifier 是否是 UUID（True 时会尝试转换为 userId）
            inbound_tag: 入站 tag（用于出入站统计，默认使用 xrayConfig 中的）
            outbound_tag: 出站 tag（用于出入站统计，默认使用 xrayConfig 中的）
        """
        # 如果是 UUID，尝试转换为 userId
        if is_uuid:
            username = self._uuid_mapping.get_user_id(identifier)
        else:
            username = identifier
        
        # 使用 xrayConfig 设置的标签或默认值
        inbound_tag = inbound_tag or self._current_inbound_tag
        outbound_tag = outbound_tag or self._current_outbound_tag
        
        with self._lock:
            # 更新用户统计
            if username not in self._stats:
                self._stats[username] = UserStats(username=username)
            
            user = self._stats[username]
            user.uplink += uplink
            user.downlink += downlink
            user.connections += 1
            user.last_seen = time.time()
            
            # 更新出入站统计（与用户统计独立）
            # 入站: 接收客户端数据 = uplink
            if inbound_tag not in self._inbound_stats:
                self._inbound_stats[inbound_tag] = {"uplink": 0, "downlink": 0}
            self._inbound_stats[inbound_tag]["uplink"] += uplink
            self._inbound_stats[inbound_tag]["downlink"] += downlink
            
            # 出站: 发送到远程 = downlink（从服务器角度）
            if outbound_tag not in self._outbound_stats:
                self._outbound_stats[outbound_tag] = {"uplink": 0, "downlink": 0}
            self._outbound_stats[outbound_tag]["uplink"] += uplink
            self._outbound_stats[outbound_tag]["downlink"] += downlink
            
            self._dirty = True  # 标记需要保存
            
            logger.info(f"流量上报: {username} ↑{uplink} ↓{downlink} (累计 ↑{user.uplink} ↓{user.downlink})")
    
    def get_users_stats(self, reset: bool = False) -> list[dict]:
        """获取所有用户流量统计（remnawave 格式）"""
        with self._lock:
            result = []
            for user in self._stats.values():
                # 只返回有流量的用户
                if user.uplink > 0 or user.downlink > 0:
                    result.append({
                        "username": user.username,
                        "uplink": user.uplink,
                        "downlink": user.downlink,
                    })
            
            if reset:
                # 重置用户统计（不影响出入站统计）
                for user in self._stats.values():
                    user.uplink = 0
                    user.downlink = 0
                logger.info(f"用户流量统计已重置，返回 {len(result)} 条记录")
            
            return result
    
    def get_combined_stats(self, reset: bool = False) -> dict:
        """获取出入站流量统计（remnawave 格式）
        
        返回格式:
        {
            "inbounds": [{"inbound": "tag", "uplink": N, "downlink": N}],
            "outbounds": [{"outbound": "tag", "uplink": N, "downlink": N}]
        }
        """
        with self._lock:
            inbounds = []
            outbounds = []
            
            # 转换入站统计
            for tag, stats in self._inbound_stats.items():
                if stats["uplink"] > 0 or stats["downlink"] > 0:
                    inbounds.append({
                        "inbound": tag,
                        "uplink": stats["uplink"],
                        "downlink": stats["downlink"],
                    })
            
            # 转换出站统计
            for tag, stats in self._outbound_stats.items():
                if stats["uplink"] > 0 or stats["downlink"] > 0:
                    outbounds.append({
                        "outbound": tag,
                        "uplink": stats["uplink"],
                        "downlink": stats["downlink"],
                    })
            
            if reset:
                # 重置出入站统计（不影响用户统计）
                for stats in self._inbound_stats.values():
                    stats["uplink"] = 0
                    stats["downlink"] = 0
                for stats in self._outbound_stats.values():
                    stats["uplink"] = 0
                    stats["downlink"] = 0
                logger.info(f"出入站统计已重置，返回 {len(inbounds)} 入站, {len(outbounds)} 出站")
            
            return {
                "inbounds": inbounds,
                "outbounds": outbounds,
            }
    
    def set_tags_from_xray_config(self, xray_config: dict) -> tuple[str, str]:
        """从 xrayConfig 中提取并设置出入站标签
        
        入站：使用第一个 inbound 的 tag
        出站：使用 protocol 为 freedom 的 outbound 的 tag，没有则用第一个
        
        Returns:
            (inbound_tag, outbound_tag)
        """
        inbound_tag = self.DEFAULT_INBOUND_TAG
        outbound_tag = self.DEFAULT_OUTBOUND_TAG
        
        # 提取入站标签（第一个）
        inbounds = xray_config.get('inbounds', [])
        if inbounds and len(inbounds) > 0:
            first_inbound = inbounds[0]
            if 'tag' in first_inbound:
                inbound_tag = first_inbound['tag']
        
        # 提取出站标签（protocol 为 freedom 的，或第一个）
        outbounds = xray_config.get('outbounds', [])
        if outbounds and len(outbounds) > 0:
            # 先找 protocol 为 freedom 的
            for outbound in outbounds:
                if outbound.get('protocol') == 'freedom' and 'tag' in outbound:
                    outbound_tag = outbound['tag']
                    break
            else:
                # 没找到 freedom，使用第一个
                first_outbound = outbounds[0]
                if 'tag' in first_outbound:
                    outbound_tag = first_outbound['tag']
        
        # 保存到实例
        with self._lock:
            self._current_inbound_tag = inbound_tag
            self._current_outbound_tag = outbound_tag
        
        logger.info(f"从 xrayConfig 设置标签: inbound={inbound_tag}, outbound={outbound_tag}")
        return inbound_tag, outbound_tag
    
    @property
    def current_inbound_tag(self) -> str:
        """当前使用的入站标签"""
        return self._current_inbound_tag
    
    @property
    def current_outbound_tag(self) -> str:
        """当前使用的出站标签"""
        return self._current_outbound_tag
    
    def get_system_stats(self) -> dict:
        """获取系统统计"""
        with self._lock:
            total_uplink = sum(u.uplink for u in self._stats.values())
            total_downlink = sum(u.downlink for u in self._stats.values())
            return {
                "uptime": int(time.time() - self._start_time),
                "totalUsers": len(self._stats),
                "activeUsers": sum(1 for u in self._stats.values() if time.time() - u.last_seen < 300),
                "totalUplink": total_uplink,
                "totalDownlink": total_downlink,
            }
    
    def get_all_stats(self) -> dict:
        """获取详细统计信息"""
        with self._lock:
            return {
                "users": [
                    {
                        "username": u.username,
                        "uplink": u.uplink,
                        "downlink": u.downlink,
                        "connections": u.connections,
                        "lastSeen": datetime.fromtimestamp(u.last_seen).isoformat(),
                    }
                    for u in self._stats.values()
                ],
                "system": self.get_system_stats(),
                "uuidMappings": self._uuid_mapping.get_all_mappings(),
            }


# 全局统计存储（延迟初始化）
stats_store: Optional[StatsStore] = None


def init_stats_store(data_file: Optional[str] = None):
    """初始化统计存储"""
    global stats_store
    stats_store = StatsStore(data_file)


# ============================================================================
# HTTP 请求处理
# ============================================================================

class NodeHandler(BaseHTTPRequestHandler):
    """模拟 Remnawave Node 的 HTTP 处理器"""
    
    # 配置（由 server 设置）
    jwt_public_key: Optional[str] = None
    no_auth: bool = False
    
    def log_message(self, format, *args):
        """自定义日志格式"""
        logger.debug(f"{self.address_string()} - {format % args}")
    
    def send_json(self, data: dict, status: int = 200):
        """发送 JSON 响应"""
        body = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
    
    def send_error_json(self, message: str, status: int = 400):
        """发送错误响应"""
        self.send_json({"error": message}, status)
    
    def verify_jwt(self) -> bool:
        """验证 JWT Bearer Token"""
        if self.no_auth:
            return True
        
        if not self.jwt_public_key:
            return True
        
        if not HAS_JWT:
            logger.warning("PyJWT 未安装，跳过 JWT 验证")
            return True
        
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return False
        
        token = auth_header[7:]
        
        try:
            jwt.decode(
                token, 
                self.jwt_public_key, 
                algorithms=['RS256'],
                options={"verify_exp": True}
            )
            return True
        except jwt.ExpiredSignatureError:
            logger.warning("JWT token 已过期")
            return False
        except jwt.InvalidTokenError as e:
            logger.warning(f"JWT 验证失败: {e}")
            return False
    
    def get_json_body(self) -> Optional[dict]:
        """解析 JSON 请求体（支持 zstd/gzip 压缩）"""
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        
        try:
            body = self.rfile.read(content_length)
            
            # 检查 Content-Encoding
            content_encoding = self.headers.get('Content-Encoding', '').lower()
            
            # 尝试解压缩
            if content_encoding == 'zstd' or (len(body) >= 4 and body[:4] == b'\x28\xb5\x2f\xfd'):
                # zstd 压缩（魔数: 0x28B52FFD）
                if HAS_ZSTD:
                    dctx = zstd.ZstdDecompressor()
                    body = dctx.decompress(body)
                else:
                    logger.warning("收到 zstd 压缩数据但 zstandard 未安装")
                    # 尝试直接解析（可能是误判）
            elif content_encoding == 'gzip' or (len(body) >= 2 and body[:2] == b'\x1f\x8b'):
                # gzip 压缩（魔数: 0x1F8B）
                body = gzip.decompress(body)
            
            return json.loads(body.decode('utf-8'))
        except Exception as e:
            logger.warning(f"JSON 解析失败: {e}")
            return None
    
    def do_GET(self):
        """处理 GET 请求"""
        parsed = urlparse(self.path)
        path = parsed.path
        
        # 健康检查（无需认证）
        if path == '/health' or path == '/':
            self.send_json({
                "status": "ok",
                "service": "remnawave-node-mock",
                "timestamp": datetime.now().isoformat(),
            })
            return
        
        # /node/* 路径需要 JWT 认证
        if path.startswith('/node/'):
            if not self.verify_jwt():
                self.send_error_json("Unauthorized", 401)
                return
        
        if path == '/node/stats/get-system-stats':
            self.send_json({
                "response": stats_store.get_system_stats()
            })
        
        # =====================================================================
        # Xray 控制接口（模拟）
        # =====================================================================
        
        elif path == '/node/xray/healthcheck':
            # 节点健康检查
            self.send_json({
                "response": {
                    "isAlive": True,
                    "xrayInternalStatusCached": True,  # Worker 模拟始终在线
                    "xrayVersion": "1.8.24",  # 模拟版本
                    "nodeVersion": "1.0.0-worker"  # Worker 版本标识
                }
            })
        
        elif path == '/node/xray/status':
            # Xray 状态和版本
            self.send_json({
                "response": {
                    "isRunning": True,
                    "version": "1.8.24"
                }
            })
        
        elif path == '/node/xray/stop':
            # 停止 Xray（Worker 不需要真的停止）
            logger.info("收到停止请求（Worker 模式忽略）")
            self.send_json({
                "response": {
                    "isStopped": True
                }
            })
        
        elif path == '/stats':
            # 自定义：获取详细统计（需要认证）
            if not self.verify_jwt():
                self.send_error_json("Unauthorized", 401)
                return
            self.send_json(stats_store.get_all_stats())
        
        elif path == '/mappings':
            # 自定义：获取 UUID 映射
            self.send_json(stats_store.uuid_mapping.get_all_mappings())
        
        else:
            self.send_error_json("Not Found", 404)
    
    def do_POST(self):
        """处理 POST 请求"""
        parsed = urlparse(self.path)
        path = parsed.path
        
        body = self.get_json_body()
        if body is None:
            self.send_error_json("Invalid JSON body", 400)
            return
        
        # =====================================================================
        # Worker 流量上报接口（自定义，无需 JWT）
        # =====================================================================
        
        if path == '/worker/report':
            # Worker 上报流量
            # 直接使用 vlessUuid，Remnawave 就是用 vlessUuid 作为统计标识
            uuid = body.get('uuid')
            uplink = body.get('uplink', 0)
            downlink = body.get('downlink', 0)
            # 可选的 tag 参数（用于出入站统计）
            inbound_tag = body.get('inboundTag') or 'worker'
            outbound_tag = body.get('outboundTag') or 'worker'
            
            if not uuid:
                self.send_error_json("uuid is required", 400)
                return
            
            try:
                uplink = int(uplink)
                downlink = int(downlink)
            except (ValueError, TypeError):
                self.send_error_json("uplink/downlink must be integers", 400)
                return
            
            # 直接使用 uuid，不需要转换
            stats_store.report(uuid, uplink, downlink, is_uuid=False,
                             inbound_tag=inbound_tag, outbound_tag=outbound_tag)
            
            logger.info(f"流量上报: {uuid}, ↑{uplink} ↓{downlink}")
            
            self.send_json({"success": True})
            return
        
        if path == '/worker/batch-report':
            # Worker 批量上报流量
            reports = body.get('reports', [])
            if not isinstance(reports, list):
                self.send_error_json("reports must be an array", 400)
                return
            
            count = 0
            for report in reports:
                uuid = report.get('uuid')
                uplink = report.get('uplink', 0)
                downlink = report.get('downlink', 0)
                inbound_tag = report.get('inboundTag')
                outbound_tag = report.get('outboundTag')
                
                if uuid:
                    try:
                        stats_store.report(uuid, int(uplink), int(downlink), is_uuid=False,
                                         inbound_tag=inbound_tag, outbound_tag=outbound_tag)
                        count += 1
                    except (ValueError, TypeError):
                        pass
            
            logger.info(f"批量流量上报: 处理 {count} 条记录")
            self.send_json({"success": True, "processed": count})
            return
        
        if path == '/worker/add-mapping':
            # 添加 UUID -> userId 映射
            uuid = body.get('uuid')
            user_id = body.get('userId')
            
            if not uuid or not user_id:
                self.send_error_json("uuid and userId are required", 400)
                return
            
            stats_store.uuid_mapping.add_mapping(uuid, user_id)
            logger.info(f"添加映射: {uuid} -> {user_id}")
            self.send_json({"success": True})
            return
        
        if path == '/worker/batch-add-mapping':
            # 批量添加映射
            mappings = body.get('mappings', [])
            count = 0
            for m in mappings:
                uuid = m.get('uuid')
                user_id = m.get('userId')
                if uuid and user_id:
                    stats_store.uuid_mapping.add_mapping(uuid, user_id)
                    count += 1
            logger.info(f"批量添加映射: {count} 条")
            self.send_json({"success": True, "processed": count})
            return
        
        # =====================================================================
        # Remnawave 主机轮询接口（需要 JWT）
        # =====================================================================
        
        if path.startswith('/node/'):
            if not self.verify_jwt():
                self.send_error_json("Unauthorized", 401)
                return
        
        # =====================================================================
        # Xray 控制接口（POST）
        # =====================================================================
        
        if path == '/node/xray/start':
            # 启动 Xray（Worker 模式下模拟成功）
            # 请求体包含 xrayConfig 和 internals
            logger.info("收到启动请求（Worker 模式模拟成功）")
            
            # 从 xrayConfig 中提取出入站标签
            xray_config = body.get('xrayConfig', {})
            if xray_config:
                inbound_tag, outbound_tag = stats_store.set_tags_from_xray_config(xray_config)
                logger.info(f"使用标签: inbound={inbound_tag}, outbound={outbound_tag}")
            
            self.send_json({
                "response": {
                    "isStarted": True,
                    "xrayVersion": "1.8.24",
                    "error": None,
                    "systemInfo": stats_store.get_system_stats(),
                    "node": {
                        "version": "1.0.0-worker"
                    }
                }
            })
            return
        
        if path == '/node/stats/get-users-stats':
            reset = body.get('reset', False)
            users = stats_store.get_users_stats(reset=reset)
            self.send_json({
                "response": {
                    "users": users
                }
            })
            return
        
        if path == '/node/stats/get-user-online-status':
            username = body.get('username', '')
            # 简化实现：检查最近 5 分钟内是否有活动
            with stats_store._lock:
                user = stats_store._stats.get(username)
                online = user is not None and (time.time() - user.last_seen < 300)
            self.send_json({
                "response": {
                    "online": online
                }
            })
            return
        
        if path == '/node/stats/get-inbound-stats':
            reset = body.get('reset', False)
            with stats_store._lock:
                total_up = sum(u.uplink for u in stats_store._stats.values())
                total_down = sum(u.downlink for u in stats_store._stats.values())
                if reset:
                    for u in stats_store._stats.values():
                        u.uplink = 0
                        u.downlink = 0
            self.send_json({
                "response": {
                    "inbound": body.get('tag', 'worker'),
                    "uplink": total_up,
                    "downlink": total_down,
                }
            })
            return
        
        if path == '/node/stats/get-outbound-stats':
            reset = body.get('reset', False)
            with stats_store._lock:
                total_up = sum(u.uplink for u in stats_store._stats.values())
                total_down = sum(u.downlink for u in stats_store._stats.values())
                if reset:
                    for u in stats_store._stats.values():
                        u.uplink = 0
                        u.downlink = 0
            self.send_json({
                "response": {
                    "outbound": body.get('tag', 'worker'),
                    "uplink": total_up,
                    "downlink": total_down,
                }
            })
            return
        
        if path == '/node/stats/get-all-inbounds-stats':
            reset = body.get('reset', False)
            with stats_store._lock:
                total_up = sum(u.uplink for u in stats_store._stats.values())
                total_down = sum(u.downlink for u in stats_store._stats.values())
                if reset:
                    for u in stats_store._stats.values():
                        u.uplink = 0
                        u.downlink = 0
            self.send_json({
                "response": {
                    "inbounds": [{
                        "inbound": "worker",
                        "uplink": total_up,
                        "downlink": total_down,
                    }]
                }
            })
            return
        
        if path == '/node/stats/get-all-outbounds-stats':
            reset = body.get('reset', False)
            with stats_store._lock:
                total_up = sum(u.uplink for u in stats_store._stats.values())
                total_down = sum(u.downlink for u in stats_store._stats.values())
                if reset:
                    for u in stats_store._stats.values():
                        u.uplink = 0
                        u.downlink = 0
            self.send_json({
                "response": {
                    "outbounds": [{
                        "outbound": "worker",
                        "uplink": total_up,
                        "downlink": total_down,
                    }]
                }
            })
            return
        
        if path == '/node/stats/get-combined-stats':
            reset = body.get('reset', False)
            combined = stats_store.get_combined_stats(reset=reset)
            self.send_json({
                "response": combined
            })
            return
        
        # =====================================================================
        # Handler 接口（用户管理）
        # =====================================================================
        
        if path == '/node/handler/add-user':
            # 添加单个用户
            data = body.get('data', [])
            hash_data = body.get('hashData', {})
            
            if data and hash_data:
                # 从请求中提取 UUID -> username 映射
                username = data[0].get('username') if data else None
                vless_uuid = hash_data.get('vlessUuid')
                
                if username and vless_uuid:
                    stats_store.uuid_mapping.add_mapping(vless_uuid, username)
                    logger.info(f"从 add-user 添加映射: {vless_uuid} -> {username}")
            
            self.send_json({"response": {"success": True, "error": None}})
            return
        
        if path == '/node/handler/add-users':
            # 批量添加用户
            users = body.get('users', [])
            for user in users:
                user_data = user.get('userData', {})
                user_id = user_data.get('userId')
                vless_uuid = user_data.get('vlessUuid')
                
                if user_id and vless_uuid:
                    stats_store.uuid_mapping.add_mapping(vless_uuid, user_id)
            
            logger.info(f"从 add-users 添加 {len(users)} 个用户映射")
            self.send_json({"response": {"success": True, "error": None}})
            return
        
        if path == '/node/handler/remove-user':
            hash_data = body.get('hashData', {})
            vless_uuid = hash_data.get('vlessUuid')
            if vless_uuid:
                stats_store.uuid_mapping.remove_by_uuid(vless_uuid)
                logger.info(f"删除映射: {vless_uuid}")
            self.send_json({"response": {"success": True, "error": None}})
            return
        
        if path == '/node/handler/remove-users':
            users = body.get('users', [])
            for user in users:
                hash_uuid = user.get('hashUuid')
                if hash_uuid:
                    stats_store.uuid_mapping.remove_by_uuid(hash_uuid)
            logger.info(f"批量删除 {len(users)} 个用户映射")
            self.send_json({"response": {"success": True, "error": None}})
            return
        
        if path == '/node/handler/get-inbound-users':
            self.send_json({
                "response": {
                    "users": []
                }
            })
            return
        
        if path == '/node/handler/get-inbound-users-count':
            self.send_json({
                "response": {
                    "count": len(stats_store._stats)
                }
            })
            return
        
        self.send_error_json("Not Found", 404)


# ============================================================================
# 证书处理
# ============================================================================

def parse_secret_key(secret_key: str) -> dict:
    """
    解析 Remnawave SECRET_KEY
    
    SECRET_KEY 是 base64 编码的 JSON，包含：
    - nodeCertPem: 节点证书
    - nodeKeyPem: 节点私钥
    - caCertPem: CA 证书
    - jwtPublicKey: JWT 公钥
    """
    try:
        secret_key = secret_key.strip().strip('"\'')
        decoded = base64.b64decode(secret_key)
        data = json.loads(decoded)
        
        # 规范化 PEM 格式
        def normalize_pem(pem: str) -> str:
            normalized = pem.replace('\\n', '\n')
            normalized = normalized.replace('\r\n', '\n')
            return normalized.strip()
        
        result = {
            'nodeCertPem': normalize_pem(data.get('nodeCertPem', '')),
            'nodeKeyPem': normalize_pem(data.get('nodeKeyPem', '')),
            'caCertPem': normalize_pem(data.get('caCertPem', '')),
            'jwtPublicKey': normalize_pem(data.get('jwtPublicKey', '')),
        }
        
        logger.info("SECRET_KEY 解析成功")
        return result
    except Exception as e:
        logger.error(f"SECRET_KEY 解析失败: {e}")
        raise


def create_ssl_context(certs: dict, mtls: bool = True) -> ssl.SSLContext:
    """创建 SSL 上下文"""
    
    # 创建临时文件存储证书
    cert_file = tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False)
    key_file = tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False)
    ca_file = tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False)
    
    try:
        cert_file.write(certs['nodeCertPem'])
        cert_file.close()
        
        key_file.write(certs['nodeKeyPem'])
        key_file.close()
        
        ca_file.write(certs['caCertPem'])
        ca_file.close()
        
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_file.name, key_file.name)
        
        if mtls:
            # mTLS: 要求客户端证书
            context.load_verify_locations(ca_file.name)
            context.verify_mode = ssl.CERT_REQUIRED
            logger.info("启用 mTLS 认证")
        else:
            context.verify_mode = ssl.CERT_NONE
            logger.info("禁用 mTLS（仅 HTTPS）")
        
        return context
    finally:
        # 延迟删除临时文件
        def cleanup():
            time.sleep(1)
            for f in [cert_file.name, key_file.name, ca_file.name]:
                try:
                    os.unlink(f)
                except:
                    pass
        
        threading.Thread(target=cleanup, daemon=True).start()


# ============================================================================
# 服务器启动
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description='Remnawave Node 模拟器')
    parser.add_argument('--port', '-p', type=int, default=2222,
                        help='监听端口 (默认: 2222)')
    parser.add_argument('--secret-key', '-s', type=str, default=None,
                        help='Remnawave SECRET_KEY (用于 HTTPS/mTLS/JWT)')
    parser.add_argument('--no-mtls', action='store_true',
                        help='禁用 mTLS（仅使用 HTTPS + JWT）')
    parser.add_argument('--no-auth', action='store_true',
                        help='禁用所有认证（仅用于开发，使用 HTTP）')
    parser.add_argument('--data-file', type=str, default='stats_data.json',
                        help='数据持久化文件路径 (默认: stats_data.json)')
    parser.add_argument('--debug', '-d', action='store_true',
                        help='启用调试日志')
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    # 初始化统计存储（支持持久化）
    init_stats_store(args.data_file)
    
    # 创建服务器
    server = HTTPServer(('0.0.0.0', args.port), NodeHandler)
    
    # 配置认证
    if args.no_auth:
        NodeHandler.no_auth = True
        NodeHandler.jwt_public_key = None
        protocol = "HTTP"
    elif args.secret_key:
        certs = parse_secret_key(args.secret_key)
        
        # 设置 JWT 公钥
        NodeHandler.jwt_public_key = certs['jwtPublicKey']
        NodeHandler.no_auth = False
        
        # 配置 HTTPS
        ssl_context = create_ssl_context(certs, mtls=not args.no_mtls)
        server.socket = ssl_context.wrap_socket(server.socket, server_side=True)
        protocol = "HTTPS" + (" + mTLS" if not args.no_mtls else "")
    else:
        logger.warning("未提供 SECRET_KEY，使用 HTTP 模式（不推荐）")
        NodeHandler.no_auth = True
        protocol = "HTTP"
    
    logger.info("=" * 70)
    logger.info("Remnawave Node 模拟器启动")
    logger.info(f"协议: {protocol}")
    logger.info(f"监听: {'https' if 'HTTPS' in protocol else 'http'}://0.0.0.0:{args.port}")
    logger.info(f"JWT 验证: {'启用' if NodeHandler.jwt_public_key else '禁用'}")
    logger.info(f"数据文件: {os.path.abspath(args.data_file)}")
    logger.info("=" * 70)
    logger.info("")
    logger.info("Worker 上报接口（无需 JWT）:")
    logger.info(f"  POST /worker/report")
    logger.info(f"       {{\"uuid\": \"vless-uuid\", \"uplink\": 1024, \"downlink\": 2048}}")
    logger.info(f"  POST /worker/batch-report")
    logger.info(f"       {{\"reports\": [...]}}")
    logger.info(f"  POST /worker/add-mapping")
    logger.info(f"       {{\"uuid\": \"vless-uuid\", \"userId\": \"remnawave-user-id\"}}")
    logger.info("")
    logger.info("Remnawave 主机 API（需要 JWT）:")
    logger.info(f"  POST /node/stats/get-users-stats  {{\"reset\": false}}")
    logger.info(f"  POST /node/handler/add-users      (自动提取 UUID->userId 映射)")
    logger.info("")
    logger.info("统计接口:")
    logger.info(f"  GET  /stats     (详细统计)")
    logger.info(f"  GET  /mappings  (UUID 映射)")
    logger.info(f"  GET  /health    (健康检查)")
    logger.info("=" * 70)
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("\n正在保存数据...")
        if stats_store:
            stats_store.save_now()
        logger.info("服务器关闭")
        server.shutdown()


if __name__ == '__main__':
    main()
