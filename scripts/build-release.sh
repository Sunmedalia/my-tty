#!/usr/bin/env bash
# 发布构建：ReleaseSafe + strip，并打印体积。
set -euo pipefail
cd "$(dirname "$0")/.."

zig build -Doptimize=safe
strip zig-out/bin/my-tty
ls -lh zig-out/bin/my-tty
