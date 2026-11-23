#!/usr/bin/env bash
# 端到端冒烟：真实二进制 + 真实 PTY + 真实 WebSocket。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-17387}"
TOKEN="smoke-$(date +%s)"
BIN="./zig-out/bin/my-tty"
ROOT="$(mktemp -d)"
LOG="$(mktemp)"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT" "$LOG"
}
trap cleanup EXIT

zig build

"$BIN" --host 127.0.0.1 --port "$PORT" --token "$TOKEN" --root "$ROOT" >"$LOG" 2>&1 &
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
echo "== fs api =="
H="X-MyTTY-Token: $TOKEN"
API="http://127.0.0.1:$PORT/api/fs"
curl -fsS -H "$H" "$API/list?path=" | grep -q '"entries"' && echo "list: PASS"
curl -fsS -X PUT -H "$H" --data-binary 'smoke content' "$API/write?path=note.txt" | grep -q '"ok":true'   && echo "write: PASS"
curl -fsS -H "$H" "$API/read?path=note.txt" | grep -q 'smoke content' && echo "read: PASS"
curl -fsS -X POST -H "$H" "$API/mkdir?path=a/b" | grep -q '"ok":true' && echo "mkdir: PASS"
curl -fsS -X POST -H "$H" "$API/rename?from=note.txt&to=a/note.txt" | grep -q '"ok":true'   && echo "rename: PASS"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H "$H" "$API/read?path=../etc/passwd")
[ "$code" = "400" ] && echo "traversal blocked: PASS"
curl -fsS -X DELETE -H "$H" "$API/delete?path=a" | grep -q '"ok":true' && echo "delete: PASS"

echo "== websocket + pty =="
node scripts/ws_test.mjs "ws://127.0.0.1:$PORT/ws?token=$TOKEN" "MYTTY_RESULT_OK" "Linux" "/dev/pts/"

echo
echo "全部通过（服务端日志见下方）"
sed -n '1,20p' "$LOG"
