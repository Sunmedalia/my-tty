# my-tty

单二进制的 Web 终端：Zig 提供 HTTP/WebSocket 与 Linux PTY，浏览器用 xterm.js
的 **DOM 渲染器**显示终端。静态资源在编译期打进二进制，运行时不需要 Node/npm。

当前状态：

| 能力 | 状态 |
|---|---|
| 登录认证（弹窗登录 / 7 天会话 / 空闲超时 / 注销） | ✅ |
| 连接上限、Origin 校验、优雅退出 | ✅ |
| WebSocket ⇄ Linux PTY，真实 shell | ✅ |
| 内置会话保持（刷新/断线回到同一 shell，增量回放） | ✅ |
| 多标签页，每个标签页独立 1–4 分屏、可拖拽分栏 | ✅ |
| 字号调节 | ✅ |
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

指定 shell：

```sh
./zig-out/bin/my-tty --shell /bin/zsh --password 'change-me'
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
  "max_sessions": 16,
  "pty_idle_minutes": 30
}
```

环境变量：`MYTTY_CONFIG`、`MYTTY_HOST`、`MYTTY_PORT`、`MYTTY_SHELL`、
`MYTTY_PASSWORD`、`MYTTY_SESSION_TTL_DAYS`、`MYTTY_SESSION_IDLE_HOURS`、
`MYTTY_MAX_CONNECTIONS`、`MYTTY_MAX_SESSIONS`、`MYTTY_PTY_IDLE_MINUTES`。
完整参数见 `my-tty --help`；仓库里有一份 `my-tty.example.json`。
`my-tty --check-config` 只校验配置，不启动服务。

## 作为 systemd 服务

仓库里有 `deploy/my-tty.service`。它是普通的 systemd unit：单二进制直接跑，
不用 Docker、不用容器、不需要任何运行时依赖。

```sh
sudo install -Dm755 zig-out/bin/my-tty /usr/local/bin/my-tty
sudo useradd --system --create-home --home-dir /srv/work --shell /bin/bash my-tty
sudo install -d -o root -g my-tty -m 750 /etc/my-tty
sudo install -m640 -o root -g my-tty my-tty.example.json /etc/my-tty/my-tty.json
sudoedit /etc/my-tty/my-tty.json        # 至少改 password / shell
sudo install -Dm644 deploy/my-tty.service /etc/systemd/system/my-tty.service
sudo systemctl daemon-reload
sudo systemctl enable --now my-tty
journalctl -u my-tty -f
```

- 密码放在 `/etc/my-tty/my-tty.json`（`0640 root:my-tty`），不要写进 `ExecStart`，
  否则会出现在 `ps` 和 journal 里。
- 服务以专用用户 `my-tty` 运行，家目录是 `/srv/work`；终端里能做的事都以该用户权限为准。
- 启动前会先执行 `--check-config`，配置有问题时直接失败，不会带着坏配置跑。
- 默认只监听 `127.0.0.1`；需要远程访问用 SSH 端口转发或外部反向代理，TLS 不在本项目里。
- 停止时 `KillMode=mixed` 只给主进程发 SIGTERM，由程序自己回收所有 PTY。

## 登录认证

- 页面打开后先出现登录弹窗；未登录时终端、文件 API、WebSocket 全部拒绝。
- 密码只保存在服务端配置里，浏览器拿到的是随机会话 Cookie：
  `HttpOnly; SameSite=Strict; Path=/`，反向代理以 HTTPS 终止时自动加 `Secure`。
- 会话默认 **7 天**，由 `--session-ttl-days` 调整（1–365）；空闲超时默认 24 小时，
  由 `--session-idle-hours` 调整（0 关闭）。
- “注销”（PC 左侧图标栏 / 移动端顶栏）会同时清除服务端会话与 Cookie；所有终端随之关闭。
- 会话只存在内存中，进程重启后需要重新登录；一次性 WS 票据 30 秒失效。
  终端会话同样是内存态，进程重启后 shell 不会保留。
- 并发连接数默认上限 64。

## 文件管理与编辑

