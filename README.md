# my-tty

单二进制的 Web 终端：Zig 提供 HTTP/WebSocket 与 Linux PTY，浏览器用 xterm.js
的 **DOM 渲染器**显示终端。静态资源在编译期打进二进制，运行时不需要 Node/npm。

当前状态（详见 `docs/plan.md`）：

| 能力 | 状态 |
|---|---|
| 登录认证（弹窗登录 / 会话 7 天 / 主动注销） | ✅ |
| HTTP 静态资源（内嵌） | ✅ |
| WebSocket ⇄ Linux PTY，真实 shell | ✅ |
| 配置文件 / 环境变量 / 命令行三层配置 | ✅ |
| 文件管理 + 文本编辑 + 上传/下载 | ✅ |
| 分屏 1–4 终端（3 屏左一整高） | ✅ |

## 构建与运行

```sh
zig build                 # 默认 Debug；发布用 zig build -Doptimize=safe
zig test src/tests.zig
./zig-out/bin/my-tty --port 7387 --password 'change-me'
# 浏览器打开 http://127.0.0.1:7387/ ，在弹窗里输入密码
```

不传 `--password` 时会随机生成一个，并打印到终端；重启会更换。

指定 shell 与工作根目录：

```sh
./zig-out/bin/my-tty --shell /bin/zsh --root /srv/work --password 'change-me'
```

## 配置

优先级：**默认值 < 配置文件 < 环境变量 < 命令行**。
默认读取 `./my-tty.json`（不存在则跳过）。

```json
{
  "host": "127.0.0.1",
  "port": 7387,
  "shell": "/bin/bash",
  "password": "please-change-me",
  "session_ttl_days": 7,
  "root": "/srv/work",
  "max_sessions": 16
}
```

环境变量：`MYTTY_CONFIG`、`MYTTY_HOST`、`MYTTY_PORT`、`MYTTY_SHELL`、
`MYTTY_PASSWORD`、`MYTTY_SESSION_TTL_DAYS`、`MYTTY_ROOT`、
`MYTTY_MAX_SESSIONS`。完整参数见 `my-tty --help`。

## 登录认证

- 页面打开后先出现登录弹窗；未登录时终端、文件 API、WebSocket 全部拒绝。
- 密码只保存在服务端配置里，浏览器拿到的是随机会话 Cookie：
  `HttpOnly; SameSite=Strict; Path=/`，反向代理以 HTTPS 终止时自动加 `Secure`。
- 会话默认 **7 天**，由 `--session-ttl-days` / `session_ttl_days` 调整（1–365）。
- 顶栏“注销”会同时清除服务端会话与 Cookie；所有终端随之关闭。
- 会话只存在内存中，进程重启后需要重新登录。
- WebSocket 额外使用一次性票据（30 秒、用后即废），避免把长期会话放进 URL。

## 文件管理与编辑

左侧“文件”面板以 `--root`（默认当前目录）为边界，支持列目录、新建文件/目录、
重命名、递归删除、上传/下载，以及纯文本编辑（≤1 MiB，`Ctrl+S` 保存）。
上传可以点工具栏的 ⇪，也可以把文件直接拖进面板；单个文件上限 64 MiB。
下载走流式响应，带 `Content-Disposition: attachment`，不占内存。
路径参数一律相对 root，服务端用 realpath 前缀校验，`..` 和符号链接都无法越界。
HTTP API：`GET /api/fs/list|read|download`、`PUT /api/fs/write|upload`、
`POST /api/fs/mkdir|rename`、`DELETE /api/fs/delete`。

## 分屏

`+ 分屏` 最多 4 个：2 屏左右均分；3 屏左边一个占满整高、右边上下均分；
4 屏 2×2。每个 pane 是独立的终端、WebSocket 和 PTY，关闭 pane 会回收对应 shell。

## 安全边界

- 默认只监听 `127.0.0.1`；除登录端点本身外，**所有 `/api/*` 与 WebSocket 都必须携带有效会话**，否则一律 401。
- 密码比较使用定长时间实现；登录失败固定延迟 250ms，降低爆破速度。
- 文件管理/编辑只允许访问 `root` 下的真实路径，符号链接无法逃逸。
- 会话数受 `max_sessions` 限制；分屏上限 4。

TLS 不属于本项目：请让进程只监听回环地址，把明文 HTTP/WS 交给外部反向代理。
本项目不包含证书、TLS 代码或反向代理配置文件。

## 前端依赖

`web/vendor/xterm/` 内是 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`
的构建产物（MIT，许可证同目录）。xterm 6 默认就是 DOM renderer，因此文本可以
用浏览器原生方式选择与复制；没有引入 WebGL/Canvas addon。

`web/vendor/fonts/` 内置 JetBrains Mono v2.304（OFL 1.1）。DOM 渲染器只能靠
字体绘制方框/方块字符，系统字体（如 DejaVu）会让 `█` 和边框出现缝隙；
内置字体在创建终端前完成加载，TUI 的边框与色块才能连续。

## 验证

```sh
zig test src/tests.zig   # 配置、认证/会话、PTY 环境、协议、文件边界
./scripts/smoke.sh       # 真实进程：登录/注销、文件 API、WebSocket+PTY
```
