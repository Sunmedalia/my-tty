# my-tty 实施计划

> 目标：一个**单二进制**、Linux 优先的 Web 终端。Zig 负责 HTTP/WS 与 PTY，
> 浏览器负责终端渲染与文件编辑。前端只用 DOM 渲染，TLS 完全在项目之外。
>
> 本文是可执行计划，不是愿景：每一步都有验收命令/标准。

---

## 1. 范围与非目标

**做：**

- 浏览器里跑真实 shell（PTY），多会话分屏（1–4 个）。
- 纯 DOM 终端渲染，保证原生选择/复制。
- 文件管理（列目录、新建、重命名、删除）与文本编辑（读写、保存）。
- 单二进制部署：静态资源 `@embedFile`，无运行时前端构建。
- 全参数配置文件 + 环境变量 + 命令行，优先级明确。

**不做（明确排除）：**

- TLS/证书/nginx 配置：进程只监听 `127.0.0.1` 明文 HTTP/WS，放在外部反向代理后面。
- 多用户/账号体系、审计、SSH 协议、Windows/macOS 支持。
- WebGL/Canvas 终端渲染器。
- 第三方后端依赖（只用 Zig 标准库）。

---

## 2. 已验证的技术地基（Zig 0.17.1）

以下不是推测，已用最小 spike 在本机跑通：

| 能力 | 结论 |
|---|---|
| `std.Io.Threaded` + `std.Io.net` + `std.http.Server` | 可建监听、逐连接 `Reader/Writer`、`receiveHead`，见 `lib/compiler/Maker/WebServer.zig` 同款写法 |
| WebSocket 服务端 | `request.upgradeRequested()` → `respondWebSocket` → `readSmallMessage` / `writeMessage`，标准库自带 |
| Linux PTY | `open("/dev/ptmx")` + `ioctl(IOCSPTLCK/IOCGPTN/IOCSWINSZ)` + `fork` + `setsid` + `ioctl(IOCSCTTY)` + `dup2` + `execve`，无需 libc |
| fork 线程安全 | 子进程只做异步信号安全系统调用（setsid/ioctl/dup2/chdir/execve），可在多线程服务中 fork |
| 端到端 | `curl` 拿到页面；Node WebSocket 客户端执行 `echo/uname/tty` 并拿到 `/dev/pts/N`，PASS |
| xterm.js 6.0.0 | 默认 `DomRenderer`（源码 `CoreBrowserTerminal._createRenderer()`），无 canvas addon；MIT |
| 配置/JSON | `std.json.parseFromSlice` 可用；文件读取走 `std.Io.Dir.readFileAlloc` |

**已知限制（设计时规避）：**

- `readSmallMessage` 要求整条消息放得进读缓冲，且不支持分片 → 前端把输入按 8 KiB 切帧，服务端缓冲 64 KiB。
- `std.posix` 在 0.17 已移除 `ioctl/fork/execve` → PTY 层直接用 `std.os.linux`，因此**只支持 Linux**（编译期 `@compileError`）。
- `@embedFile` 不能跨模块根目录 → 单独建 `web/embed.zig` 模块。

---

## 3. 架构

```
browser
 ├─ index.html / app.js / style.css
 ├─ xterm.js (DOM renderer) × N　←─ 每个 pane 一个 Terminal 实例
 ├─ file panel (DOM, textarea editor)
 │
 │  HTTP GET  /、/app.js、/vendor/*      → 内嵌静态资源
 │  HTTP     /api/fs/*                   → 文件管理/编辑（JSON）
 │  WS       /ws?ticket=…                → 一个 PTY 会话（票据 30s）
 ▼
Zig 单进程
 ├─ server.zig   路由、登录/注销、静态资源、连接线程
 ├─ auth.zig     密码登录、7 天会话、一次性 WS 票据
 ├─ session.zig  WS ⇄ PTY 桥（每会话 2 线程）
 ├─ pty.zig      /dev/ptmx + fork/exec（Linux）
 ├─ fsapi.zig    受限文件系统 API（root sandbox）
 ├─ config.zig   文件/环境/命令行三层配置
 └─ assets.zig   @embedFile 资源表
```