左侧“文件”面板从 `/` 开始，可以浏览整个文件系统。面板宽度可以拖拽调整，
双击分隔条恢复默认宽度，设置会记在浏览器里。目录以树状显示，点目录名
选中并展开，点前面的三角形折叠/展开；新建、上传默认落在当前选中的目录，
顶部面包屑可以直接跳到某一层。终端里 `cd` 或执行 `pwd` 后，文件面板会自动跳到
shell 当前所在目录。
刷新按钮旁的目录跟随开关默认开启，关闭后终端 cwd 不再移动文件树，重新开启会
立即对齐到 shell 当前目录；开关状态记在浏览器里。
支持新建文件/目录、重命名、递归删除、上传/下载，
以及纯文本编辑（≤1 MiB，`Ctrl+S` 保存）。新建、新建目录和重命名都使用页面内
弹窗输入名称，不调用浏览器原生 `prompt`。
上传可以点 ⇪、拖进面板，或拖到某个目录行；文件按 4 MiB 分片，带进度条和取消，
网络中断时会向服务端查询已写入偏移继续传；单个文件上限 64 MiB。
半截的上传文件权限为 `0600`，完成并改名为正式文件后恢复为 `0644`。
下载流式响应、带 `Content-Disposition: attachment`；目录可以下载成 `.tar`。
单次列目录最多返回 1 万条（前端提示已截断）；目录归档最多 5 万条/8 GiB，
超出时会停止追加并写入 `MY-TTY-TRUNCATED.txt`，不会生成损坏的 tar。
路径参数一律相对 `/`，会拒绝绝对路径和 `..`；符号链接不做限制。
HTTP API：`GET /api/fs/list|read|download`、`PUT /api/fs/write|upload`、
`POST /api/fs/mkdir|rename`、`DELETE /api/fs/delete`。

## 分屏

`+ 分屏` 最多 4 个：2 屏左右均分；3 屏左边一个占满整高、右边上下可拖拽；
4 屏 2×2，横竖分栏都可以拖拽。每个 pane 是独立的终端、WebSocket 和 PTY，
关闭 pane 会回收对应 shell。`Ctrl+Shift+F` 搜索，`Ctrl+Shift+±` 调整字号，
`F3` 下一个匹配。移动端会显示 Esc/Tab/Ctrl/方向键/^C/^D/^L 按键条；
PC 上顶栏变成左侧窄图标栏（44px）；移动端保留顶栏和底部按键条，并预留底部安全区；
触摸设备上文件行的下载/重命名/删除按钮常显；
pane 标题栏改为固定在终端上方（不再悬浮遮挡内容）。

## 标签页

终端区域顶部是标签栏，`＋` 新建标签页（最多 8 个），点标签切换，标签右侧 `✕` 关闭。
`＋` 紧跟在最后一个标签后面；宽度放不下时，最旧的标签会折叠到左侧的 `⋯` 下拉菜单，
当前标签始终可见。每个标签页有自己独立的 1–4 个分屏、分栏比例和当前 pane；
切换标签不会断开后台标签页的 WebSocket，也不会丢终端输出。关闭标签页会结束
它包含的所有 shell。

标签列表和每个 pane 的会话 id 保存在 `sessionStorage`：刷新页面后会恢复标签页并
重新接回原来的 shell；服务端进程重启后会话失效，标签页仍在但会得到新 shell。
标签页里的 pane 总数受服务端 `max_sessions`（默认 16）限制。

复制/粘贴是终端语义：

- `Ctrl+C`：**有选区时复制，没有选区时发给 shell 作为中断（SIGINT）**；复制后会清掉选区，
  所以下一次 `Ctrl+C` 就是中断。
- `Ctrl+V`、`Ctrl+Shift+V`、`Shift+Insert`：粘贴，走浏览器原生 paste 事件（xterm 处理
  bracketed paste），不需要申请剪贴板读取权限。
- `Ctrl+Insert`、`Ctrl+Shift+C`：始终复制；后者还会 `preventDefault`，避免被
  Chrome/Edge 的 DevTools“检查元素”快捷键抢走（DevTools 仍可从菜单打开）。
