# my-tty 技术研究：Zig 0.17.1 / Linux x86_64

目标：单二进制 Web 终端（Zig 后端 + xterm.js 前端），明文 HTTP/WS 只监听 `127.0.0.1`，TLS 由外部反向代理终止。

## 方法与可信度

- 本地 stdlib：`/opt/zig-0.17.1/lib/std`（`zig version` = 0.17.1）。下文 `std:路径:N` 表示 `/opt/zig-0.17.1/lib/std/路径` 第 N 行；其余为绝对路径。
- 本文所有代码骨架都在本机用 `/opt/zig-0.17.1/zig build-exe` **实际编译**过；HTTP/WS/PTY 三段还**实际运行**验证（见 §8）。
- 官方文档：<https://ziglang.org/documentation/0.17.1/>；下载页（确认 0.17.1 发布物）：<https://ziglang.org/download/>。
- 无法从源码/实测确认的，标 **UNVERIFIED**。

> ⚠️ 0.17.1 的 `std.posix` 被大幅裁剪（仅 ~1692 行，无 `open/fork/ioctl/write/close/dup2/execve/setsid`），且 **`@cImport` 已被移除**。网上 0.11–0.14 的示例大量不可用。

---

## 1. TCP HTTP server（`std.Io` + `std.Io.net` + `std.http.Server`）

参考实现：`/opt/zig-0.17.1/lib/compiler/Maker/WebServer.zig:214-350`（`start`/`serve`/`accept`）。调用链：
`parseIp4` → `addr.listen` → `Server.accept` → `stream.reader/writer` → `http.Server.init` → `receiveHead` → `request.respond`。

关键签名（均为实测可编译）：

| API | 签名/位置 |
|---|---|
| `net.IpAddress.parseIp4` | `parseIp4(text: []const u8, port: u16) Ip4Address.ParseError!IpAddress` — `std:Io/net.zig:114` |
| `IpAddress.resolve` | `resolve(io: Io, text: []const u8, port: u16) !IpAddress` — `std:Io/net.zig:131`（**只解析字面量，不做 DNS**；没有 `resolveIp`。DNS 走 `HostName.lookup`，`std:Io/net/HostName.zig:185`） |
| `IpAddress.listen` | `listen(address: *const IpAddress, io: Io, options: ListenOptions) ListenError!Server` — `std:Io/net.zig:248`；`ListenOptions{ kernel_backlog=128, reuse_address=false, mode=.stream, protocol=.tcp }` — `:226` |
| `net.Server` | `{ socket: Socket, options }`；`deinit(*Server, Io)` — `:1567`；`accept(*Server, Io) AcceptError!Stream` — `:1607` |
| `net.Socket` | `{ handle: fd_t, address: IpAddress }`（`port=0` 时回填实际端口）— `:1072` |
| `net.Stream` | `reader(stream, io, buf) Reader` — `:1501`；`writer(...) Writer` — `:1515`；`close(*const Stream, Io)` — `:1321` |
| 连接的 Reader/Writer | `Stream.Reader{ io, interface: Io.Reader, ... }` — `:1329`；`Stream.Writer{ io, interface: Io.Writer, ... }` — `:1418`（**必须取 `.interface` 的指针**） |
| `http.Server.init` | `init(in: *Reader, out: *Writer) Server` — `std:http/Server.zig:25`（注意是 `std.Io.Reader/Writer`，不是旧 `std.io`） |
| `receiveHead` | `receiveHead(*Server) ReceiveHeadError!Request` — `:47`；head 超过输入缓冲 → `error.HttpHeadersOversize` |
| `Request.respond` | `respond(*Request, content: []const u8, options: RespondOptions) ExpectContinueError!void` — `:325` |
| `RespondOptions` | `{ version=.@"HTTP/1.1", status=.ok, reason=null, keep_alive=true, extra_headers: []const http.Header=&.{}, transfer_encoding=null }` — `:302` |

最小骨架（**已编译并运行**；`std.process.Init` 的 `io` 就是配好 `Threaded` 的 `Io`，见 `std:start.zig:834`、`std:process.zig:31-58`）：