线程模型：**accept → 每连接一线程**；WebSocket 会话再加一条 PTY→WS 泵线程。
单机单用户场景下，这比引入异步运行时更简单、更容易证明正确。会话数由
`max_sessions` 限制（默认 16），分屏上限 4 由前端 + 会话上限双重约束。

---

## 4. 配置

优先级：**默认值 < 配置文件 < 环境变量 < 命令行**。

配置文件默认 `./my-tty.json`（存在才加载），可用 `--config` 或 `MYTTY_CONFIG` 指定；
显式指定的文件不存在 = 启动失败，默认路径不存在 = 忽略。

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

| 配置 | JSON 字段 | 环境变量 | 命令行 |
|---|---|---|---|
| 监听地址 | `host` | `MYTTY_HOST` | `--host` |
| 端口 | `port` | `MYTTY_PORT` | `--port` |
| shell | `shell` | `MYTTY_SHELL` | `--shell` |
| 登录密码 | `password` | `MYTTY_PASSWORD` | `--password` |
| 会话有效期（天） | `session_ttl_days` | `MYTTY_SESSION_TTL_DAYS` | `--session-ttl-days` |
| 文件根 | `root` | `MYTTY_ROOT` | `--root` |
| 会话上限 | `max_sessions` | `MYTTY_MAX_SESSIONS` | `--max-sessions` |

未显式配置 shell 时，才用进程 `$SHELL` 兜底（避免环境变量意外覆盖配置文件）。
未配置密码时，启动阶段生成随机密码并打印一次；所有功能都要求登录。

---

## 5. 协议

### 5.1 终端 WebSocket

- 浏览器 → 服务端
  - **二进制帧**：原始键盘/粘贴字节（前端按 8 KiB 切）。
  - **文本帧**：JSON 控制，目前只有 `{"t":"resize","cols":120,"rows":40}`。
- 服务端 → 浏览器
  - **二进制帧**：PTY 原始输出，前端直接 `term.write(Uint8Array)`。
  - **文本帧**：`{"t":"ready","pid":N}`、`{"t":"exit"}`、`{"t":"error"}`。

一个 WebSocket = 一个 PTY = 一个分屏 pane。分屏即开多条 WS，互不影响。

### 5.2 文件 API（HTTP + JSON）

所有 API 都需要登录后的会话 Cookie（浏览器自动携带）。
路径参数 `path` 一律是**相对 root** 的 POSIX 路径，服务端做规范化与真实路径校验。

| 方法 | 路径 | 语义 | 成功响应 |
|---|---|---|---|
| GET | `/api/fs/list?path=` | 列目录（目录优先，按名排序） | `{"path":"…","entries":[{"name","kind","size"}]}` |
| GET | `/api/fs/read?path=` | 读文本（≤1 MiB，含 NUL 则拒绝） | `{"path","content","size"}` |
| PUT | `/api/fs/write?path=` | 原子覆盖写（`createFileAtomic`） | `{"ok":true,"path","size"}` |
| POST | `/api/fs/mkdir?path=` | 递归建目录 | `{"ok":true}` |
| POST | `/api/fs/rename?from=&to=` | 同 root 内重命名/移动 | `{"ok":true}` |
| DELETE | `/api/fs/delete?path=` | 文件或目录（递归） | `{"ok":true}` |

错误统一 `{"error":"code"}` + 恰当 HTTP 状态：`400`（参数/路径非法）、
`401`（未登录）、`403`（越出 root）、`404`、`409`、`413`（过大）、`500`。

### 5.3 登录接口

