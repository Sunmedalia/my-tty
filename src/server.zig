//! HTTP 路由 + 连接生命周期。
//!
//! 只用 std.http.Server；一条连接一个线程，静态资源全部来自内存。
//! 除登录页外壳外，所有功能（文件 API、WebSocket/PTY）都要求已登录会话。
//! 这里没有任何 TLS 代码。

const std = @import("std");
const http = std.http;
const net = std.Io.net;
const Io = std.Io;
const Allocator = std.mem.Allocator;
const linux = std.os.linux;
const posix = std.posix;

const assets = @import("assets.zig");
const auth = @import("auth.zig");
const config = @import("config.zig");
const session = @import("session.zig");
const fsapi = @import("fsapi.zig");
const util = @import("util.zig");

const security_headers = [_]http.Header{
    .{ .name = "x-content-type-options", .value = "nosniff" },
    .{ .name = "referrer-policy", .value = "no-referrer" },
    .{ .name = "x-frame-options", .value = "DENY" },
    .{ .name = "content-security-policy", .value = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
};

/// HTTP 阶段等待请求头的空闲上限（秒）。
///
/// 不能用 SO_RCVTIMEO 做超时：std.Io.Threaded 的 netRead 把 EAGAIN 当成
/// “programmer bug” 直接 panic。这里维护一张“正在等请求头”的连接表，
/// 由维护线程主动 shutdown 超时连接；请求开始处理后立刻移出表，
/// 避免误杀慢速的大文件传输。
const http_idle_seconds: i96 = 30;

var shutting_down = std.atomic.Value(bool).init(false);
var listen_handle = std.atomic.Value(posix.fd_t).init(-1);
var active_connections = std.atomic.Value(u32).init(0);

const max_tracked_connections = 4096;

const ConnSlot = struct {
    fd: posix.fd_t = -1,
    last_ns: i96 = 0,
    /// 0 = 无截止时间；非 0 时到点就 shutdown，用于未登录登录请求的慢 body。
    deadline_ns: i96 = 0,
    waiting_head: bool = false,
};
var conn_mutex: Io.Mutex = .init;
var conn_slots: [max_tracked_connections]ConnSlot = @splat(.{});

fn monotonicNs(io: Io) i96 {
    return Io.Clock.awake.now(io).nanoseconds;
}

/// 登记一条已接受的连接；表满时也返回（该连接只是不参与超时/退出唤醒）。
fn connAdd(io: Io, fd: posix.fd_t) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    const ts = monotonicNs(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) {
            s.last_ns = ts;
            return;
        }
    }
    for (&conn_slots) |*s| {
        if (s.fd < 0) {
            s.* = .{ .fd = fd, .last_ns = ts };
            return;
        }
    }
}

/// 标记连接正在等请求头。
fn armIdle(io: Io, fd: posix.fd_t) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    const ts = monotonicNs(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) {
            s.waiting_head = true;
            s.last_ns = ts;
            return;
        }
    }
    for (&conn_slots) |*s| {
        if (s.fd < 0) {
            s.* = .{ .fd = fd, .last_ns = ts, .waiting_head = true };
            return;
        }
    }
}

/// 请求头已经收到：处理请求期间不再参与空闲清理。
fn disarmIdle(io: Io, fd: posix.fd_t) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) s.waiting_head = false;
    }
}

/// 给一个连接设置整体截止时间（秒）；用于登录这种小 body 的请求。
fn connSetDeadline(io: Io, fd: posix.fd_t, seconds: i96) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    const ts = monotonicNs(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) {
            s.deadline_ns = ts + seconds * std.time.ns_per_s;
            return;
        }
    }
}

fn connClearDeadline(io: Io, fd: posix.fd_t) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) s.deadline_ns = 0;
    }
}

fn connRemove(io: Io, fd: posix.fd_t) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    for (&conn_slots) |*s| {
        if (s.fd == fd) {
            s.* = .{};
            return;
        }
    }
}