```zig
const std = @import("std");
const Io = std.Io;
const net = std.Io.net;
const http = std.http;
pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const addr = try net.IpAddress.parseIp4("127.0.0.1", 8080);
    var server = try addr.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);
    std.log.info("listen {f}", .{server.socket.address});
    var group: Io.Group = .init;
    defer group.cancel(io);
    while (true) {
        const stream = server.accept(io) catch |err| switch (err) {
            error.Canceled => return,
            else => continue,
        };
        group.concurrent(io, conn, .{ io, stream }) catch { // 并发见 §3
            var s = stream;
            s.close(io);
        };
    }
}

fn conn(io: Io, stream: net.Stream) Io.Cancelable!void {
    var s = stream;
    defer s.close(io);
    var rbuf: [8192]u8 = undefined; // 同时是 WS 单帧上限，见 §2
    var wbuf: [8192]u8 = undefined;
    var r = stream.reader(io, &rbuf);
    var w = stream.writer(io, &wbuf);
    var srv: http.Server = .init(&r.interface, &w.interface);
    while (true) { // keep-alive：同一条连接可处理多个请求
        var req = srv.receiveHead() catch |err| switch (err) {
            error.HttpConnectionClosing => return,
            else => return,
        };
        switch (req.upgradeRequested()) {
            .websocket => |maybe_key| {
                const key = maybe_key orelse return;
                var ws = req.respondWebSocket(.{ .key = key }) catch return;
                return serveWs(&ws); // §2
            },
            .other => return,
            .none => try req.respond("hello", .{
                .extra_headers = &.{.{ .name = "Content-Type", .value = "text/plain; charset=utf-8" }},
            }),
        }
    }
}
```

要点/坑：`respond` 自动加 `content-length`、处理 `HEAD`、丢弃请求体以复用连接（`std:http/Server.zig:312-390`）；响应头大小写按传入原样，内建头小写（实测）。大响应/流式用 `respondStreaming(buffer, .{ .content_length=?, .respond_options=.{} })`（`:414`）。测试可独立构造 `std.Io.Reader.fixed(bytes)`（`std:Io/Reader.zig:152`）。不依赖 `main` 注入也能起服务（**已验证**）：`var t: std.Io.Threaded = .init(std.heap.smp_allocator, .{}); defer t.deinit(); const io = t.io();`（`std:Io/Threaded.zig:1654,1854,1759`）。

---

## 2. WebSocket 服务端（`std.http.Server.WebSocket`）

源码：`std:http/Server.zig:495-809`。入口：

- `upgradeRequested(*const Request) UpgradeRequest` — `:502`；返回 `.websocket: ?[]const u8`（`sec-websocket-key`，缺失则 `null`）、`.other: []const u8`、`.none`。仅对 HTTP/1.1 + `GET` 生效，且只检查 `Upgrade: websocket`，**不校验 `Sec-WebSocket-Version`/`Origin`/子协议**。
- `respondWebSocket(*Request, WebSocketOptions{ key, reason=null, extra_headers=&.{} }) ExpectContinueError!WebSocket` — `:533`。写入 `101` + `sec-websocket-accept`。
- `WebSocket{ key, input: *Io.Reader, output: *Io.Writer }` — `:655`。

行为（源码 + 实测）：

| 项 | 结论 | 出处 |
|---|---|---|
| 发送/掩码 | `writeMessage(data, op)` / `writeMessageVec(&vecs, op)`；服务端帧**不加掩码**、`fin=true`、无压缩、无分片；客户端帧无 mask → `error.MissingMaskBit` | `:756`、`:767`、`:719` |
| 接收 | `readSmallMessage() !SmallMessage{ opcode, data }`；`data` 指向输入缓冲，**下一次读即失效** | `:698`、`:707` |
| 大小上限 | 负载 `len > in.buffer.len` → `error.MessageOversize`。上限=你给 `stream.reader` 的缓冲区（骨架里 8192） | `:725`、`:734` |
| 分片 | 不支持：`fin=false` 或 `continuation` → `error.MessageOversize` / `error.UnexpectedOpCode` | `:717`、`:737` |
| Ping/Pong | `.ping` 会作为消息**返回**（需自行回 `.pong`）；`.pong` 被**静默跳过**（无法观测对端 pong） | `:734`、`:746` |
| 关闭/flush | 收到 close → `error.ConnectionClose`，库不会自动回 close，需发 `writeMessage("", .connection_close)`；`respondWebSocket` **不 flush**，101 头要等第一次 `writeMessage`/`ws.flush()` | `:721`、`:742`、`:529`、`:801` |

