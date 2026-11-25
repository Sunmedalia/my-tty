//! 登录会话：密码登录 -> 随机 session id -> HttpOnly Cookie。
//!
//! 会话只存在内存里：进程重启后全部失效，需要重新登录。容量固定 256 个，
//! 过期或被覆盖的槽位直接复用，不需要额外的清理线程。

const std = @import("std");
const Io = std.Io;
const http = std.http;
const config = @import("config.zig");

pub const cookie_name = "my_tty_session";
/// 每个槽位只有几十字节，256 个约 10 KiB；留足余量，避免反复登录/多设备测试时
/// 把还在用的旧会话挤掉（被挤掉的浏览器下次请求就是 401）。
pub const max_sessions = 256;

pub const Auth = struct {
    io: Io,
    password: []const u8,
    ttl_days: u32,
    idle_hours: u32,
    mutex: Io.Mutex = .init,
    sessions: [max_sessions]Session = @splat(.{}),
    tickets: [max_tickets]Ticket = @splat(.{}),

    const Session = struct {
        id: [16]u8 = @splat(0),
        expires_ns: i96 = 0,
        last_seen_ns: i96 = 0,
        used: bool = false,
    };

    pub const max_tickets = 32;
    pub const ticket_ttl_ns: i96 = 30 * std.time.ns_per_s;

    const Ticket = struct {
        id: [16]u8 = @splat(0),
        expires_ns: i96 = 0,
        used: bool = false,
    };

    pub const Login = struct {
        /// 32 个十六进制字符，直接放进 Cookie。
        cookie: [32]u8,
        expires_at_s: i64,
    };

    pub fn init(io: Io, password: []const u8, ttl_days: u32, idle_hours: u32) Auth {
        return .{
            .io = io,
            .password = password,
            .ttl_days = ttl_days,
            .idle_hours = idle_hours,
        };
    }

    fn idleNs(self: *const Auth) i96 {
        const hours: i96 = @intCast(self.idle_hours);
        return hours * 60 * 60 * std.time.ns_per_s;
    }

    fn ttlNs(self: *const Auth) i96 {
        const days: i96 = @intCast(self.ttl_days);
        return days * 24 * 60 * 60 * std.time.ns_per_s;
    }

    fn nowNs(self: *const Auth) i96 {
        return Io.Clock.real.now(self.io).nanoseconds;
    }

    /// 密码正确时分配一个会话；返回 Cookie 值与绝对过期时间（Unix 秒）。
    pub fn login(self: *Auth, candidate: []const u8) ?Login {
        if (!config.constantTimeEql(candidate, self.password)) return null;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now = self.nowNs();
        const ttl = self.ttlNs();

        var slot: usize = 0;
        var oldest: i96 = std.math.maxInt(i96);
        for (&self.sessions, 0..) |*s, i| {
            if (!s.used or s.expires_ns <= now) {
                slot = i;
                break;
            }
            if (s.expires_ns < oldest) {
                oldest = s.expires_ns;
                slot = i;
            }
        }

        var raw: [16]u8 = undefined;
        self.io.random(&raw);
        self.sessions[slot] = .{
            .id = raw,
            .expires_ns = now + ttl,
            .last_seen_ns = now,
            .used = true,
        };

        const now_s: i64 = @intCast(@divTrunc(now, std.time.ns_per_s));
        const expires_at_s = now_s + @as(i64, @intCast(self.ttl_days)) * 86400;
        return .{
            .cookie = std.fmt.bytesToHex(raw, .lower),
            .expires_at_s = expires_at_s,
        };
    }

    /// 校验 Cookie 值是否对应一个未过期会话。
    pub fn validate(self: *Auth, cookie_value: []const u8) bool {
        if (cookie_value.len != 32) return false;
        var raw: [16]u8 = undefined;
        _ = std.fmt.hexToBytes(&raw, cookie_value) catch return false;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now = self.nowNs();
        const idle_limit = self.idleNs();
        for (&self.sessions) |*s| {
            if (!s.used) continue;
            if (s.expires_ns <= now) {
                s.used = false;
                continue;
            }
            if (self.idle_hours != 0 and now - s.last_seen_ns > idle_limit) {
                s.used = false;
                continue;
            }
            if (config.constantTimeEql(&s.id, &raw)) {
                s.last_seen_ns = now;
                return true;
            }
        }
        return false;
    }

    /// 为 WebSocket 升级签发一次性短票据：浏览器无法给 WS 请求加自定义头，
    /// 又不想把长期会话放进 URL。票据 30 秒有效、用一次即废。
    pub fn issueTicket(self: *Auth) ?[32]u8 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now = self.nowNs();
        var slot: usize = 0;
        var oldest: i96 = std.math.maxInt(i96);
        for (&self.tickets, 0..) |*t, i| {
            if (!t.used or t.expires_ns <= now) {
                slot = i;
                break;
            }
            if (t.expires_ns < oldest) {
                oldest = t.expires_ns;
                slot = i;
            }
        }

        var raw: [16]u8 = undefined;
        self.io.random(&raw);
        self.tickets[slot] = .{ .id = raw, .expires_ns = now + ticket_ttl_ns, .used = true };
        return std.fmt.bytesToHex(raw, .lower);
    }

    pub fn consumeTicket(self: *Auth, value: []const u8) bool {
        if (value.len != 32) return false;
        var raw: [16]u8 = undefined;
        _ = std.fmt.hexToBytes(&raw, value) catch return false;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now = self.nowNs();
        for (&self.tickets) |*t| {
            if (!t.used) continue;
            if (t.expires_ns <= now) {
                t.used = false;
                continue;
            }
            if (config.constantTimeEql(&t.id, &raw)) {
                t.used = false;
                return true;
            }
        }
        return false;
    }

    /// 定期清理过期/空闲会话与一次性票据。
    pub fn sweep(self: *Auth) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now = self.nowNs();
        const idle_limit = self.idleNs();
        for (&self.sessions) |*s| {
            if (!s.used) continue;
            if (s.expires_ns <= now) {
                s.used = false;
                continue;
            }
            if (self.idle_hours != 0 and now - s.last_seen_ns > idle_limit) s.used = false;
        }
        for (&self.tickets) |*t| {
            if (t.used and t.expires_ns <= now) t.used = false;
        }
    }

    pub fn logout(self: *Auth, cookie_value: []const u8) void {
        if (cookie_value.len != 32) return;
        var raw: [16]u8 = undefined;
        _ = std.fmt.hexToBytes(&raw, cookie_value) catch return;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        for (&self.sessions) |*s| {
            if (s.used and config.constantTimeEql(&s.id, &raw)) {
                s.used = false;
                s.expires_ns = 0;
                return;
            }
        }
    }
};