除 `POST /api/auth/login`（登录入口，必然要求未认证）外，以下端点都要求有效会话，
未登录一律 401：

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/api/auth/login` | JSON `{"password":…}`；成功返回 `Set-Cookie` 会话，7 天（唯一免认证端点） |
| POST | `/api/auth/logout` | 删除服务端会话并清 Cookie |
| GET | `/api/auth/status` | `{"authenticated":bool}` |
| POST | `/api/auth/ticket` | 已登录时签发 30 秒一次性 WS 票据 |

WebSocket 升级既接受会话 Cookie，也接受 `?ticket=`（一次性）。

### 5.4 安全边界

- 只监听回环（默认）；所有功能都要求登录会话。
- 密码定长时间比较；登录失败固定延迟 250ms。
- 会话 Cookie：`HttpOnly; SameSite=Strict; Path=/`，反向代理为 HTTPS 时加 `Secure`。
- WebSocket 票据 30 秒、一次性；注销立即失效。
- 文件 API 以启动时 `realpath(root)` 为唯一边界；每个目标是 `realPathFileAlloc`
  后再做前缀校验，符号链接无法逃逸。新建文件先校验父目录。
- 读取上限 1 MiB；拒绝 NUL（二进制）；写请求体上限 1 MiB。
- 分屏上限 4；会话上限 `max_sessions`；每连接独立线程，避免互相阻塞。

---

## 6. 分屏

### 布局（CSS Grid）

| 数量 | 布局 |
|---|---|
| 1 | 铺满 |
| 2 | 左右均分（`1fr 1fr`） |
| 3 | **左侧一个占一半高、全高**，右侧一半再上下均分两个 |
| 4 | 2×2 均分 |

实现：`#workspace` 用 `grid-template-columns/rows` + `grid-area`；3 屏时
`grid-template-areas: "a b" "a c"`。每个 pane 是独立 DOM 容器。

### 行为

- 工具栏：`+ 分屏`（≤4 时可用）、每 pane 标题栏有关闭按钮、布局随数量自动重排。
- `ResizeObserver` → 对该 pane 的 `FitAddon.fit()` → 发 resize 控制帧。
- 焦点：点击/切换 pane 时 `term.focus()`；关闭当前 pane 后焦点落到相邻 pane。
- 每 pane 独立 WS/reconnect 状态；关闭 pane = 关闭 WS → 服务端回收 shell。
- 第 4 个之后按钮禁用，快捷键不生效。

### 验收

- 1/2/3/4 四种数量下布局尺寸符合上表（用 `getBoundingClientRect` 断言）。
- 每个 pane 可独立 `echo $$`，互不串流。
- 拖拽窗口大小后 `stty size` 与实际可见行列一致。

---

## 7. 文件面板与编辑器

- 左侧可折叠抽屉（窄屏覆盖式），树形列表：`..`、目录、文件；点击目录进入，点击文件打开。
- 编辑器：等宽 `textarea` + 行号（可选），`Ctrl+S` 保存，`Esc` 关闭并提示未保存。
- 工具栏操作：新建文件、新建目录、重命名、删除、刷新、下载？——**v1 不做上传/下载**。
- 大文件（>1 MiB）和二进制（含 NUL）只读拒绝，给出明确提示，不进入编辑器。
- 保存失败（403/409/500）保留编辑内容并在状态栏显示错误。
- 与终端共存：文件抽屉占左侧 320px，终端区自动 `fit()`。

---

## 8. 代码结构

```
my-tty/
  build.zig / build.zig.zon
  src/
    main.zig       入口：help、配置、启动
    config.zig     三层配置 + 校验（已实现）
    server.zig     路由/登录/静态资源/连接线程（已实现）
    auth.zig       密码登录、会话、WS 票据（已实现）
    session.zig    WS ⇄ PTY 协议与生命周期（已实现）
    pty.zig        Linux PTY（已实现）
    fsapi.zig      文件管理/编辑 API（待实现）
    assets.zig     资源表（已实现）
    tests.zig      测试入口
  web/
    index.html / app.js / style.css
    embed.zig      资源模块根（@embedFile 只能在模块根内）
    vendor/xterm/  xterm 6.0.0 + addon-fit 0.11.0（MIT）
  scripts/smoke.sh + ws_test.mjs
  docs/research.md + docs/plan.md
```

