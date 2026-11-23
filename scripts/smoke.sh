#!/usr/bin/env bash
# 端到端冒烟：真实二进制 + 真实 PTY + 真实 WebSocket。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-17387}"
PASSWORD="smoke-pass-$(date +%s)"
BIN="./zig-out/bin/my-tty"
ROOT="$(mktemp -d)"
COOKIE_JAR="$(mktemp)"
LOG="$(mktemp)"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT" "$LOG" "$COOKIE_JAR"
}
trap cleanup EXIT

zig build

"$BIN" --host 127.0.0.1 --port "$PORT" --password "$PASSWORD" --root "$ROOT" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

echo "== healthz =="
curl -fsS "http://127.0.0.1:$PORT/healthz"
echo "== index =="
curl -fsS "http://127.0.0.1:$PORT/" | grep -q 'id="workspace"' && echo "index: PASS"
echo "== embedded vendor =="
curl -fsS "http://127.0.0.1:$PORT/vendor/xterm/xterm.js" -o /dev/null \
  && echo "xterm.js: PASS"
echo "== security headers =="
curl -fsSI "http://127.0.0.1:$PORT/" | grep -qi 'x-content-type-options: nosniff' \
  && echo "headers: PASS"
echo "== auth =="
code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/fs/list?path=")
[ "$code" = "401" ] && echo "unauthenticated blocked: PASS"
curl -fsS -c "$COOKIE_JAR" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$PORT/api/auth/login" | grep -q '"ok":true' \
  && echo "login: PASS"
code=$(curl -sS -o /dev/null -w '%{http_code}' -c /dev/null -H 'content-type: application/json' \
  -d '{"password":"wrong"}' "http://127.0.0.1:$PORT/api/auth/login")
[ "$code" = "401" ] && echo "wrong password rejected: PASS"

echo "== fs api =="
API="http://127.0.0.1:$PORT/api/fs"
curl -fsS -b "$COOKIE_JAR" "$API/list?path=" | grep -q '"entries"' && echo "list: PASS"
curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary 'smoke content' "$API/write?path=note.txt" | grep -q '"ok":true'   && echo "write: PASS"
curl -fsS -b "$COOKIE_JAR" "$API/read?path=note.txt" | grep -q 'smoke content' && echo "read: PASS"
curl -fsS -X POST -b "$COOKIE_JAR" "$API/mkdir?path=a/b" | grep -q '"ok":true' && echo "mkdir: PASS"
curl -fsS -X POST -b "$COOKIE_JAR" "$API/rename?from=note.txt&to=a/note.txt" | grep -q '"ok":true'   && echo "rename: PASS"
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/read?path=../etc/passwd")
[ "$code" = "400" ] && echo "traversal blocked: PASS"
curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=a" | grep -q '"ok":true' && echo "delete: PASS"

echo "== websocket + pty =="
node scripts/ws_test.mjs "http://127.0.0.1:$PORT" "$PASSWORD" "MYTTY_RESULT_OK" "Linux" "/dev/pts/"

echo "== logout =="
curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "http://127.0.0.1:$PORT/api/auth/logout" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/list?path=")
[ "$code" = "401" ] && echo "logout invalidates session: PASS"

echo
echo "全部通过（服务端日志见下方）"
sed -n '1,20p' "$LOG"