服务端循环（**已编译并实测**：echo、ping→pong、close 均正确）：

```zig
fn serveWs(ws: *http.Server.WebSocket) !void {
    try ws.writeMessage("connected\r\n", .text); // 同时把 101 响应 flush 出去
    while (true) {
        const msg = ws.readSmallMessage() catch |err| switch (err) {
            error.ConnectionClose => {
                ws.writeMessage("", .connection_close) catch {};
                return;
            },
            else => return err, // MessageOversize / MissingMaskBit / EndOfStream
        };
        switch (msg.opcode) {
            .text, .binary => try ws.writeMessage(msg.data, msg.opcode),
            .ping => try ws.writeMessage(msg.data, .pong),
            else => {},
        }
    }
}
```

实测：9000 字节消息（>8192）连接被重置并记录 `error.MessageOversize`；`FIN=0` 分片同样 `MessageOversize`。
**限制**：没有自动心跳、没有超时、没有读大小的上限保护（除缓冲）、无法感知 pong。浏览器的粘贴可能一次超 8 KiB → 需要把缓冲调大（如 64 KiB）或在 JS 侧切块发送。

---

## 3. 每连接一个任务：`Thread.spawn` vs `Io.concurrent`/`async`

| 方案 | 签名 | 特点 |
|---|---|---|
| `std.Thread.spawn` | `spawn(config: SpawnConfig, comptime function: anytype, args: anytype) SpawnError!Thread` — `std:Thread.zig:344`；`join()` `:370`，`detach()` `:364` | 纯 OS 线程，不接 `Io` 取消；无需 allocator；不能与 `io` 的取消联动 |
| `io.concurrent` | `concurrent(io: Io, function, args) ConcurrentError!Future(Ret)` — `std:Io.zig:2571` | **有并发保证**：返回前任务已开始或已拿到并发额度；需要 `Threaded`（`single_threaded` 时返回 `error.ConcurrencyUnavailable`，`std:Io/Threaded.zig:2178`） |
| `io.async` | `async(io: Io, function, args) Future(Ret)` — `std:Io.zig:2532` | 更弱：可能**同步执行完/阻塞调用者**；不需要并发实现 |
| `Io.Group` | `Group.concurrent(g, io, fn, args) ConcurrentError!void` — `:1384`；`await(g, io) Cancelable!void` — `:1408`；`cancel(g, io) void` — `:1427` | 适合“长生命周期 + 不断加任务”，任务返回即释放资源；不能单独 await 某个任务 |

`Future`：`await(*Future, Io) Result`（`:1319`）、`cancel(*Future, Io) Result`（`:1311`），二者幂等、非线程安全；**必须用 `var` 接住**（接收者是 `*@This()`）。`fn` 若返回 `Cancelable!void`，取消点会收到 `error.Canceled`。

```zig
var fut = try io.concurrent(worker, .{io, stream});
try fut.await(io);           // 等待；返回 fn 的返回类型
_ = fut.cancel(io) catch {}; // 或取消（阻塞等待其退出）
var g: Io.Group = .init;
defer g.cancel(io);          // 取消全部并等待
try g.concurrent(io, worker, .{io, stream});
```

现实约束：`Threaded` 的 `concurrent_limit` 默认 `.unlimited`（`std:Io/Threaded.zig:1639`），即 **`Io.concurrent` ≈ 每任务一线程**，连接不设上限会被打爆（用 `.limited(64)` 或应用层限流）。取消阻塞中的 PTY `read` 依赖 `SIG.IO` 打断 syscall（`std:Io/Threaded.zig:1690-1710`、`:10060` 的 `INTR → checkCancel`）；**UNVERIFIED**：未做“取消阻塞 pty 读”的端到端实测。`Group` 的任务返回类型必须可强转为 `Cancelable!void`（`:1357`）。

---

## 4. Linux PTY（不依赖 libc）

**结论：0.17.1 没有 `std.posix.openpty` / `forkpty` / `login_tty`**（`std:posix.zig` 全量 `pub fn` 列表已核对；全文无这些符号），也没有 `std.posix.fork`。必须走原始路径。