- 以上只绑定 Ctrl；macOS 的 `Cmd+C` / `Cmd+V` 由 xterm 走浏览器原生 copy/paste 事件，
  前端不再单独判断 `metaKey`。
- PC 左侧图标栏的 `^C` 按钮直接向当前 pane 发送 `0x03`，用于 RDP/远程桌面吞掉 Ctrl、
  或不想用键盘的场景；移动端只在底部按键条保留一个 `^C`，顶栏那个会隐藏。

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
- 密码比较使用定长时间实现。
- HTTP 阶段等待请求头超过 30 秒会被服务端主动断开（防 slowloris）；
  大文件上传/下载与 WebSocket 不受这个计时影响。
- 带 `Origin` 的 WebSocket 请求必须与 `Host` 一致；一次性票据用一次即失效，
  即使同时带了 Cookie 也会优先消费票据。
- 所有非 GET/HEAD 请求带 `Origin` 时，也必须与 `Host` / 受信任的
  `X-Forwarded-Host` 一致，否则 403。反向代理需要保留原始 `Host`，或者设置
  `X-Forwarded-Host`，否则写操作会被拒绝。
- 请求体没有完整读取的错误响应会直接关闭连接，避免残余 body 被当成下一个请求。
- `X-Forwarded-Host` / `X-Forwarded-Proto` 只在对端是回环地址（本机反向代理）时信任；
  直连客户端伪造这两个头不会改变 Origin 校验或 Cookie 的 `Secure` 属性。
- 静态资源/未知路径不接受请求体；未登录的 API 请求不会为了 keep-alive 去读取
  可能永远发不完的 body。
- `SIGTERM`/`SIGINT` 会停止 accept、回收所有 PTY 后退出。
- 会话数受 `max_sessions` 限制；分屏上限 4。

TLS 不属于本项目：请让进程只监听回环地址，把明文 HTTP/WS 交给外部反向代理。
本项目不包含证书、TLS 代码或反向代理配置文件。

## 前端依赖

`web/vendor/xterm/` 内是 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`
的构建产物（MIT，许可证同目录）。xterm 6 默认就是 DOM renderer，因此文本可以
用浏览器原生方式选择与复制；没有引入 WebGL/Canvas addon。

前端对 xterm 6.0 做了一处输入修补：Safari 和部分输入法（如中文输入法的英文模式）
会让字符的 `input` 事件早于它自己的 `keydown`，xterm 用 `_keyDownSeen` 去重时会把
字符当成重复事件丢掉；而移动端浏览器又会在 `keydown` 已经发出字符后补发一次
composed `insertText`，无条件清标记会让字符变成两个（`ls` → `llss`）。

现在的规则是：触摸设备（`pointer: coarse`）上可打印字符只走浏览器的 `input` 路径，
不再让 xterm 在 keydown/keypress 里先发一次；桌面细指针仍走原来的键盘路径。另外只在
`keydown` 没有对应字符（229/Process、组合输入、带 Ctrl/Alt/Meta）时才清掉
`_keyDownSeen`，普通按键继续由 xterm 去重。桌面 Chrome/Safari 的正常按键不会产生
`input` 事件，行为不变。

排查输入问题可以在 URL 加 `?debug-input=1`，页面会在控制台打印
`keydown`/`keypress`/`beforeinput`/`input` 的原始字段。

`web/vendor/fonts/` 内置 JetBrains Mono v2.304（OFL 1.1）。DOM 渲染器只能靠
字体绘制方框/方块字符，系统字体（如 DejaVu）会让 `█` 和边框出现缝隙；
内置字体在创建终端前完成加载，TUI 的边框与色块才能连续。

## 验证

```sh
zig test src/tests.zig        # 配置、认证/会话、PTY 环境、协议、文件边界
./scripts/smoke.sh            # 真实进程：认证、文件/分片/归档、WS+PTY、优雅退出
./scripts/browser_test.sh     # 浏览器回归（先 npm --prefix tests/browser ci 并装 chromium）
./scripts/build-release.sh    # ReleaseSafe + strip
```

CI 在 `.github/workflows/ci.yml`：格式检查、构建、单测、smoke，以及独立的浏览器任务。
