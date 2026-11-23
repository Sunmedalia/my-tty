//! 一个 WebSocket = 一个 PTY shell 会话。
//!
//! 线程模型（每会话两条，够用且好推理）：
//!   - 连接线程：读 WebSocket 消息 -> 写 PTY；负责清理与回收子进程。
//!   - pump 线程：读 PTY -> 写二进制帧给浏览器；shell 退出时 shutdown 套接字，
//!     让连接线程从阻塞读里醒过来。
//!
//! 帧约定：
//!   - 浏览器 -> 服务端：二进制帧 = 键盘输入；文本帧 = JSON 控制指令。
//!   - 服务端 -> 浏览器：二进制帧 = 终端输出；文本帧 = JSON 状态事件。

const std = @import("std");
const http = std.http;
const linux = std.os.linux;
const posix = std.posix;
const net = std.Io.net;
const Io = std.Io;

const pty = @import("pty.zig");
const config = @import("config.zig");

const Allocator = std.mem.Allocator;

/// 同时在线的会话数；连接线程在创建 PTY 前先占位。
var live_sessions = std.atomic.Value(u32).init(0);

pub const SessionError = error{ TooManySessions, PtySpawnFailed };

pub const Control = struct {
    t: []const u8 = "",
    cols: ?u16 = null,
    rows: ?u16 = null,
};

pub fn parseControl(alloc: Allocator, data: []const u8) !std.json.Parsed(Control) {
    return std.json.parseFromSlice(Control, alloc, data, .{ .ignore_unknown_fields = true });
}

pub fn run(
    io: Io,
    gpa: Allocator,
    ws: *http.Server.WebSocket,
    stream: *const net.Stream,
    cfg: *const config.Config,
) !void {
    const previous = live_sessions.fetchAdd(1, .acq_rel);
    defer _ = live_sessions.fetchSub(1, .acq_rel);
    if (previous >= cfg.max_sessions) return error.TooManySessions;

    const spawned = pty.spawn(gpa, .{
        .shell = cfg.shell,
        .environ = cfg.environ,
        .cols = 80,
        .rows = 24,
    }) catch return error.PtySpawnFailed;

    var session: Session = .{
        .io = io,
        .ws = ws,
        .stream = stream,
        .master = spawned.master,
        .child = spawned.child,
    };
    defer session.deinit();

    session.pump_thread = std.Thread.spawn(.{}, pump, .{&session}) catch null;

    var hello_buf: [96]u8 = undefined;
    const hello = std.fmt.bufPrint(&hello_buf, "{{\"t\":\"ready\",\"pid\":{d}}}", .{spawned.child}) catch "{\"t\":\"ready\"}";
    try session.sendText(hello);

    while (true) {
        const msg = ws.readSmallMessage() catch return;
        switch (msg.opcode) {
            .ping => session.sendRaw(msg.data, .pong) catch return,
            .binary => pty.writeAll(session.master, msg.data) catch return,
            .text => session.onControl(msg.data) catch {},
            else => return,
        }
    }
}

const Session = struct {
    io: Io,
    ws: *http.Server.WebSocket,
    stream: *const net.Stream,
    master: posix.fd_t,
    child: posix.pid_t,
    write_mutex: Io.Mutex = .init,
    pump_thread: ?std.Thread = null,

    fn deinit(s: *Session) void {
        // 先关闭 master：pump 线程的阻塞读会返回 EIO，从而自行退出。
        _ = linux.close(s.master);
        s.master = -1;
        pty.reap(s.child);
        if (s.pump_thread) |t| t.join();
    }

    fn sendRaw(s: *Session, data: []const u8, op: http.Server.WebSocket.Opcode) !void {
        try s.write_mutex.lock(s.io);
        defer s.write_mutex.unlock(s.io);
        try s.ws.writeMessage(data, op);
    }

    fn sendText(s: *Session, data: []const u8) !void {
        return s.sendRaw(data, .text);
    }

    fn onControl(s: *Session, data: []const u8) !void {
        var parsed = parseControl(std.heap.page_allocator, data) catch return;
        defer parsed.deinit();
        const c = parsed.value;
        if (std.mem.eql(u8, c.t, "resize")) {
            const cols = c.cols orelse return;
            const rows = c.rows orelse return;
            if (cols < 2 or rows < 1) return;
            pty.resize(s.master, cols, rows);
        }
    }
};

fn pump(s: *Session) void {
    var buf: [8192]u8 = undefined;
    while (true) {
        const n = posix.read(s.master, &buf) catch break;
        if (n == 0) break;
        s.sendRaw(buf[0..n], .binary) catch break;
    }
    s.sendText("{\"t\":\"exit\"}") catch {};
    // 发一个正常的 Close 帧，再 shutdown；只断 TCP 会让浏览器报 1006。
    s.sendRaw("", .connection_close) catch {};
    // 把连接线程从 WebSocket 阻塞读里叫醒，由它统一做清理。
    s.stream.shutdown(s.io, .both) catch {};
}

test "control message parsing" {
    var parsed = try parseControl(std.testing.allocator,
        \\{"t":"resize","cols":120,"rows":40}
    );
    defer parsed.deinit();
    try std.testing.expectEqualStrings("resize", parsed.value.t);
    try std.testing.expectEqual(@as(?u16, 120), parsed.value.cols);
    try std.testing.expectEqual(@as(?u16, 40), parsed.value.rows);
}

test "unknown control fields are ignored" {
    var parsed = try parseControl(std.testing.allocator,
        \\{"t":"ping","extra":true}
    );
    defer parsed.deinit();
    try std.testing.expectEqualStrings("ping", parsed.value.t);
}