### 4.1 需要的精确 API

| 用途 | 0.17.1 实际 API |
|---|---|
| 打开设备 | `std.posix.openat(dir_fd: fd_t, path: []const u8, flags: O, mode: mode_t) OpenError!fd_t` — `std:posix.zig:447`（**没有 `posix.open`**） |
| 标志 | `posix.O{ .ACCMODE = .RDWR, .NOCTTY = true, .CLOEXEC = true }`（`std:os/linux.zig:391-406`） |
| ioctl | **统一用** `std.os.linux.ioctl(fd: fd_t, request: u32, arg: usize) usize` — `std:os/linux.zig:3233`；配 `posix.errno(rc)`（`std:posix.zig:1042`）。⚠️ 不要用 `posix.system.ioctl`：libc 下它声明为 `extern "c" fn ioctl(fd, request: c_int, ...)`（`std:c.zig:12018`），装不下 `TIOCGPTN=0x80045430`（实测 libc 构建运行期 panic: integer does not fit） |
| 解锁/取号 | `posix.T.IOCSPTLCK`（0x40045431）、`posix.T.IOCGPTN`（0x80045430）— `std:os/linux.zig:6427-6428`（**std 去掉了 `TIOC` 前缀的 T**） |
| 设控制终端 | `posix.T.IOCSCTTY`（0x540e）— `:6393`（须对 **slave** 调用，不能对 master） |
| 窗口大小 | `posix.T.IOCSWINSZ`（0x5414）/`IOCGWINSZ`（0x5413）— `:6398-6399`；`posix.winsize{ row, col, xpixel, ypixel }` — `std:posix.zig:261` |
| fork / 会话 | `linux.fork() usize` — `:1105`；`linux.setsid() usize` — `:2649` |
| 重定向/执行 | `linux.dup2(old,new) usize` — `:1055`；`linux.execve(path: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: …) usize` — `:1087` |
| 收尾 | `linux.close(fd)` — `:2030`；`linux.waitpid(pid, *i32, flags) usize` — `:2252`；`posix.kill(pid, SIG.HUP)` — `std:posix.zig:384` |
| fd I/O | 推荐包成 `std.Io.File{ .handle = fd, .flags = .{ .nonblocking = false } }`，用 `readStreaming(io, &.{buf})` / `writeStreamingAll(io, bytes)` / `close(io)` — `std:Io/File.zig:471/620/212` |

### 4.2 可用骨架（**已编译，并实测跑起 `/bin/sh`、`stty size` 输出 `24 80`**）

```zig
fn ctl(fd: std.posix.fd_t, req: u32, arg: usize) !void {
    if (std.posix.errno(std.os.linux.ioctl(fd, req, arg)) != .SUCCESS) return error.IoctlFailed;
}
fn openMaster() !std.posix.fd_t {
    const fd = try std.posix.openat(std.posix.AT.FDCWD, "/dev/ptmx",
        .{ .ACCMODE = .RDWR, .NOCTTY = true, .CLOEXEC = true }, 0);
    errdefer _ = std.os.linux.close(fd);
    var unlock: c_int = 0;
    try ctl(fd, std.posix.T.IOCSPTLCK, @intFromPtr(&unlock)); // 0 = 解锁
    return fd;
}
fn spawnChild(master: std.posix.fd_t, slave_path: []const u8) !std.posix.pid_t {
    const rc = std.os.linux.fork();
    if (std.posix.errno(rc) != .SUCCESS) return error.ForkFailed;
    if (rc == 0) { // 子进程：只能调用 async-signal-safe 的东西
        const sfd = std.posix.openat(std.posix.AT.FDCWD, slave_path,
            .{ .ACCMODE = .RDWR, .NOCTTY = true }, 0) catch std.os.linux.exit(126);
        _ = std.os.linux.setsid();
        _ = std.os.linux.ioctl(sfd, std.posix.T.IOCSCTTY, 0);
        _ = std.os.linux.dup2(sfd, 0);
        _ = std.os.linux.dup2(sfd, 1);
        _ = std.os.linux.dup2(sfd, 2);
        if (sfd > 2) _ = std.os.linux.close(sfd);
        _ = std.os.linux.close(master); // 子进程不要留 master
        const argv = [_:null]?[*:0]const u8{ "/bin/sh", "-i", null };
        const envp = [_:null]?[*:0]const u8{ "TERM=xterm-256color", "PATH=/usr/bin:/bin", null };
        _ = std.os.linux.execve("/bin/sh", &argv, &envp);
        std.os.linux.exit(127);
    }
    return @intCast(rc);
}
// 取 slave 路径：ioctl(T.IOCGPTN) 得 N，std.mem.printSentinel(&buf, "/dev/pts/{d}", .{n}, 0)
// 改窗口：ioctl(master, T.IOCSWINSZ, @intFromPtr(&ws))  // 对 master 生效，已实测
```