/// 从 `Cookie:` 头的值里取出会话 id。
pub fn sessionFromCookieHeader(header: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, header, ';');
    while (it.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t");
        const eq = std.mem.indexOfScalar(u8, trimmed, '=') orelse continue;
        const name = std.mem.trim(u8, trimmed[0..eq], " \t");
        if (std.mem.eql(u8, name, cookie_name)) {
            return std.mem.trim(u8, trimmed[eq + 1 ..], " \t");
        }
    }
    return null;
}

/// 在请求头里找 Cookie。
pub fn cookieFromRequest(request: *const http.Server.Request) ?[]const u8 {
    var it = request.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "cookie")) {
            if (sessionFromCookieHeader(header.value)) |value| return value;
        }
    }
    return null;
}

/// 反向代理在终止 TLS 后通常会带 `X-Forwarded-Proto: https`；只有这时才加
/// `Secure`，本地明文访问不受影响。
///
/// 该头只能由本机反向代理覆盖，所以只在对端是回环地址时才信任；否则任何
/// 直连客户端都能伪造它。
pub fn isSecureRequest(request: *const http.Server.Request, trust_forwarded: bool) bool {
    if (!trust_forwarded) return false;
    var it = request.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "x-forwarded-proto")) {
            return std.ascii.eqlIgnoreCase(std.mem.trim(u8, header.value, " \t"), "https");
        }
    }
    return false;
}

/// 生成 `Set-Cookie` 头内容。`value` 为 null 表示清除。
pub fn setCookieValue(buf: []u8, value: ?[]const u8, max_age_seconds: i64, secure: bool) []const u8 {
    const tail = if (secure)
        "; Path=/; HttpOnly; SameSite=Strict; Secure"
    else
        "; Path=/; HttpOnly; SameSite=Strict";
    if (value) |v| {
        return std.fmt.bufPrint(buf, "{s}={s}; Max-Age={d}{s}", .{
            cookie_name, v, max_age_seconds, tail,
        }) catch "";
    }
    return std.fmt.bufPrint(buf, "{s}=; Max-Age=0{s}", .{ cookie_name, tail }) catch "";
}

// ---------------------------------------------------------------------------

test "cookie header parsing" {
    try std.testing.expectEqualStrings(
        "abc123",
        sessionFromCookieHeader("other=1; my_tty_session=abc123; theme=dark").?,
    );
    try std.testing.expect(sessionFromCookieHeader("other=1; theme=dark") == null);
    try std.testing.expectEqualStrings(
        "v",
        sessionFromCookieHeader("my_tty_session = v").?,
    );
}

test "login validate logout" {
    const io = std.testing.io;
    var auth = Auth.init(io, "correct horse", 7, 24);

    try std.testing.expect(auth.login("wrong") == null);

    const session = auth.login("correct horse").?;
    try std.testing.expect(auth.validate(&session.cookie));
    try std.testing.expect(!auth.validate("00000000000000000000000000000000"));

    auth.logout(&session.cookie);
    try std.testing.expect(!auth.validate(&session.cookie));
}

test "zero ttl expires immediately" {
    const io = std.testing.io;
    var auth = Auth.init(io, "pw", 0, 24);
    const session = auth.login("pw").?;
    try std.testing.expect(!auth.validate(&session.cookie));
}

test "ticket is one time" {
    const io = std.testing.io;
    var auth = Auth.init(io, "pw", 7, 24);
    const ticket = auth.issueTicket().?;
    try std.testing.expect(auth.consumeTicket(&ticket));
    try std.testing.expect(!auth.consumeTicket(&ticket));
    try std.testing.expect(!auth.consumeTicket("nope"));
}

test "set cookie format" {
    var buf: [256]u8 = undefined;
    const v = setCookieValue(&buf, "abc", 604800, false);
    try std.testing.expect(std.mem.indexOf(u8, v, "my_tty_session=abc") != null);
    try std.testing.expect(std.mem.indexOf(u8, v, "Max-Age=604800") != null);
    try std.testing.expect(std.mem.indexOf(u8, v, "HttpOnly") != null);

    const cleared = setCookieValue(&buf, null, 0, true);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "Max-Age=0") != null);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "Secure") != null);
}
