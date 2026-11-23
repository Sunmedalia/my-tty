# my-tty

单二进制的 Web 终端：Zig 提供 HTTP/WebSocket 与 Linux PTY，浏览器用 xterm.js
的 **DOM 渲染器**显示终端。静态资源在编译期打进二进制，运行时不需要 Node/npm。

当前状态（详见 `docs/plan.md`）：

| 能力 | 状态 |
|---|---|
| HTTP 静态资源（内嵌） | ✅ |
| WebSocket ⇄ Linux PTY，真实 shell | ✅ |
| 配置文件 / 环境变量 / 命令行三层配置 | ✅ |
| 单页终端、重连、复制粘贴快捷键 | ✅ |
| 文件管理 + 文本编辑 | ✅ |
| 分屏 1–4 终端（3 屏左一整高） | ✅ |

## 构建与运行

```sh
zig build                 # 默认 Debug；发布用 zig build -Doptimize=safe
zig test src/tests.zig
./zig-out/bin/my-tty --port 7387
# 浏览器打开 http://127.0.0.1:7387/
```

指定 shell 与工作根目录：

```sh
./zig-out/bin/my-tty --shell /bin/zsh --root /srv/work
```

## 配置

优先级：**默认值 < 配置文件 < 环境变量 < 命令行**。
默认读取 `./my-tty.json`（不存在则跳过）。

```json
{
  "host": "127.0.0.1",
  "port": 7387,
  "shell": "/bin/bash",
  "token": "please-change-me",
  "root": "/srv/work",
  "max_sessions": 16
}
```

环境变量：`MYTTY_CONFIG`、`MYTTY_HOST`、`MYTTY_PORT`、`MYTTY_SHELL`、
`MYTTY_TOKEN`、`MYTTY_ROOT`、`MYTTY_MAX_SESSIONS`。
完整参数见 `my-tty --help`。

## 安全边界

- 默认只监听 `127.0.0.1`。监听非回环地址时**必须**设置 token，否则拒绝启动。
- 配置了 token 后，进入页面的地址需要带 `?token=…`（前端会把它用于 WebSocket）。
- 令牌比较使用定长时间实现。
- 文件管理/编辑只允许访问 `root` 下的真实路径（实现时使用 realpath 前缀校验，
  符号链接无法逃逸）。
- 会话数受 `max_sessions` 限制；分屏上限 4。

TLS 不属于本项目：请让进程只监听回环地址，把明文 HTTP/WS 交给外部反向代理。
本项目不包含证书、TLS 代码或反向代理配置文件。

## 文件管理与编辑

左侧“文件”面板以 `--root`（默认当前目录）为边界，支持列目录、新建文件/目录、
重命名、递归删除，以及纯文本编辑（≤1 MiB，`Ctrl+S` 保存）。
路径参数一律相对 root，服务端用 realpath 前缀校验，`..` 和符号链接都无法越界。
HTTP API：`GET /api/fs/list|read`、`PUT /api/fs/write`、
`POST /api/fs/mkdir|rename`、`DELETE /api/fs/delete`。

## 分屏

`+ 分屏` 最多 4 个：2 屏左右均分；3 屏左边一个占满整高、右边上下均分；
4 屏 2×2。每个 pane 是独立的终端、WebSocket 和 PTY，关闭 pane 会回收对应 shell。

## 前端依赖

`web/vendor/xterm/` 内是 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`
的构建产物（MIT，许可证同目录）。xterm 6 默认就是 DOM renderer，因此文本可以
用浏览器原生方式选择与复制；没有引入 WebGL/Canvas addon。

## 验证

```sh
zig test src/tests.zig   # 配置、PTY 环境、协议解析、URL 工具
./scripts/smoke.sh # 起真实进程，curl + 真实 WebSocket 执行 echo/uname/tty
```