---

## 9. 里程碑与验收

### P0 地基（已完成）

- [x] `zig build` 通过；`zig test src/tests.zig` 通过（9 个测试）。
- [x] 页面/静态资源内嵌，HTTP 200。
- [x] WebSocket 升级 + PTY 双向数据（spike 已用 `echo/uname/tty` 验证）。
- [x] 配置：文件/环境/命令行优先级，非法值拒绝启动。
- [x] 断线/关闭时回收 shell（HUP/TERM + waitpid）。

### P0.5 登录认证（已完成）

- [x] 弹窗登录、注销按钮；除登录端点外，所有 API/WS 未登录一律 401。
- [x] 会话 7 天（可配 1–365），服务端内存会话 + HttpOnly Cookie。
- [x] 注销删除服务端会话并清 Cookie；页面刷新保持登录。
- [x] headless Chromium 验收：错误密码提示、登录、刷新保持、注销失效。

### P1 文件管理与编辑（已完成）

- [x] `fsapi.zig` 六个端点 + root sandbox + 单元测试（路径归一化、边界判断）。
- [x] 前端抽屉、目录导航、重命名/删除/新建、编辑器、`Ctrl+S` 保存。
- [x] `scripts/smoke.sh` 覆盖：list/write/read/mkdir/rename/delete + `../` 越界拦截。
- [x] 文件 API 的单元测试跑在 `zig test src/tests.zig` 里（不放 build step）。

### P2 分屏（已完成）

- [x] 终端 manager：1–4 pane 生命周期，每个 pane 独立 WS/PTY。
- [x] 四种布局像素级验收（headless Chromium 实测 `getBoundingClientRect`）。
- [x] 关闭/新增/焦点/重连；第 5 个时按钮禁用。

### P3 收尾

- [x] DOM 渲染底部裁切：去掉自定义 lineHeight，fit 后按 pane 真实边界校验并收缩行列。
- [x] TUI 图形完整性：内置 JetBrains Mono（OFL），并在创建 Terminal 前 await 字体加载，
      方块/制表符填满单元格（DejaVu 会在 `█` 与竖线处留下 1–2px 缝隙）。
- [ ] 复制/粘贴快捷键在 DOM 渲染下的手工验收（Chrome/Firefox）。
- [ ] README 完整化；`docs/research.md` 归档。
- [ ] 二进制体积与启动时间记录。

### 回归命令

```sh
zig build
zig test src/tests.zig
./scripts/smoke.sh
```

浏览器自动化（本机已验证）：headless Chromium 下断言 1/2/3/4 屏尺寸、
两个 pane 的输出互不串流、文件编辑保存落盘、页面无 console error。

仍需人工确认：DOM 终端里的鼠标选择/复制、`Ctrl+C` 不被前端吞、
中文/多行粘贴、窗口缩放后 `stty size` 与可见行列一致。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| Zig 0.17 API 仍在演进 | 只用 std 中已有且已验证的接口；PTY 走 Linux syscall，减少接口依赖 |
| 多线程 fork | 子进程零分配、只调异步信号安全函数；fork 前准备好 argv/envp |
| WS 单帧上限 | 前端 8 KiB 分片；服务端 64 KiB 缓冲；超限即断会话并提示 |
| 文件 API 越权 | realpath + 前缀校验；不跟随符号链接逃逸；写入上限；root 默认 cwd |
| 分屏把机器打爆 | 前端 4 上限 + 服务端 `max_sessions` |
| 复制体验回退 | 明确禁用 WebGL/Canvas addon；只保留 DOM renderer + fit addon |
| 反向代理下的 WS | 后端只认 Upgrade/Connection 头；文档告知代理需透传 WebSocket（不写具体 TLS 配置） |