fn sweepIdleConnections(io: Io) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    const ts = monotonicNs(io);
    for (&conn_slots) |*s| {
        if (s.fd < 0) continue;
        if (s.waiting_head and ts - s.last_ns > http_idle_seconds * std.time.ns_per_s) {
            _ = linux.shutdown(s.fd, 2); // 唤醒阻塞在 receiveHead 的线程
        } else if (s.deadline_ns != 0 and ts > s.deadline_ns) {
            _ = linux.shutdown(s.fd, 2); // 请求整体超时（慢 body）
        }
    }
}

/// 退出时唤醒所有已接受连接（包括正在传文件的），让连接线程尽快返回。
fn shutdownAllConnections(io: Io) void {
    conn_mutex.lockUncancelable(io);
    defer conn_mutex.unlock(io);
    for (&conn_slots) |*s| {
        if (s.fd >= 0) _ = linux.shutdown(s.fd, 2);
    }
}

fn onSignal(_: posix.SIG) callconv(.c) void {
    shutting_down.store(true, .release);
    const fd = listen_handle.load(.acquire);
    if (fd >= 0) _ = linux.shutdown(fd, 2); // SHUT_RDWR
}

fn installSignalHandlers() void {
    const act: posix.Sigaction = .{
        .handler = .{ .handler = onSignal },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(.TERM, &act, null);
    posix.sigaction(.INT, &act, null);
}

pub fn run(io: Io, gpa: Allocator, cfg: *const config.Config) !void {
    const fs = fsapi.Fs.init(io, gpa, cfg.root) catch |err| {
        std.debug.print("无法打开 root={s}: {t}\n", .{ cfg.root, err });
        return err;
    };
    defer gpa.free(fs.root);

    var auth_state = auth.Auth.init(io, cfg.password orelse unreachable, cfg.session_ttl_days, cfg.session_idle_hours);
    var manager = session.Manager.init(io, gpa, cfg, fs.root);
    defer manager.deinit();

    const addr = try net.IpAddress.parseIp4(cfg.host, cfg.port);
    var listener = try addr.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);
    listen_handle.store(listener.socket.handle, .release);
    defer listen_handle.store(-1, .release);

    installSignalHandlers();

    const maint = std.Thread.spawn(.{}, maintenance, .{ io, gpa, &fs, &auth_state, &manager }) catch null;

    std.debug.print("my-tty 监听 http://{s}:{d}  shell={s}  root={s}  会话={d}天/{d}h  连接≤{d}  保持={d}分钟\n", .{
        cfg.host,
        cfg.port,
        cfg.shell,
        fs.root,
        cfg.session_ttl_days,
        cfg.session_idle_hours,
        cfg.max_connections,
        cfg.pty_idle_minutes,
    });

    while (true) {
        const stream = listener.accept(io) catch |err| {
            if (shutting_down.load(.acquire)) break;
            switch (err) {
                error.Canceled => break,
                else => {
                    std.debug.print("accept 失败: {t}\n", .{err});
                    continue;
                },
            }
        };

        const prev = active_connections.fetchAdd(1, .acq_rel);
        if (prev >= cfg.max_connections) {
            _ = active_connections.fetchSub(1, .acq_rel);
            stream.close(io);
            continue;
        }

        connAdd(io, stream.socket.handle);
        const thread = std.Thread.spawn(.{}, connectionMain, .{
            io, gpa, stream, cfg, &fs, &auth_state, &manager,
        }) catch {
            connRemove(io, stream.socket.handle);
            _ = active_connections.fetchSub(1, .acq_rel);
            stream.close(io);
            continue;
        };
        thread.detach();
    }

    shutting_down.store(true, .release);
    // 必须先唤醒连接，再 join 维护线程：维护线程可能在 sweep() 里等一个
    // 卡在慢客户端写入上的 session 锁；连接不先 shutdown，就会永远 join 不返回。
    shutdownAllConnections(io);
    if (maint) |t| t.join();

    std.debug.print("正在退出：回收 shell…\n", .{});
    // fs/auth_state/manager 都在本函数的栈上，绝不能在线程还在使用时返回。
    var waited: u32 = 0;
    while (active_connections.load(.acquire) > 0 and waited < 500) : (waited += 1) {
        Io.sleep(io, Io.Duration.fromMilliseconds(10), .real) catch break;
    }

    if (active_connections.load(.acquire) == 0) {
        manager.shutdown();
    } else {
        // 还有连接卡在慢速传输里：不释放会话结构，只杀 shell 后直接退出。
        manager.killChildren();
        std.debug.print("仍有 {d} 个连接未退出，直接退出\n", .{active_connections.load(.acquire)});
        std.process.exit(0);
    }
    std.debug.print("已退出\n", .{});
}

