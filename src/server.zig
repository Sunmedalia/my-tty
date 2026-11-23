//! HTTP 路由 + 连接生命周期。
//!
//! 只用 std.http.Server；一条连接一个线程，静态资源全部来自内存。
//! 除登录页外壳外，所有功能（文件 API、WebSocket/PTY）都要求
//! 已登录的会话 Cookie。这里没有任何 TLS 代码。

const std = @import("std");
const http = std.http;
const net = std.Io.net;
const Io = std.Io;
const Allocator = std.mem.Allocator;

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

pub fn run(io: Io, gpa: Allocator, cfg: *const config.Config) !void {
    const fs = fsapi.Fs.init(io, gpa, cfg.root) catch |err| {
        std.debug.print("无法打开 root={s}: {t}\n", .{ cfg.root, err });
        return err;
    };

    var auth_state = auth.Auth.init(io, cfg.password orelse unreachable, cfg.session_ttl_days);

    const addr = try net.IpAddress.parseIp4(cfg.host, cfg.port);
    var listener = try addr.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);

    std.debug.print("my-tty 监听 http://{s}:{d}  shell={s}  root={s}  会话={d} 天\n", .{
        cfg.host,
        cfg.port,
        cfg.shell,
        fs.root,
        cfg.session_ttl_days,
    });

    while (true) {
        const stream = listener.accept(io) catch |err| switch (err) {
            error.Canceled => return err,
            else => {
                std.debug.print("accept 失败: {t}\n", .{err});
                continue;
            },
        };
        const thread = std.Thread.spawn(.{}, connectionMain, .{ io, gpa, stream, cfg, &fs, &auth_state }) catch {
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}

fn connectionMain(
    io: Io,
    gpa: Allocator,
    stream: net.Stream,
    cfg: *const config.Config,
    fs: *const fsapi.Fs,
    auth_state: *auth.Auth,
) void {
    defer stream.close(io);

    var read_buf: [64 * 1024]u8 = undefined;
    var write_buf: [16 * 1024]u8 = undefined;
    var reader = stream.reader(io, &read_buf);
    var writer = stream.writer(io, &write_buf);
    var server: http.Server = .init(&reader.interface, &writer.interface);

    while (true) {
        var request = server.receiveHead() catch return;

        switch (request.upgradeRequested()) {
            .websocket => |maybe_key| {
                const key = maybe_key orelse {
                    respond(&request, "bad websocket request\n", .bad_request) catch {};
                    return;
                };
                if (!wsAuthorized(auth_state, &request)) {
                    respond(&request, "unauthorized\n", .unauthorized) catch {};
                    return;
                }
                var ws = request.respondWebSocket(.{ .key = key }) catch return;
                session.run(io, gpa, &ws, &stream, cfg) catch |err| {
                    std.debug.print("会话结束: {t}\n", .{err});
                    ws.writeMessage("{\"t\":\"error\"}", .text) catch {};
                };
                return;
            },
            .other => {
                respond(&request, "unsupported upgrade\n", .bad_request) catch {};
                return;
            },
            .none => {
                handleHttp(io, gpa, cfg, fs, auth_state, &request) catch return;
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
    request: *http.Server.Request,
) !void {
    const path = util.pathOnly(request.head.target);

    // 登录相关端点必须放在鉴权之前，否则没法登录。
    if (std.mem.eql(u8, path, "/api/auth/login")) return handleLogin(io, gpa, cfg, auth_state, request);
    if (std.mem.eql(u8, path, "/api/auth/logout")) return handleLogout(auth_state, request);
    if (std.mem.eql(u8, path, "/api/auth/status")) return handleStatus(auth_state, request);
    if (std.mem.eql(u8, path, "/api/auth/ticket")) {
        if (!authorized(auth_state, request)) return deny(request);
        return handleTicket(auth_state, request);
    }

    // 文件 API 自己校验 HTTP 方法，所以放在统一的 GET/HEAD 检查之前。
    if (std.mem.startsWith(u8, path, "/api/")) {
        if (!authorized(auth_state, request)) return deny(request);
        return fsapi.handle(io, gpa, fs, request);
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
    io: Io,
    gpa: Allocator,
    cfg: *const config.Config,
    auth_state: *auth.Auth,
    request: *http.Server.Request,
) !void {
    if (request.head.method != .POST) return respond(request, "method not allowed\n", .method_not_allowed);

    // 读 body 之后 head/header 迭代器不再可用，先把 Cookie 相关判断做掉。
    const secure = auth.isSecureRequest(request);

    var body_buf: [4096]u8 = undefined;
    const reader = request.readerExpectNone(&body_buf);
    const body = reader.allocRemaining(gpa, .limited(4096)) catch
        return respond(request, "{\"error\":\"bad_body\"}\n", .bad_request);
    defer gpa.free(body);

    var parsed = std.json.parseFromSlice(LoginRequest, gpa, body, .{ .ignore_unknown_fields = true }) catch
        return respond(request, "{\"error\":\"bad_body\"}\n", .bad_request);
    defer parsed.deinit();

    const login = auth_state.login(parsed.value.password) orelse {
        // 简单延迟，降低在线爆破速度；不阻塞其它连接线程。
        Io.sleep(io, Io.Duration.fromMilliseconds(250), .real) catch {};
        return respond(request, "{\"error\":\"invalid_password\"}\n", .unauthorized);
    };

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

fn handleLogout(auth_state: *auth.Auth, request: *http.Server.Request) !void {
    if (request.head.method != .POST) return respond(request, "method not allowed\n", .method_not_allowed);

    if (auth.cookieFromRequest(request)) |cookie| auth_state.logout(cookie);

    var cookie_buf: [256]u8 = undefined;
    const cookie = auth.setCookieValue(&cookie_buf, null, 0, auth.isSecureRequest(request));

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
    if (request.head.method != .GET) return respond(request, "method not allowed\n", .method_not_allowed);
    const ok = authorized(auth_state, request);
    return respond(
        request,
        if (ok) "{\"authenticated\":true}" else "{\"authenticated\":false}",
        .ok,
    );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn authorized(auth_state: *auth.Auth, request: *const http.Server.Request) bool {
    const cookie = auth.cookieFromRequest(request) orelse return false;
    return auth_state.validate(cookie);
}

/// WebSocket：会话 Cookie 或一次性票据都行（浏览器/自动化客户端各取所需）。
fn wsAuthorized(auth_state: *auth.Auth, request: *const http.Server.Request) bool {
    if (authorized(auth_state, request)) return true;
    const ticket = util.queryParam(request.head.target, "ticket") orelse return false;
    return auth_state.consumeTicket(ticket);
}

fn deny(request: *http.Server.Request) !void {
    return respond(request, "{\"error\":\"unauthorized\"}\n", .unauthorized);
}

fn respond(request: *http.Server.Request, body: []const u8, status: http.Status) !void {
    var headers: [8]http.Header = undefined;
    const list = buildHeaders(&headers, &.{
        .{ .name = "content-type", .value = "text/plain; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    });
    return request.respond(body, .{ .status = status, .extra_headers = list });
}

fn buildHeaders(dst: []http.Header, extra: []const http.Header) []const http.Header {
    std.debug.assert(dst.len >= extra.len + security_headers.len);
    @memcpy(dst[0..extra.len], extra);
    @memcpy(dst[extra.len..][0..security_headers.len], &security_headers);
    return dst[0 .. extra.len + security_headers.len];
}
