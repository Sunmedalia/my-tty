# 工作规则

- 构建：`zig build`。测试：`zig test src/tests.zig`。
- 端到端：`./scripts/smoke.sh`。浏览器回归：`./scripts/browser_test.sh`（先 `npm --prefix tests/browser ci`）。
- 发布：`./scripts/build-release.sh`。
- 不使用 `zig build test`，也不在 build.zig 里加自定义 test/run step。
- 依赖只用 Zig 标准库；平台只支持 Linux。
- 不在本仓库加入任何 TLS/证书/反向代理配置。