/// 断点续传临时文件的清理间隔（秒）。
const upload_sweep_ticks: u32 = 6 * 60 * 60;

fn maintenance(io: Io, gpa: Allocator, fs: *const fsapi.Fs, auth_state: *auth.Auth, manager: *session.Manager) void {
    // 启动时先清一次上次进程留下的半截上传。
    fsapi.sweepUploadTemps(io, gpa, fs, fsapi.upload_temp_ttl_ns);

    var ticks: u32 = 0;
    // 1 秒一跳，便于 SIGTERM 时尽快 join；每 60 跳做一次清理。
    while (!shutting_down.load(.acquire)) {
        Io.sleep(io, Io.Duration.fromSeconds(1), .real) catch return;
        if (shutting_down.load(.acquire)) break;
        ticks += 1;
        sweepIdleConnections(io);
        // 会话回收每秒一次：pty_idle_minutes=0 也要在 ~1s 内生效；
        // 登录会话/票据的清理保持每分钟一次即可。
        manager.sweep();
        if (ticks % 60 == 0) auth_state.sweep();
        if (ticks % upload_sweep_ticks == 0) {
            fsapi.sweepUploadTemps(io, gpa, fs, fsapi.upload_temp_ttl_ns);
        }
    }
}

fn connectionMain(
    io: Io,
    gpa: Allocator,
    stream: net.Stream,
    cfg: *const config.Config,
    fs: *const fsapi.Fs,
    auth_state: *auth.Auth,
    manager: *session.Manager,
) void {
    defer {
        connRemove(io, stream.socket.handle);
        _ = active_connections.fetchSub(1, .acq_rel);
        stream.close(io);
    }
    const peer = stream.socket.address;

    var read_buf: [64 * 1024]u8 = undefined;
    var write_buf: [16 * 1024]u8 = undefined;
    var reader = stream.reader(io, &read_buf);
    var writer = stream.writer(io, &write_buf);
    var server: http.Server = .init(&reader.interface, &writer.interface);

    while (true) {
        armIdle(io, stream.socket.handle);
        var request = server.receiveHead() catch return;
        disarmIdle(io, stream.socket.handle);

        switch (request.upgradeRequested()) {
            .websocket => |maybe_key| {
                const key = maybe_key orelse {
                    respondClose(&request, "bad websocket request\n", .bad_request) catch {};
                    return;
                };
                if (!originAllowed(&request, peerIsLoopback(peer))) {
                    respondClose(&request, "origin not allowed\n", .forbidden) catch {};
                    return;
                }
                if (!wsAuthorized(auth_state, &request)) {
                    respondClose(&request, "unauthorized\n", .unauthorized) catch {};
                    return;
                }
                // 终端可能空闲很久；上面已经 disarm，不再参与 HTTP 空闲清理。
                const sid = session.parseSessionId(util.queryParam(request.head.target, "session"));
                const resume_offset = session.parseOffset(util.queryParam(request.head.target, "offset"));
                var ws = request.respondWebSocket(.{ .key = key }) catch return;
                session.serve(io, manager, &ws, &stream, sid, resume_offset) catch |err| {
                    std.debug.print("会话结束: {t}\n", .{err});
                };
                return;
            },
            .other => {
                respondClose(&request, "unsupported upgrade\n", .bad_request) catch {};
                return;
            },
            .none => {
                handleHttp(io, gpa, cfg, fs, auth_state, peer, stream.socket.handle, &request) catch return;
                // 客户端要求关闭，或请求 body 没有干净读完时，绝不能在同一个连接上
                // 继续解析下一段字节：残余 body 会被当成新请求（请求走私/响应错位）。
                if (!request.head.keep_alive) return;
                switch (server.reader.state) {
                    .ready => {},
                    else => return,
                }
            },
        }
    }
}

