#!/usr/bin/env bash
set -euo pipefail

# 切换到项目根目录
cd "$(dirname "$0")/.."

echo "正在检查环境..."

# 检查 10808 端口是否打开
if ! (echo > /dev/tcp/127.0.0.1/10808) >/dev/null 2>&1; then
  echo "--------------------------------------------------------" >&2
  echo "错误: 10808 端口未打开！" >&2
  echo "请先启动代理软件（如 v2rayN / clash 等），并监听 10808 端口。" >&2
  echo "--------------------------------------------------------" >&2
  exit 1
fi

REMOTE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      REMOTE=1
      shift
      ;;
    -h|--help)
      echo "用法: bash tools/quick_test.sh [--remote]"
      echo "选项:"
      echo "  --remote    启动远程测试服务 (使用 --remote --port 8787)"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

WRANGLER_PID=""
WRANGLER_LOG="$(mktemp)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ "${_CLEANUP_DONE:-0}" == "1" ]]; then return; fi
  _CLEANUP_DONE=1

  if [[ -n "$WRANGLER_PID" ]]; then
    echo ""
    echo "关闭自动启动的测试服务 (PID: $WRANGLER_PID)..."
    # 在有些环境中可能会残留 node 进程，尽量通过 SIGTERM 关闭
    kill "$WRANGLER_PID" 2>/dev/null || true

    echo "============================================================"
    echo "Wrangler 服务日志:"
    echo "------------------------------------------------------------"
    cat "$WRANGLER_LOG" 2>/dev/null || true
    echo "============================================================"
  fi
  if [[ -n "${WRANGLER_LOG:-}" && -f "$WRANGLER_LOG" ]]; then
    rm -f "$WRANGLER_LOG"
  fi
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# 检查 8787 端口
if ! (echo > /dev/tcp/127.0.0.1/8787) >/dev/null 2>&1; then
  if [[ "$REMOTE" -eq 1 ]]; then
    echo "8787 端口未打开，正在启动远程测试服务..."
    echo "> pnpx wrangler dev --remote --port 8787"
    pnpx wrangler dev --remote --port 8787 > "$WRANGLER_LOG" 2>&1 &
    WRANGLER_PID=$!
  else
    echo "8787 端口未打开，正在启动本机生产测试服务..."
    echo "> pnpx wrangler dev --port 8787"
    pnpx wrangler dev --port 8787 > "$WRANGLER_LOG" 2>&1 &
    WRANGLER_PID=$!
  fi

  echo "等待服务启动 (最多 30 秒)..."
  ready=0
  for i in {1..30}; do
    if (echo > /dev/tcp/127.0.0.1/8787) >/dev/null 2>&1; then
      ready=1
      echo "服务已启动！"
      break
    fi
    sleep 1
  done

  if [[ "$ready" -eq 0 ]]; then
    echo "错误: 服务启动超时，请手动检查代码或尝试执行 wrangler 命令。" >&2
    exit 1
  fi
  # 额外给 worker 一点初始化时间
  sleep 2
else
  echo "8787 端口已打开，将直接使用现有服务进行测试。"
fi

echo ""
echo "正在预热 Worker 服务..."
# 发生并发请求前先执行一次简单的单次请求预热，避免 wrangler dev 冷启动被阻塞
curl -x http://127.0.0.1:10808 -sS -I -o /dev/null http://www.so.com >/dev/null 2>&1 || true

echo "============================================================"
echo "开始执行代理请求测试..."
echo "============================================================"

TARGETS=(
  "http://www.so.com"
  # "http://www.baidu.com"
  # "http://www.360.com"
  "http://www.cloudflare.com/cdn-cgi/trace"
  "http://ipv6.ddnspod.com/"
  "http://1.1.1.1"
)

printf "%-42s | %-10s | %s\n" "URL" "STATUS" "TIME"
printf "%s\n" "------------------------------------------------------------"

PIDS=()
for i in "${!TARGETS[@]}"; do
  url="${TARGETS[$i]}"
  (
    # 构造 curl 参数，使用 -X HEAD 避免混入响应头，并设置 10 秒超时
    CURL_CMD=(curl -x http://127.0.0.1:10808 -sS -o /dev/null -w "%{http_code}\t%{time_total}")

    if [[ "$url" == https* ]]; then
      CURL_CMD+=(-k)
    fi
    if [[ "$url" == *\[*\]* ]]; then
      CURL_CMD+=(-g)
    fi
    CURL_CMD+=("$url")

    # 执行请求
    res="$("${CURL_CMD[@]}" 2>/dev/null)" || true

    code="${res%%$'\t'*}"
    time="${res#*$'\t'}"
    if [[ "$code" == "000" || -z "$code" ]]; then
      code="FAILED"
    fi
    printf "%-42s | %-10s | %ss\n" "$url" "$code" "$time" > "$TMP_DIR/$i.out"
  ) &
  PIDS+=($!)
done

wait "${PIDS[@]}" 2>/dev/null || true

# 按原顺序输出结果
for i in "${!TARGETS[@]}"; do
  if [[ -f "$TMP_DIR/$i.out" ]]; then
    cat "$TMP_DIR/$i.out"
  fi
done

echo "============================================================"
echo "测试完成！"