**实测坑位**：

- master 读在“最后一个 slave 关闭”后返回 `error.InputOutput`（EIO），不是 `EndOfStream` → 当会话结束：`catch |e| switch (e) { error.EndOfStream, error.InputOutput => return, ... }`。
- `TIOCSCTTY` 必须对 **slave** 调（对 master 失败，子进程无控制终端/job control 失效），且必须在 `setsid()` 之后。
- 会话结束必须 `waitpid` 回收，否则僵尸；断线时 `kill(pid, SIG.HUP)`（兜底 `SIG.KILL`）+ `waitpid`。父进程**不要**长期持有 slave fd，否则 master 永远等不到 EOF。
- `fork()` 只复制调用线程；子进程里不要用分配器、`std.log`、锁（多线程下会死锁）。argv/envp 必须在 fork 前准备好。
- `execve` 需要 NUL 结尾：`std.mem.printSentinel(...,0)`（`std.fmt.bufPrintZ` 已移除，见 `std:fmt.zig:605`），argv 用 `[_:null]?[*:0]const u8{...}`。std 名是 `IOCSWINSZ`（即内核 `TIOCSWINSZ`，无 `T` 前缀）。

### 4.3 libc `forkpty` 替代方案

**0.17.1 已移除 `@cImport`**（实测报 `error: invalid builtin function: '@cImport'`），不能 `@cImport(@cInclude("pty.h"))`。两条可行路径：

- （a）手动声明（简单；**已 `-Dlibc=true` 编译链接通过**）：`extern "c" fn forkpty(amaster: *c_int, name: ?[*]u8, termp: ?*const std.posix.termios, winp: ?*const std.posix.winsize) c_int;`
- （b）translate-c（**已编译通过**；生成头耗时约 1 分钟）：`b.addTranslateC(.{ .root_source_file = b.path("include/pty_shim.h"), .target = target, .optimize = optimize })` 后 `mod.addImport("c", tc.createModule())`，代码 `const c = @import("c")`。API：`std:Build.zig:949`、`std:Build/Step/TranslateC.zig:22,76`。

**Pros**：`forkpty` 包办 `setsid`+`TIOCSCTTY`+`dup2`+`open slave`，少踩坑；窗口大小一次传入。
**Cons（多线程服务器）**：需 `link_libc`（破坏静态无 libc）；仍是 `fork()`，多线程下子进程同样受限（glibc atfork/锁）；自定义 argv/envp/cwd 仍要自己 fork；translate-c 拉长构建、绑定 glibc 头。
**建议**：主选 4.2 原始路径（可控、静态）；只是想省代码且能接受 libc 时用 `forkpty`。

---

## 5. 静态文件内嵌与响应

- `@embedFile(comptime path) *const [N:0]u8`：官方文档 <https://ziglang.org/documentation/0.17.1/#embedFile> 说“相对当前文件，像 `@import`”。**实测**：路径不能跑出 module root，`@embedFile("../web/index.html")` 报 `embed of file outside package path`。
- 正确做法：把 `web/` 放在项目根，用 `module.addAnonymousImport("index.html", .{ .root_source_file = b.path("web/index.html") })`（`std:Build/Module.zig:313`），代码里 `@embedFile("index.html")`。**已实测可编译可服务**。
- `std` **没有** MIME 推断工具（全库无 `text/html` 映射），自己写小表即可。
- 响应：`req.respond(body, .{ .status = .ok, .extra_headers = &.{.{ .name="Content-Type", .value="text/css; charset=utf-8" }} })`；`Content-Length` 自动；`std.http.Status` 字段是 snake_case（如 `.not_found`，`/opt/zig-0.17.1/lib/compiler/Maker/WebServer.zig:509-513`）。

