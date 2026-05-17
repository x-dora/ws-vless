#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法:
  bash tools/proxy_concurrent_test.sh [选项]

选项:
  -x, --proxy URL          代理地址 (默认: http://127.0.0.1:10808)
  -n, --per-target N       每个目标请求次数 (默认: 8)
  -c, --concurrency N      全局并发数 (默认: 8)
  -t, --timeout SEC        单次请求超时秒数 (默认: 20)
  -o, --output-dir DIR     输出目录 (默认: logs)
  -u, --url URL            目标地址，可重复传入；未传时使用内置 4 个目标
      --no-insecure        关闭 HTTPS 的 -k
  -h, --help               显示帮助

示例:
  bash tools/proxy_concurrent_test.sh
  bash tools/proxy_concurrent_test.sh -n 20 -c 16
  bash tools/proxy_concurrent_test.sh -u https://example.com -u http://1.1.1.1
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1" >&2
    exit 1
  fi
}

is_pos_int() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

PROXY="http://127.0.0.1:10808"
PER_TARGET=8
CONCURRENCY=8
TIMEOUT=20
OUTPUT_DIR="logs"
INSECURE=1

TARGETS=()
DEFAULT_TARGETS=(
  "https://www.google.com"
  "https://www.cloudflare.com/cdn-cgi/trace"
  "https://[2001:4860:482d:7700::]/"
  "http://1.1.1.1"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    -x|--proxy)
      PROXY="${2:-}"
      shift 2
      ;;
    -n|--per-target)
      PER_TARGET="${2:-}"
      shift 2
      ;;
    -c|--concurrency)
      CONCURRENCY="${2:-}"
      shift 2
      ;;
    -t|--timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    -o|--output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    -u|--url)
      TARGETS+=("${2:-}")
      shift 2
      ;;
    --no-insecure)
      INSECURE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PROXY" ]]; then
  echo "--proxy 不能为空" >&2
  exit 1
fi
if ! is_pos_int "$PER_TARGET"; then
  echo "--per-target 必须是正整数" >&2
  exit 1
fi
if ! is_pos_int "$CONCURRENCY"; then
  echo "--concurrency 必须是正整数" >&2
  exit 1
fi
if ! is_pos_int "$TIMEOUT"; then
  echo "--timeout 必须是正整数" >&2
  exit 1
fi
if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

require_cmd curl
require_cmd awk
require_cmd xargs
mkdir -p "$OUTPUT_DIR"

tmp_results="$(mktemp)"
tmp_jobs="$(mktemp)"
cleanup() {
  rm -f "$tmp_results" "$tmp_jobs"
}
trap cleanup EXIT

for url in "${TARGETS[@]}"; do
  for ((i = 1; i <= PER_TARGET; i++)); do
    printf '%s\n' "$url" >>"$tmp_jobs"
  done
done

export PROXY TIMEOUT INSECURE tmp_results
xargs -P "$CONCURRENCY" -n 1 bash -c '
url="$1"
curl_args=(-x "$PROXY" -sS -o /dev/null --max-time "$TIMEOUT" -w "%{http_code}\t%{time_total}")
if [[ "$INSECURE" == "1" && "$url" == https://* ]]; then
  curl_args+=(-k)
fi
if [[ "$url" =~ ^https://\[ ]]; then
  curl_args+=(-g)
fi

raw="$(curl "${curl_args[@]}" "$url" 2>/dev/null || true)"
if [[ -z "$raw" ]]; then
  printf "%s\tERR\t0.00\t0\n" "$url" >>"$tmp_results"
  exit 0
fi

code="${raw%%$'\''\t'\''*}"
time_s="${raw#*$'\''\t'\''}"
if [[ "$time_s" == "$raw" ]]; then
  printf "%s\tERR\t0.00\t0\n" "$url" >>"$tmp_results"
  exit 0
fi

time_ms="$(awk -v t="$time_s" "BEGIN { printf \"%.2f\", t * 1000 }")"
ok=0
if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
  ok=1
fi
printf "%s\t%s\t%s\t%s\n" "$url" "$code" "$time_ms" "$ok" >>"$tmp_results"
' _ <"$tmp_jobs"

timestamp="$(date +%Y%m%d-%H%M%S)"
raw_log="$OUTPUT_DIR/proxy-concurrent-$timestamp.tsv"
summary_log="$OUTPUT_DIR/proxy-concurrent-$timestamp.summary.txt"

{
  printf "url\tcode\ttime_ms\tok\n"
  cat "$tmp_results"
} >"$raw_log"

{
  echo "=== Proxy Concurrent Test ==="
  echo "Proxy: $PROXY"
  echo "Per target: $PER_TARGET"
  echo "Concurrency: $CONCURRENCY"
  echo "Timeout(sec): $TIMEOUT"
  echo "Raw log: $raw_log"
  echo
  awk -F '\t' '
    {
      u = $1
      code = $2
      ms = $3 + 0
      ok = $4 + 0
      total[u]++
      success[u] += ok
      sum_ms[u] += ms
      codes[u, code]++
    }
    END {
      printf "%-44s %6s %8s %7s %10s %s\n", "URL", "Total", "Success", "Failed", "AvgMs", "Codes"
      count = asorti(total, sorted)
      for (i = 1; i <= count; i++) {
        u = sorted[i]
        failed = total[u] - success[u]
        avg = (total[u] > 0 ? sum_ms[u] / total[u] : 0)
        code_text = ""
        sep = ""
        for (k in codes) {
          split(k, parts, SUBSEP)
          if (parts[1] == u) {
            code_text = code_text sep parts[2] "x" codes[k]
            sep = ", "
          }
        }
        printf "%-44s %6d %8d %7d %10.2f %s\n", u, total[u], success[u], failed, avg, code_text
      }
    }
  ' "$tmp_results"
  echo
  if awk -F '\t' '$4 == 0 { found = 1 } END { exit !found }' "$tmp_results"; then
    echo "失败样例(最多 20 条):"
    awk -F '\t' '$4 == 0 { printf "- %s code=%s time_ms=%s\n", $1, $2, $3 }' "$tmp_results" | head -n 20
  else
    echo "无失败请求。"
  fi
} | tee "$summary_log"

echo
echo "Summary log: $summary_log"
