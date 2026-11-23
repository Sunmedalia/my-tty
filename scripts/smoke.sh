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
UPLOAD_SRC="$(mktemp)"
UPLOAD_DST="$(mktemp)"
CHUNK_SRC="$(mktemp)"
TAR_FILE="$(mktemp)"
PID=""
BASE="http://127.0.0.1:$PORT"
API="$BASE/api/fs"

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT" "$LOG" "$COOKIE_JAR" "$UPLOAD_SRC" "$UPLOAD_DST" "$CHUNK_SRC" "$TAR_FILE" /tmp/mytty-chunk.*
}
trap cleanup EXIT

pass() { echo "$1: PASS"; }

zig build

"$BIN" --host 127.0.0.1 --port "$PORT" --password "$PASSWORD" --root "$ROOT" >"$LOG" 2>&1 &
PID=$!

echo "== index =="
# 第一个真实请求自带连接重试，不单独发就绪探测请求。
curl -fsS --retry 50 --retry-connrefused --retry-delay 1 "$BASE/" | grep -c 'id="workspace"' >/dev/null
pass index

echo "== embedded vendor =="
curl -fsS "$BASE/vendor/xterm/xterm.js" -o /dev/null
pass xterm.js

echo "== check-config =="
"$BIN" --check-config --root "$ROOT" 2>&1 | grep -c '配置检查通过' >/dev/null
pass check-config

echo "== security headers =="
curl -fsSI "$BASE/" | grep -ci 'x-content-type-options: nosniff' >/dev/null
pass headers

echo "== auth =="
for path in "/api/fs/list?path=" "/api/fs/download?path=x" "/api/fs/upload?path=x" "/api/auth/status" "/api/auth/ticket" "/api/auth/logout"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X GET "$BASE$path")
  [ "$code" = "401" ]
done
pass "all APIs except login require auth"

curl -fsS -c "$COOKIE_JAR" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login" | grep -c '"ok":true' >/dev/null
pass login

code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"password":"wrong"}' "$BASE/api/auth/login")
[ "$code" = "401" ]
pass "wrong password rejected"

echo "== fs api =="
curl -fsS -b "$COOKIE_JAR" "$API/list?path=" | grep -c '"entries"' >/dev/null
pass list

curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary 'smoke content' "$API/write?path=note.txt" | grep -c '"ok":true' >/dev/null
pass write

curl -fsS -b "$COOKIE_JAR" "$API/read?path=note.txt" | grep -c 'smoke content' >/dev/null
pass read

curl -fsS -X POST -b "$COOKIE_JAR" "$API/mkdir?path=a/b" | grep -c '"ok":true' >/dev/null
pass mkdir

curl -fsS -X POST -b "$COOKIE_JAR" "$API/rename?from=note.txt&to=a/note.txt" | grep -c '"ok":true' >/dev/null
pass rename

code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/read?path=../etc/passwd")
[ "$code" = "400" ]
pass "traversal blocked"

curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=a" | grep -c '"ok":true' >/dev/null
pass delete

printf 'UPLOAD_CONTENT_123' > "$UPLOAD_SRC"
curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary @"$UPLOAD_SRC" "$API/upload?path=up.bin" | grep -c '"ok":true' >/dev/null
pass upload
curl -fsS -b "$COOKIE_JAR" "$API/download?path=up.bin" -o "$UPLOAD_DST"
cmp -s "$UPLOAD_SRC" "$UPLOAD_DST"
pass "download round-trip"
curl -sS -D - -o /dev/null -b "$COOKIE_JAR" "$API/download?path=up.bin" | grep -ci 'content-disposition: attachment' >/dev/null
pass "download headers"
curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=up.bin" | grep -c '"ok":true' >/dev/null
pass "cleanup upload"

echo "== chunked upload =="
dd if=/dev/zero of="$CHUNK_SRC" bs=1024 count=3000 2>/dev/null
rm -f /tmp/mytty-chunk.*
split -b 2000000 "$CHUNK_SRC" /tmp/mytty-chunk.
off=0
total=$(stat -c%s "$CHUNK_SRC")
for part in /tmp/mytty-chunk.*; do
  size=$(stat -c%s "$part")
  curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary @"$part" \
    "$API/upload?path=chunk.bin&id=abcdef0123456789&offset=$off&total=$total" >/dev/null
  off=$((off + size))
done
cmp -s "$CHUNK_SRC" "$ROOT/chunk.bin"
pass "chunked upload"
curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=chunk.bin" >/dev/null

echo "== archive =="
curl -fsS -X POST -b "$COOKIE_JAR" "$API/mkdir?path=tardir" >/dev/null
printf 'ARCHIVE_FILE' | curl -fsS -X PUT -b "$COOKIE_JAR" --data-binary @- "$API/upload?path=tardir/a.txt" >/dev/null
curl -fsS -b "$COOKIE_JAR" "$API/archive?path=tardir" -o "$TAR_FILE"
tar -tf "$TAR_FILE" | grep -c 'tardir/a.txt' >/dev/null
pass archive
curl -fsS -X DELETE -b "$COOKIE_JAR" "$API/delete?path=tardir" >/dev/null

echo "== origin check =="
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -H 'Origin: https://evil.example' \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  "$BASE/ws?ticket=deadbeef")
[ "$code" = "403" ]
pass "cross-origin websocket rejected"

echo "== websocket + pty =="
node scripts/ws_test.mjs "$BASE" "$PASSWORD" "MYTTY_RESULT_OK" "Linux" "/dev/pts/"
pass "websocket + pty"

echo "== logout =="
curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "$BASE/api/auth/logout" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$API/list?path=")
[ "$code" = "401" ]
pass "logout invalidates session"

echo "== login rate limit =="
for _ in 1 2 3 4 5; do
  curl -sS -o /dev/null -H 'content-type: application/json' -d '{"password":"bad"}' "$BASE/api/auth/login"
done
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"password":"bad"}' "$BASE/api/auth/login")
[ "$code" = "429" ]
pass "login rate limit"

echo "== graceful shutdown =="
kill -TERM "$PID"
wait "$PID" 2>/dev/null || true
PID=""
grep -c '已退出' "$LOG" >/dev/null
pass "graceful shutdown"

echo
echo "全部通过（服务端日志见下方）"
sed -n '1,20p' "$LOG"