```zig
const assets = .{
    .{ "/", "index.html", "text/html; charset=utf-8" },
    .{ "/xterm.js", "xterm.js", "text/javascript; charset=utf-8" },
    .{ "/xterm.css", "xterm.css", "text/css; charset=utf-8" },
};
inline for (assets) |a| {
    if (std.mem.eql(u8, req.head.target, a[0])) return req.respond(@embedFile(a[1]), .{
        .extra_headers = &.{
            .{ .name = "Content-Type", .value = a[2] },
            .{ .name = "Cache-Control", .value = "no-store" },
        },
    });
}
try req.respond("not found", .{ .status = .not_found });
```

二进制安全：`@embedFile` 返回 `*const [N:0]u8`，可直接当 `[]const u8`；WASM/字体等同样适用（无 UTF-8 假设）。

---

## 6. xterm.js（DOM 渲染，无 Canvas/WebGL）

### 6.1 包与版本（registry 实测，2026-11 查询）

| 包 | 最新版 | 发布日 | license | 入口 |
|---|---|---|---|---|
| `@xterm/xterm` | **6.0.0** | 2025-12-22 | MIT | `main: lib/xterm.js`，`module: lib/xterm.mjs`，`style: css/xterm.css`，`types: typings/xterm.d.ts` |
| `@xterm/addon-fit` | **0.11.0** | 2025-12-22 | MIT | `lib/addon-fit.js` / `.mjs` |
| `@xterm/addon-web-links` | **0.12.0** | 2025-12-22 | MIT | `lib/addon-web-links.js` / `.mjs` |

npm 包实际文件（`xterm-6.0.0.tgz` 共 161 项）：`css/xterm.css`、`lib/xterm.js(+map)`、`lib/xterm.mjs(+map)`、`typings/xterm.d.ts`、`LICENSE`、`src/**`（含 `src/browser/renderer/dom/*`）。addon 包为 `lib/*.js|.mjs`、`typings/*.d.ts`、`LICENSE`、`src/*.ts`。license 字段与 `LICENSE` 文件均为 MIT。

### 6.2 渲染器：DOM 是唯一内建渲染器

- `CoreBrowserTerminal._createRenderer()` 直接 `createInstance(DomRenderer, ...)` — 包内 `src/browser/CoreBrowserTerminal.ts:584`。**没有 rendererType 选项**，DOM 即默认、也是唯一内建实现。
- 文本是真实 DOM 文本节点（`.xterm-rows` 容器，`charElement.textContent = text`）→ 原生文本选择/复制可用：`src/browser/renderer/dom/DomRenderer.ts:21`、`DomRendererRowFactory.ts:217,461`。
- **xterm 6.0.0 删除了 canvas renderer**：release notes 明确写 “#5105 Remove the canvas renderer … this addon no longer exists and we recommend using either the DOM renderer or WebGL” — <https://github.com/xtermjs/xterm.js/releases/tag/6.0.0>。npm 上 `@xterm/addon-canvas` 最新仍是 **0.7.0**（peer `@xterm/xterm: ^5.0.0`，2024-07 后无新版），**不能配 6.0.0**。`@xterm/addon-webgl`（0.19.0）仍在，但本项目**不引入**，因此无需任何渲染 addon。
- 细节：DOM 渲染器内部仍会用 `<canvas>` 做两件非文本的事——颜色解析（`src/common/Color.ts:124`）和 overview ruler 装饰（`OverviewRulerRenderer.ts:62`，仅启用 decorations 时）。文本渲染/选择不经过 canvas；若要“零 canvas”，不要开 overview ruler/decorations。
- 引入方式（无需打包器，UMD）：`<link rel="stylesheet" href="/xterm.css">` + `<script src="/xterm.js">`，全局 `Terminal`；addon 全局 `FitAddon`、`WebLinksAddon`。与 npm 包 README 的用法一致（`@xterm/xterm` README 的 Getting Started）。用打包器则 `import { Terminal } from '@xterm/xterm'`。