fn handleHttp(
    io: Io,
    gpa: Allocator,
    cfg: *const config.Config,
    fs: *const fsapi.Fs,
    auth_state: *auth.Auth,
    peer: net.IpAddress,
    fd: posix.fd_t,
    request: *http.Server.Request,
) !void {
    const path = util.pathOnly(request.head.target);
    // X-Forwarded-* 只有本机反向代理才有资格设置；直连客户端伪造的不认。
    const trust_forwarded = peerIsLoopback(peer);

    // 只有登录和文件写入/上传会读取请求体。其余路径一旦带 body 就直接关闭，
    // 既不 drain 一个可能永远发不完的 body，也不给 std.http 的 keep-alive
    // 逻辑机会把残余字节解释成下一个请求。
    if (requestHasBody(request) and !acceptsRequestBody(path, request.head.method)) {
        return respondClose(request, "{\"error\":\"unexpected_body\"}\n", .bad_request);
    }

    // 浏览器发起的写操作必须来自当前站点。SameSite=Strict 是第一层防护，
    // 这里再显式校验 Origin，覆盖同站子域/localhost 不同端口等 Cookie 仍会发送的场景。
    // 非浏览器客户端可以不带 Origin（curl/自动化工具），不影响现有用法。
    if (request.head.method != .GET and request.head.method != .HEAD and
        !originAllowed(request, trust_forwarded))
    {
        return respondClose(request, "{\"error\":\"bad_origin\"}\n", .forbidden);
    }

    // 唯一的例外：登录端点本身。没有它就无法获得会话。
    if (std.mem.eql(u8, path, "/api/auth/login")) {
        // 这是唯一会读取未登录请求 body 的地方，而且 body 只有 4 KiB；
        // 给整个请求 10 秒上限，挡住慢 body 占住连接线程。
        connSetDeadline(io, fd, 10);
        defer connClearDeadline(io, fd);
        return handleLogin(gpa, cfg, auth_state, trust_forwarded, request);
    }

    // 其余所有 API（含注销、状态、票据）都必须先通过会话认证。
    if (std.mem.startsWith(u8, path, "/api/")) {
        if (!authorized(auth_state, request)) return deny(request);
        if (std.mem.eql(u8, path, "/api/auth/logout")) return handleLogout(auth_state, trust_forwarded, request);
        if (std.mem.eql(u8, path, "/api/auth/status")) return handleStatus(auth_state, request);
        if (std.mem.eql(u8, path, "/api/auth/ticket")) return handleTicket(auth_state, request);
        if (std.mem.startsWith(u8, path, "/api/fs/")) return fsapi.handle(io, gpa, fs, request);
        return respond(request, "{\"error\":\"not_found\"}\n", .not_found);
    }

    // HEAD 由 respond 透明处理（省略 body），所以和 GET 走同一套路由。
    if (request.head.method != .GET and request.head.method != .HEAD) {
        return respond(request, "method not allowed\n", .method_not_allowed);
    }

    if (std.mem.eql(u8, path, "/favicon.ico")) {
        return respond(request, "", .no_content);
    }

    // 页面外壳与静态资源公开加载；真正的功能都在上面的 API/WS 后面。
    const asset = assets.find(path) orelse {
        return respond(request, "not found\n", .not_found);
    };
    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = asset.mime },
        .{ .name = "cache-control", .value = asset.cache_control },
    });
    return request.respond(asset.body, .{ .extra_headers = list });
}

// ---------------------------------------------------------------------------
// 登录 / 注销
// ---------------------------------------------------------------------------

const LoginRequest = struct {
    password: []const u8 = "",
};

