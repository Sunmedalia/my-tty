#!/usr/bin/env bash
# 浏览器回归：需要先在 tests/browser 里 npm ci 并安装 chromium。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-17389}"
PASSWORD="browser-$(date +%s)"
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

if [ ! -d tests/browser/node_modules ]; then
  echo "缺少 tests/browser/node_modules，请先执行：npm --prefix tests/browser ci" >&2
  exit 2
fi

zig build -Doptimize=safe
./zig-out/bin/my-tty --port "$PORT" --password "$PASSWORD" --root "$ROOT" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.1
done

export BASE="http://127.0.0.1:$PORT"
export PASSWORD ROOT

node tests/browser/ui.cjs
node tests/browser/tabs.cjs
node tests/browser/features.cjs
node tests/browser/clipboard.cjs
node tests/browser/session.cjs
node tests/browser/files.cjs
node tests/browser/cwd.cjs

echo "browser tests: ALL PASS"
