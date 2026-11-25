#!/usr/bin/env bash
# 发布构建：ReleaseSafe + strip，并打印体积。
# 用法：./scripts/build-release.sh [target]
#   ./scripts/build-release.sh                    # 本机架构
#   ./scripts/build-release.sh aarch64-linux      # 交叉编译到 ARM64
#   ./scripts/build-release.sh arm-linux-musleabihf
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-}"
if [ -n "$target" ]; then
  zig build -Doptimize=safe -Dstrip=true -Dtarget="$target"
else
  zig build -Doptimize=safe -Dstrip=true
fi
ls -lh zig-out/bin/my-tty