fn handleLogin(
    gpa: Allocator,
    cfg: *const config.Config,
    auth_state: *auth.Auth,
    trust_forwarded: bool,
    request: *http.Server.Request,
) !void {
    if (request.head.method != .POST) return respondClose(request, "method not allowed\n", .method_not_allowed);

    // 读 body 之后 head/header 迭代器不再可用，先把 Cookie 相关判断做掉。
    const secure = auth.isSecureRequest(request, trust_forwarded);

    if (request.head.content_length) |len| {
        if (len > 4096) return respondClose(request, "{\"error\":\"bad_body\"}\n", .payload_too_large);
    }

    var body_buf: [4096]u8 = undefined;
    const reader = request.readerExpectContinue(&body_buf) catch
        return respondClose(request, "{\"error\":\"bad_body\"}\n", .bad_request);
    const body = reader.allocRemaining(gpa, .limited(4096)) catch
        return respondClose(request, "{\"error\":\"bad_body\"}\n", .bad_request);
    defer gpa.free(body);
    if (!requestBodyComplete(request))
        return respondClose(request, "{\"error\":\"bad_body\"}\n", .bad_request);

    var parsed = std.json.parseFromSlice(LoginRequest, gpa, body, .{ .ignore_unknown_fields = true }) catch
        return respond(request, "{\"error\":\"bad_body\"}\n", .bad_request);
    defer parsed.deinit();

    const login = auth_state.login(parsed.value.password) orelse
        return respond(request, "{\"error\":\"invalid_password\"}\n", .unauthorized);

    const ttl_seconds: i64 = @as(i64, @intCast(cfg.session_ttl_days)) * 86400;
    var cookie_buf: [256]u8 = undefined;
    const cookie = auth.setCookieValue(&cookie_buf, login.cookie[0..], ttl_seconds, secure);

    var json_buf: [96]u8 = undefined;
    const json = std.fmt.bufPrint(&json_buf, "{{\"ok\":true,\"expires_at\":{d}}}", .{login.expires_at_s}) catch
        "{\"ok\":true}";

    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "set-cookie", .value = cookie },
    });
    return request.respond(json, .{ .extra_headers = list });
}

fn handleLogout(auth_state: *auth.Auth, trust_forwarded: bool, request: *http.Server.Request) !void {
    if (request.head.method != .POST) return respond(request, "method not allowed\n", .method_not_allowed);

    if (auth.cookieFromRequest(request)) |cookie| auth_state.logout(cookie);

    var cookie_buf: [256]u8 = undefined;
    const cookie = auth.setCookieValue(&cookie_buf, null, 0, auth.isSecureRequest(request, trust_forwarded));

    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "set-cookie", .value = cookie },
    });
    return request.respond("{\"ok\":true}", .{ .extra_headers = list });
}

fn handleTicket(auth_state: *auth.Auth, request: *http.Server.Request) !void {
    if (request.head.method != .POST) return respond(request, "method not allowed\n", .method_not_allowed);
    const ticket = auth_state.issueTicket() orelse
        return respond(request, "{\"error\":\"out_of_tickets\"}\n", .service_unavailable);

    var buf: [64]u8 = undefined;
    const json = std.fmt.bufPrint(&buf, "{{\"ticket\":\"{s}\"}}", .{ticket}) catch
        "{\"error\":\"encode_failed\"}";
    return respond(request, json, .ok);
}

