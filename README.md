# my-tty

单二进制的 Web 终端：Zig 提供 HTTP/WebSocket 与 Linux PTY，浏览器用 xterm.js
的 **DOM 渲染器**显示终端。静态资源在编译期打进二进制，运行时不需要 Node/npm。

当前状态（详见 `docs/plan.md`）：

| 能力 | 状态 |
|---|---|
| 登录认证（弹窗登录 / 7 天会话 / 空闲超时 / 注销） | ✅ |
| 登录限流、连接上限、Origin 校验、优雅退出 | ✅ |
| WebSocket ⇄ Linux PTY，真实 shell | ✅ |
| 内置会话保持（刷新/断线回到同一 shell，增量回放） | ✅ |
| 分屏 1–4、可拖拽分栏、最大化、字号调节 | ✅ |
| 终端搜索 / 链接 / 移动端按键条 | ✅ |
| 文件管理、文本编辑、上传（分片续传）/ 下载 / 目录 tar | ✅ |
| 配置文件 / 环境变量 / 命令行三层配置 | ✅ |

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
  "session_idle_hours": 24,
  "max_connections": 64,
  "root": "/srv/work",
  "max_sessions": 16,
  "pty_idle_minutes": 30
}
```

环境变量：`MYTTY_CONFIG`、`MYTTY_HOST`、`MYTTY_PORT`、`MYTTY_SHELL`、
`MYTTY_PASSWORD`、`MYTTY_SESSION_TTL_DAYS`、`MYTTY_SESSION_IDLE_HOURS`、
`MYTTY_MAX_CONNECTIONS`、`MYTTY_ROOT`、`MYTTY_MAX_SESSIONS`、
`MYTTY_PTY_IDLE_MINUTES`。
完整参数见 `my-tty --help`；仓库里有一份 `my-tty.example.json`。
`my-tty --check-config` 只校验配置与 root，不启动服务。

## 登录认证

- 页面打开后先出现登录弹窗；未登录时终端、文件 API、WebSocket 全部拒绝。
- 密码只保存在服务端配置里，浏览器拿到的是随机会话 Cookie：
  `HttpOnly; SameSite=Strict; Path=/`，反向代理以 HTTPS 终止时自动加 `Secure`。
- 会话默认 **7 天**，由 `--session-ttl-days` 调整（1–365）；空闲超时默认 24 小时，
  由 `--session-idle-hours` 调整（0 关闭）。
- 顶栏“注销”会同时清除服务端会话与 Cookie；所有终端随之关闭。
- 会话只存在内存中，进程重启后需要重新登录；一次性 WS 票据 30 秒失效。
  终端会话同样是内存态，进程重启后 shell 不会保留。
- 同一 IP 连续失败 5 次登录会封禁 5 分钟（429 + `Retry-After`）；
  并发连接数默认上限 64。

## 文件管理与编辑

左侧“文件”面板以 `--root`（默认当前目录）为边界，支持列目录、新建文件/目录、
重命名、递归删除、上传/下载，以及纯文本编辑（≤1 MiB，`Ctrl+S` 保存）。
上传可以点 ⇪、拖进面板，或拖到某个目录行；文件按 4 MiB 分片，带进度条和取消，
网络中断时会向服务端查询已写入偏移继续传；单个文件上限 64 MiB。
下载流式响应、带 `Content-Disposition: attachment`；目录可以下载成 `.tar`。
路径参数一律相对 root，服务端用 realpath 前缀校验，`..` 和符号链接都无法越界。
HTTP API：`GET /api/fs/list|read|download`、`PUT /api/fs/write|upload`、
`POST /api/fs/mkdir|rename`、`DELETE /api/fs/delete`。

## 分屏

`+ 分屏` 最多 4 个：2 屏左右均分；3 屏左边一个占满整高、右边上下均分；
4 屏 2×2。每个 pane 是独立的终端、WebSocket 和 PTY，关闭 pane 会回收对应 shell。
分栏可以拖拽；pane 右上角可最大化；`Ctrl+Shift+F` 搜索，`Ctrl+Shift+±` 调整字号，
`F3` 下一个匹配。移动端会显示 Esc/Tab/Ctrl/方向键/^C/^D/^L 按键条。

复制/粘贴是终端语义：

- `Ctrl+C`：**有选区时复制，没有选区时发给 shell 作为中断（SIGINT）**；复制后会清掉选区，
  所以下一次 `Ctrl+C` 就是中断。
- `Ctrl+V`、`Ctrl+Shift+V`、`Shift+Insert`：粘贴，走浏览器原生 paste 事件（xterm 处理
  bracketed paste），不需要申请剪贴板读取权限。
- `Ctrl+Insert`、`Ctrl+Shift+C`：始终复制；后者还会 `preventDefault`，避免被
  Chrome/Edge 的 DevTools“检查元素”快捷键抢走（DevTools 仍可从菜单打开）。
- 以上只绑定 Ctrl；macOS 的 `Cmd+C` / `Cmd+V` 由 xterm 走浏览器原生 copy/paste 事件，
  前端不再单独判断 `metaKey`。
- 顶栏的 `^C` 按钮直接向当前 pane 发送 `0x03`，用于 RDP/远程桌面吞掉 Ctrl、或不想用
  键盘的场景；移动端按键条里也有同样的 `^C`。

## 会话保持

不需要 tmux/screen：服务端自己维护每个 pane 的 PTY 和 512 KiB 环形输出缓冲。

- 刷新页面、网络断开后重新连接，会 attach 回**同一个 shell**，环境变量、
  工作目录、正在运行的程序都还在；服务端只回放客户端没收到的那部分字节。
- 回放不会 `reset()` 终端，也不会重建 Terminal，因此滚动位置和文本选择都保留；
  页内重连后可以直接继续复制/粘贴。
- 断开后保留 `--pty-idle-minutes`（默认 30 分钟，0 = 断开即回收）；关掉分屏按钮
  或注销会立即结束对应 shell。
- 会话只在内存里，服务端进程重启后全部失效（重新连接会得到新 shell）。
- 最多同时保留 `max_sessions` 个会话；超出时优先淘汰已退出、最久没活动的空闲会话。

## 安全边界

- 默认只监听 `127.0.0.1`；除登录端点本身外，**所有 `/api/*` 与 WebSocket 都必须携带有效会话**，否则一律 401。
- 密码比较使用定长时间实现；登录失败固定延迟 250ms，并有按 IP 的失败封禁。
- HTTP 阶段等待请求头超过 30 秒会被服务端主动断开（防 slowloris）；
  大文件上传/下载与 WebSocket 不受这个计时影响。
- 带 `Origin` 的 WebSocket 请求必须与 `Host` 一致；一次性票据防止跨站复用。
- `SIGTERM`/`SIGINT` 会停止 accept、回收所有 PTY 后退出。
- 文件管理/编辑只允许访问 `root` 下的真实路径，符号链接无法逃逸。
- 会话数受 `max_sessions` 限制；分屏上限 4。

TLS 不属于本项目：请让进程只监听回环地址，把明文 HTTP/WS 交给外部反向代理。
本项目不包含证书、TLS 代码或反向代理配置文件。

## 前端依赖

`web/vendor/xterm/` 内是 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`
的构建产物（MIT，许可证同目录）。xterm 6 默认就是 DOM renderer，因此文本可以
用浏览器原生方式选择与复制；没有引入 WebGL/Canvas addon。

前端对 xterm 6.0 做了一处输入修补：Safari 和部分输入法（如中文输入法的英文模式）
会让字符的 `input` 事件早于它自己的 `keydown`，xterm 用 `_keyDownSeen` 去重时会把
字符当成重复事件丢掉。我们在 `beforeinput` 阶段清掉这个标记，让 xterm 正常发送；
正常按键已经被 xterm `preventDefault`，不会产生 `input` 事件，因此不会重复。

`web/vendor/fonts/` 内置 JetBrains Mono v2.304（OFL 1.1）。DOM 渲染器只能靠
字体绘制方框/方块字符，系统字体（如 DejaVu）会让 `█` 和边框出现缝隙；
内置字体在创建终端前完成加载，TUI 的边框与色块才能连续。

## 验证

```sh
zig test src/tests.zig        # 配置、认证/会话、PTY 环境、协议、文件边界
./scripts/smoke.sh            # 真实进程：认证/限流、文件/分片/归档、WS+PTY、优雅退出
./scripts/browser_test.sh     # 浏览器回归（先 npm --prefix tests/browser ci 并装 chromium）
./scripts/build-release.sh    # ReleaseSafe + strip
```

CI 在 `.github/workflows/ci.yml`：格式检查、构建、单测、smoke，以及独立的浏览器任务。
