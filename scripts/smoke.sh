#!/usr/bin/env bash
# 端到端冒烟：真实二进制 + 真实登录 + 真实 PTY + 真实 WebSocket。
# 任何一个检查失败，脚本都会非零退出（set -e + pipefail）。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-17387}"
PASSWORD="smoke-pass-$(date +%s)"
BIN="./zig-out/bin/my-tty"
ROOT="$(mktemp -d)"
LOG="$(mktemp)"
COOKIE_JAR="$(mktemp)"
PID=""
BASE="http://127.0.0.1:$PORT"
API="$BASE/api/fs"

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT" "$LOG" "$COOKIE_JAR"
}
trap cleanup EXIT

pass() { echo "$1: PASS"; }

zig build

"$BIN" --host 127.0.0.1 --port "$PORT" --password "$PASSWORD" --root "$ROOT" >"$LOG" 2>&1 &
PID=$!

echo "== index =="
# 第一个真实请求自带连接重试，不单独发就绪探测请求。
curl -fsS --retry 50 --retry-connrefused --retry-delay 1 "$BASE/" | grep -q 'id="workspace"'
pass index

echo "== embedded vendor =="
curl -fsS "$BASE/vendor/xterm/xterm.js" -o /dev/null
pass xterm.js

echo "== security headers =="
curl -fsSI "$BASE/" | grep -qi 'x-content-type-options: nosniff'
pass headers

echo "== auth =="
code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/list?path=")
[ "$code" = "401" ]
pass "unauthenticated blocked"

curl -fsS -c "$COOKIE_JAR" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login" | grep -q '"ok":true'
pass login

code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"password":"wrong"}' "$BASE/api/auth/login")
[ "$code" = "401" ]
pass "wrong password rejected"

echo "== fs api =="
curl -fsS -b "$COOKIE_JAR" "$API/list?path=" | grep -q '"entries"'
pass list

curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary 'smoke content' "$API/write?path=note.txt" | grep -q '"ok":true'
pass write

curl -fsS -b "$COOKIE_JAR" "$API/read?path=note.txt" | grep -q 'smoke content'
pass read

curl -fsS -X POST -b "$COOKIE_JAR" "$API/mkdir?path=a/b" | grep -q '"ok":true'
pass mkdir

curl -fsS -X POST -b "$COOKIE_JAR" "$API/rename?from=note.txt&to=a/note.txt" | grep -q '"ok":true'
pass rename

code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/read?path=../etc/passwd")
[ "$code" = "400" ]
pass "traversal blocked"

curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=a" | grep -q '"ok":true'
pass delete

echo "== websocket + pty =="
node scripts/ws_test.mjs "$BASE" "$PASSWORD" "MYTTY_RESULT_OK" "Linux" "/dev/pts/"
pass "websocket + pty"

echo "== logout =="
curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "$BASE/api/auth/logout" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/list?path=")
[ "$code" = "401" ]
pass "logout invalidates session"

echo
echo "全部通过（服务端日志见下方）"
sed -n '1,20p' "$LOG"