fn handleStatus(auth_state: *auth.Auth, request: *http.Server.Request) !void {
    _ = auth_state; // 能走到这里说明路由前已经校验过会话
    if (request.head.method != .GET) return respond(request, "method not allowed\n", .method_not_allowed);
    return respond(request, "{\"authenticated\":true}", .ok);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn authorized(auth_state: *auth.Auth, request: *const http.Server.Request) bool {
    const cookie = auth.cookieFromRequest(request) orelse return false;
    return auth_state.validate(cookie);
}

/// WebSocket：会话 Cookie 或一次性票据都行（浏览器/自动化客户端各取所需）。
/// 票据优先消费：浏览器通常同时带 Cookie 和票据，若先认 Cookie，URL 里的票据
/// 会一直留到 30 秒过期，代理日志泄漏时仍可被复用。
fn wsAuthorized(auth_state: *auth.Auth, request: *const http.Server.Request) bool {
    if (util.queryParam(request.head.target, "ticket")) |ticket| {
        if (auth_state.consumeTicket(ticket)) return true;
    }
    return authorized(auth_state, request);
}

/// 对端是否为本机（127.0.0.0/8 或 ::1）。
fn peerIsLoopback(peer: net.IpAddress) bool {
    return switch (peer) {
        .ip4 => |a| a.bytes[0] == 127,
        .ip6 => |a| blk: {
            for (a.bytes[0..15]) |b| if (b != 0) break :blk false;
            break :blk a.bytes[15] == 1;
        },
    };
}

/// 浏览器带 Origin 时，必须与 Host 一致；非浏览器客户端可以不带。
///
/// `X-Forwarded-Host` 只在对端是回环（本机反向代理）时才认；否则直连客户端
/// 可以伪造该头绕过 Origin 比较。
fn originAllowed(request: *const http.Server.Request, trust_forwarded: bool) bool {
    var origin: ?[]const u8 = null;
    var host: ?[]const u8 = null;
    var forwarded_host: ?[]const u8 = null;
    var it = request.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "origin")) origin = header.value;
        if (std.ascii.eqlIgnoreCase(header.name, "host")) host = header.value;
        if (std.ascii.eqlIgnoreCase(header.name, "x-forwarded-host")) forwarded_host = header.value;
    }
    if (!trust_forwarded) forwarded_host = null;
    const o = origin orelse return true;
    const expected = blk: {
        if (host) |h| {
            // 反向代理如果把 Host 改写成上游地址，X-Forwarded-Host 才是外部名字。
            if (forwarded_host) |fh| {
                var parts = std.mem.splitScalar(u8, fh, ',');
                const first = std.mem.trim(u8, parts.first(), " \t");
                if (first.len > 0) break :blk first;
            }
            break :blk h;
        }
        if (forwarded_host) |fh| break :blk std.mem.trim(u8, fh, " \t");
        return false;
    };
    const rest = if (std.mem.startsWith(u8, o, "http://"))
        o["http://".len..]
    else if (std.mem.startsWith(u8, o, "https://"))
        o["https://".len..]
    else
        return false;
    const trimmed = std.mem.trimEnd(u8, rest, "/");
    return std.ascii.eqlIgnoreCase(trimmed, expected);
}

fn requestHasBody(request: *const http.Server.Request) bool {
    if (request.head.transfer_encoding != .none) return true;
    if (request.head.content_length) |len| return len != 0;
    return false;
}

fn requestBodyComplete(request: *const http.Server.Request) bool {
    return switch (request.server.reader.state) {
        .ready => true,
        else => false,
    };
}

/// 只允许这些端点自己读取 body；其余请求体一律拒绝。
fn acceptsRequestBody(path: []const u8, method: http.Method) bool {
    if (std.mem.eql(u8, path, "/api/auth/login")) return method == .POST;
    if (std.mem.eql(u8, path, "/api/fs/write")) return method == .PUT;
    if (std.mem.eql(u8, path, "/api/fs/upload")) return method == .PUT;
    return false;
}

fn deny(request: *http.Server.Request) !void {
    // 未认证请求可能带着一个永远不会发完的 body；不要为了 keep-alive 去 drain 它。
    return respondClose(request, "{\"error\":\"unauthorized\"}\n", .unauthorized);
}

fn respond(request: *http.Server.Request, body: []const u8, status: http.Status) !void {
    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = "text/plain; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    });
    return request.respond(body, .{ .status = status, .extra_headers = list });
}

/// 请求体没有完整读完时用这个：明确让客户端关闭连接，避免残余 body 被当作下一个请求。
fn respondClose(request: *http.Server.Request, body: []const u8, status: http.Status) !void {
    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = "text/plain; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    });
    return request.respond(body, .{
        .status = status,
        .extra_headers = list,
        .keep_alive = false,
    });
}

fn buildHeaders(dst: []http.Header, extra: []const http.Header) []const http.Header {
    std.debug.assert(dst.len >= extra.len + security_headers.len);
    @memcpy(dst[0..extra.len], extra);
    @memcpy(dst[extra.len..][0..security_headers.len], &security_headers);
    return dst[0 .. extra.len + security_headers.len];
}