### 6.3 最小集成与数据通路

```html
<link rel="stylesheet" href="/xterm.css">
<div id="terminal" style="width:100%;height:100vh"></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script>
  const term = new Terminal({ convertEol: false, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();                       // 容器必须有确定尺寸
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  term.onData(d => ws.readyState === 1 && ws.send(new TextEncoder().encode(d))); // -> 服务端 pty
  ws.onmessage = e => term.write(new Uint8Array(e.data));                        // <- pty 输出（按 UTF-8 解码）
  term.onResize(({ cols, rows }) => ws.readyState === 1 &&
      ws.send(JSON.stringify({ type: 'resize', cols, rows })));
  const ro = new ResizeObserver(() => fit.fit());
  ro.observe(document.getElementById('terminal'));
</script>
```

- 数据方向：`onData`（`string`，`typings/xterm.d.ts:943`）→ `ws.send`；`ws.onmessage` → `term.write`。
- 编码建议：**服务端用 binary 帧发原始字节，前端 `term.write(Uint8Array)`**。`write` 文档：“raw bytes 按 UTF-8 处理，string 按 UTF-16”（`typings/xterm.d.ts:1249-1253`）。text 帧下多字节 UTF-8 被拆帧会乱码。
- resize 流程：`fit.fit()` → `term.onResize` → WS 控制帧 → 服务端 `ioctl(master, IOCSWINSZ, &ws)`（内核自动给前台进程组发 `SIGWINCH`）。**实测** `stty size` 能读到设定值；SIGWINCH 投递属内核标准行为，未单独实测。
- 前端输入用 `TextEncoder` 转字节再发，避免服务端按 UTF-16 误解；服务端直接写 pty。

---

## 7. build.zig（0.17.1）

**命名确认**：`b.standardTargetOptions(.{})`（`std:Build.zig:1231`）、`b.standardOptimizeOption(.{})`（`:1193`）、`b.option(T, name, desc) ?T`（`:966`）、`b.installArtifact`（`:1459`）、`b.addExecutable`（`:579`）、`b.path`（`:1538`）、`b.createModule`（`:722`）。

**0.17.1 变更（会踩）**：
- **`exe.linkLibC()` 已不存在**（全库无此符号）；改为在 `b.createModule(.{...})` 里 `link_libc = true`（`std:Build/Module.zig:209；std:Build/Step/Compile.zig:603`）。
- **`b.args` 已不存在**；`zig build run -- foo` 用 `run.addPassthruArgs()`（`std:Build/Step/Run.zig:593`）。
- 编译期常量用 `b.addOptions()` + `module.addOptions("build_options", opts)`（`std:Build.zig:555`、`std:Build/Module.zig:321`；`opts.addOption(T, name, value)` 见 `Step/Options.zig:45`）。

