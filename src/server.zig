//! HTTP 路由 + 连接生命周期。
//!
//! 只用 std.http.Server；一条连接一个线程，静态资源全部来自内存。
//! 这里没有任何 TLS 代码：进程只监听回环地址，由外部反向代理负责加密。

const std = @import("std");
const http = std.http;
const net = std.Io.net;
const Io = std.Io;
const Allocator = std.mem.Allocator;

const assets = @import("assets.zig");
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

    const addr = try net.IpAddress.parseIp4(cfg.host, cfg.port);
    var listener = try addr.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);

    std.debug.print("my-tty 监听 http://{s}:{d}  shell={s}  root={s}  token={s}\n", .{
        cfg.host,
        cfg.port,
        cfg.shell,
        fs.root,
        if (cfg.token == null) "无" else "有",
    });

    while (true) {
        const stream = listener.accept(io) catch |err| switch (err) {
            error.Canceled => return err,
            else => {
                std.debug.print("accept 失败: {t}\n", .{err});
                continue;
            },
        };
        const thread = std.Thread.spawn(.{}, connectionMain, .{ io, gpa, stream, cfg, &fs }) catch {
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}

fn connectionMain(io: Io, gpa: Allocator, stream: net.Stream, cfg: *const config.Config, fs: *const fsapi.Fs) void {
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
                if (!authorized(&request, cfg)) {
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
                handleHttp(io, gpa, cfg, fs, &request) catch return;
            },
        }
    }
}

fn handleHttp(io: Io, gpa: Allocator, cfg: *const config.Config, fs: *const fsapi.Fs, request: *http.Server.Request) !void {
    const target = request.head.target;
    const path = util.pathOnly(target);

    // 文件 API 自己校验 HTTP 方法，所以放在统一的 GET/HEAD 检查之前。
    if (std.mem.startsWith(u8, path, "/api/")) {
        if (!authorized(request, cfg)) return respond(request, "unauthorized\n", .unauthorized);
        return fsapi.handle(io, gpa, fs, request);
    }

    // HEAD 由 respond 透明处理（省略 body），所以和 GET 走同一套路由。
    if (request.head.method != .GET and request.head.method != .HEAD) {
        return respond(request, "method not allowed\n", .method_not_allowed);
    }

    if (std.mem.eql(u8, path, "/healthz")) {
        return respond(request, "ok\n", .ok);
    }
    if (std.mem.eql(u8, path, "/favicon.ico")) {
        return respond(request, "", .no_content);
    }

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

fn authorized(request: *const http.Server.Request, cfg: *const config.Config) bool {
    const expected = cfg.token orelse return true;

    if (util.queryParam(request.head.target, "token")) |got| {
        if (config.constantTimeEql(got, expected)) return true;
    }

    var it = request.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "x-mytty-token")) {
            if (config.constantTimeEql(header.value, expected)) return true;
        }
    }
    return false;
}

fn queryParam(target: []const u8, key: []const u8) ?[]const u8 {
    const qmark = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    var it = std.mem.splitScalar(u8, target[qmark + 1 ..], '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (std.mem.eql(u8, pair[0..eq], key)) return pair[eq + 1 ..];
    }
    return null;
}