完整可用示例（**已实测 `zig build -Dport=9000` 成功并生成可执行文件**）：

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const port = b.option(u16, "port", "listen port (127.0.0.1)") orelse 8080;
    const opts = b.addOptions();
    opts.addOption(u16, "port", port);
    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = false,            // 若用 forkpty 则设为 true
    });
    mod.addOptions("build_options", opts);
    inline for (.{ "index.html", "xterm.js", "xterm.css" }) |name| {
        mod.addAnonymousImport(name, .{
            .root_source_file = b.path(b.fmt("web/{s}", .{name})),
        });
    }
    const exe = b.addExecutable(.{ .name = "my-tty", .root_module = mod });
    b.installArtifact(exe); // 按 AGENTS.md 不加自定义 run/test step
}
```

用法：`zig build -Dport=8080`；代码里 `const build_options = @import("build_options"); build_options.port`。
`build.zig.zon` 仅在有依赖时才需要；**已验证**零依赖、无 `.zon`、含 `addAnonymousImport` 的项目可正常 `zig build`。
`run.addPassthruArgs()`（`std:Build/Step/Run.zig:593`，取代已移除的 `b.args`）仅作 API 记录；本仓库不添加 run step。

---

## 8. 已验证清单（本次实测）

- §1 骨架：编译并运行；`curl` 得到 `200`、`content-length`、自定义头，404 正常。
- §2：101 握手与 `sec-websocket-accept` 正确；echo；ping→pong；close 回帧；9000B 与 `FIN=0` 分片均 `MessageOversize`。
- §4：`/dev/ptmx`+`TIOCSPTLCK`+`TIOCGPTN`+`fork`+`setsid`+`TIOCSCTTY`+`dup2`+`execve("/bin/sh")` 跑通（no-libc 与 `-lc` 两种构建），`stty size` 输出 `24 80`；master 读以 EIO 结束。
- §7：`standardTargetOptions`/`standardOptimizeOption`/`-Dport`/`addAnonymousImport`/`addOptions`/`installArtifact` 均通过。
- libc：`@cImport` 确认被移除；`extern "c" fn forkpty(...)` 与 `addTranslateC` 两条路都编译链接通过（**未运行测试**）。

---

## Risks / unknowns

- **WS 能力缺口**：无分片/无压缩/无 pong 观测/无读超时；粘贴超缓冲即断，无法靠 pong 做存活检测（需应用层心跳或 TCP 超时）。
- **线程模型**：`Io.concurrent` 默认无上限，`Threaded`/`std.Thread` 都是 1 任务 1 线程 → 必须设 `concurrent_limit` 并限制会话数。
- **无鉴权、无 TLS（刻意）**：只 bind `127.0.0.1`；放在反向代理之后是部署前提，代理须透传 `Upgrade`/`Connection` 完成 WS 升级。仓库内不含任何证书/TLS/代理配置，公网暴露前必须由代理做认证与限流。
- **fork 多线程风险**：子进程只保留调用线程，malloc/日志/锁都可能死锁；已用“fork 前备参数 + 子进程只用 raw syscall”规避，但仍是维护点。
- **PTY 生命周期**：EIO 语义、僵尸回收、断线 `SIGHUP`、master/slave fd 泄漏都需要专门收尾逻辑。
- `std.os.linux.*` 是 Linux 专用、非稳定 API；升级 Zig 时优先重查 `posix.system`/`T` 常量与 `Threaded`。xterm 6.0.0 较新（2025-12），第三方 addon 多按 5.x 发布，升级前核对兼容性。
- **UNVERIFIED**：取消阻塞中 PTY `readStreaming` 的端到端行为；SIGWINCH 投递实测；`forkpty` 运行时行为。

---

## Recommended architecture

```
浏览器 ──(外部反代, TLS 终止, 透传 Upgrade)──▶ 127.0.0.1:8080  Zig 单进程
                                                   │
              ┌────────────────────────────────────┼─────────────────────────┐
              │ main: accept 循环 → Io.Group 每连接一个任务（上限 N）          │
              │                                                              │
              │ 会话任务 A: WS readSmallMessage ──▶ 解析控制帧 / 写 PTY master │
              │ 会话任务 B: PTY master readStreaming ──▶ ws.writeMessage(binary)│
              │            （写 WS 必须持 Io.Mutex 串行化）                    │
              │ 收尾: close WS → kill(pid,SIGHUP) → waitpid → close(master)    │
              └──────────────────────────────────────────────────────────────┘
```

- **协议**：pty 字节走 WS binary 帧；控制（resize、心跳、session 元信息）走 text 帧 JSON（`{"type":"resize","cols":..,"rows":..}`），避免 text 帧承载终端字节（UTF-8 跨帧）。
- **缓冲/并发**：WS 读缓冲 ≥ 64 KiB（粘贴），PTY 读 4–8 KiB；写 WS 用独立 `Io.Writer` + `Io.Mutex` 串行化。`Threaded.init(gpa, .{ .concurrent_limit = .limited(32) })`，会话上限 + 每会话固定 2 个任务，绝不为每条 WS 消息 spawn。
- **PTY**：优先 §4.2 无 libc 实现（静态单文件）；`fork` 前组装 `argv`/`envp`，子进程只做 syscall；`/bin/sh -i` + `TERM=xterm-256color` + `PATH`。
- **前端/部署**：`@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`（可选 `addon-web-links@0.12.0`），只用默认 DOM 渲染，**不加载** addon-canvas（已不存在）或 addon-webgl；静态资源 `@embedFile` 进二进制。二进制只 bind `127.0.0.1` 明文 HTTP/WS，TLS/证书/访问控制全部交给外部反代。
