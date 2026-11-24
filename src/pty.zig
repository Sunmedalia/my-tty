//! Linux PTY：/dev/ptmx + fork/exec，不依赖 libc。
//!
//! 只支持 Linux（x86_64 / aarch64 等通用 ioctl 编码）；其它平台在编译期拒绝。
//! 子进程只调用异步信号安全的系统调用，因此可以安全地在多线程服务器里 fork。

const std = @import("std");
const builtin = @import("builtin");
const linux = std.os.linux;
const posix = std.posix;
const winsize = posix.winsize;

comptime {
    if (builtin.os.tag != .linux) {
        @compileError("my-tty 只支持 Linux：PTY 层直接使用 Linux ioctl 与 fork/exec");
    }
}

pub const Pty = struct {
    /// PTY 主设备。读写它就是终端的输入输出。
    master: posix.fd_t,
    /// shell 的 pid（同时也是会话首进程）。
    child: posix.pid_t,

    pub fn close(p: *Pty) void {
        _ = linux.close(p.master);
        p.master = -1;
    }
};

pub const SpawnError = error{
    OpenPtyFailed,
    UnlockPtyFailed,
    PtyNumberFailed,
    OpenSlaveFailed,
    ForkFailed,
    ShellPathTooLong,
} || std.mem.Allocator.Error;

pub const SpawnOptions = struct {
    shell: []const u8,
    environ: std.process.Environ,
    cols: u16 = 80,
    rows: u16 = 24,
};

pub fn spawn(gpa: std.mem.Allocator, opts: SpawnOptions) SpawnError!Pty {
    // fork 之后子进程不能再分配内存；argv/envp 必须先准备好。
    const shell_z = try gpa.dupeSentinel(u8, opts.shell, 0);
    defer gpa.free(shell_z);
    const home_z = try homePath(gpa, opts.environ);
    defer if (home_z) |h| gpa.free(h);

    var argv = [_]?[*:0]const u8{ shell_z.ptr, "-l", null };
    var env_buf: [512]?[*:0]const u8 = undefined;
    buildEnviron(&env_buf, opts.environ);

    const master = posix.openat(posix.AT.FDCWD, "/dev/ptmx", .{
        .ACCMODE = .RDWR,
        .NOCTTY = true,
        .CLOEXEC = true,
        // 读走 pump 的 poll，写走 writeAll 的 poll；非阻塞主端避免客户端输入
        // 把连接线程永久卡在 write(2) 上。
        .NONBLOCK = true,
    }, 0) catch return error.OpenPtyFailed;
    errdefer _ = linux.close(master);

    var unlock: c_int = 0;
    if (linux.errno(linux.ioctl(master, linux.T.IOCSPTLCK, @intFromPtr(&unlock))) != .SUCCESS)
        return error.UnlockPtyFailed;

    var ptn: c_uint = 0;
    if (linux.errno(linux.ioctl(master, linux.T.IOCGPTN, @intFromPtr(&ptn))) != .SUCCESS)
        return error.PtyNumberFailed;

    var path_buf: [64]u8 = undefined;
    const path_raw = std.fmt.bufPrint(&path_buf, "/dev/pts/{d}", .{ptn}) catch return error.OpenSlaveFailed;
    path_buf[path_raw.len] = 0;
    const slave_path = path_buf[0..path_raw.len :0];

    const slave = posix.openat(posix.AT.FDCWD, slave_path, .{
        .ACCMODE = .RDWR,
        .NOCTTY = true,
    }, 0) catch return error.OpenSlaveFailed;
    errdefer _ = linux.close(slave);

    resize(master, opts.cols, opts.rows);

    const rc = linux.fork();
    switch (linux.errno(rc)) {
        .SUCCESS => {},
        else => return error.ForkFailed,
    }

    if (rc == 0) {
        // ---- 子进程 ----
        _ = linux.close(master);
        _ = linux.setsid();
        _ = linux.ioctl(slave, linux.T.IOCSCTTY, 0);
        _ = linux.dup2(slave, 0);
        _ = linux.dup2(slave, 1);
        _ = linux.dup2(slave, 2);
        if (slave > 2) _ = linux.close(slave);
        if (home_z) |h| _ = linux.chdir(h.ptr);
        _ = linux.execve(shell_z.ptr, @ptrCast(&argv), @ptrCast(&env_buf[0]));
        linux.exit(127);
    }

    // ---- 父进程 ----
    _ = linux.close(slave);
    return .{ .master = master, .child = @intCast(rc) };
}

/// 在 fork 前构造以 null 结尾的 envp，并强制覆盖 TERM / COLORTERM。
fn buildEnviron(buf: *[512]?[*:0]const u8, environ: std.process.Environ) void {
    var n: usize = 0;
    const view = environ.block.view().slice;
    var has_lang = false;
    for (view) |entry| {
        if (n >= buf.len - 4) break;
        const text = std.mem.span(entry);
        const eq = std.mem.indexOfScalar(u8, text, '=') orelse continue;
        const key = text[0..eq];
        if (std.mem.eql(u8, key, "TERM")) continue;
        if (std.mem.eql(u8, key, "COLORTERM")) continue;
        if (std.mem.eql(u8, key, "LANG") or std.mem.eql(u8, key, "LC_ALL")) has_lang = true;
        buf[n] = entry;
        n += 1;
    }
    buf[n] = "TERM=xterm-256color";
    n += 1;
    buf[n] = "COLORTERM=truecolor";
    n += 1;
    if (!has_lang) {
        buf[n] = "LANG=C.UTF-8";
        n += 1;
    }
    buf[n] = null;
}

fn homePath(gpa: std.mem.Allocator, environ: std.process.Environ) !?[:0]const u8 {
    const view = environ.block.view().slice;
    for (view) |entry| {
        const text = std.mem.span(entry);
        if (std.mem.startsWith(u8, text, "HOME=")) {
            return try gpa.dupeSentinel(u8, text["HOME=".len..], 0);
        }
    }
    return null;
}

pub fn resize(master: posix.fd_t, cols: u16, rows: u16) void {
    var ws: winsize = .{
        .row = rows,
        .col = cols,
        .xpixel = 0,
        .ypixel = 0,
    };
    _ = linux.ioctl(master, linux.T.IOCSWINSZ, @intFromPtr(&ws));
}

/// 向 PTY 写入全部数据；主端是非阻塞的，队列满时最多等 10 秒。
/// 一个不读 stdin 的前台程序不能把连接线程/会话永久钉住。
pub fn writeAll(master: posix.fd_t, data: []const u8) !void {
    var fds = [_]posix.pollfd{.{ .fd = master, .events = posix.POLL.OUT, .revents = 0 }};
    var i: usize = 0;
    while (i < data.len) {
        const rc = linux.write(master, data[i..].ptr, data.len - i);
        switch (linux.errno(rc)) {
            .SUCCESS => {
                if (rc == 0) return error.WriteZero;
                i += rc;
            },
            .INTR => continue,
            .AGAIN => {
                fds[0].revents = 0;
                const ready = posix.poll(&fds, 10_000) catch return error.WriteFailed;
                if (ready == 0) return error.WriteTimeout;
                if (fds[0].revents & (posix.POLL.OUT | posix.POLL.ERR | posix.POLL.HUP) == 0)
                    return error.WriteFailed;
            },
            else => return error.WriteFailed,
        }
    }
}

/// 回收 shell，避免僵尸进程。优先 HUP（终端挂断语义），再等待；
/// 如果 shell 忽略 HUP/TERM，300ms 后 SIGKILL，避免销毁会话时永久卡住。
pub fn reap(child: posix.pid_t) void {
    _ = linux.kill(child, .HUP);
    _ = linux.kill(child, .TERM);

    var status: i32 = 0;
    var i: u8 = 0;
    while (i < 30) : (i += 1) {
        const rc = linux.waitpid(child, &status, posix.W.NOHANG);
        switch (linux.errno(rc)) {
            .SUCCESS => if (rc != 0) return,
            .CHILD => return,
            else => {},
        }
        const tick: linux.timespec = .{ .sec = 0, .nsec = 10 * std.time.ns_per_ms };
        _ = linux.nanosleep(&tick, null);
    }

    _ = linux.kill(-child, .KILL);
    _ = linux.kill(child, .KILL);
    _ = linux.waitpid(child, &status, 0);
}

test "buildEnviron overrides TERM and appends LANG" {
    var buf: [512]?[*:0]const u8 = undefined;
    // 手工构造一个只含 TERM 的环境，验证它被过滤掉。
    const fake = [_]?[*:0]const u8{ "TERM=dumb", null };
    const block: std.process.Environ.Block = .{ .slice = fake[0..1 :null] };
    const environ: std.process.Environ = .{ .block = block };

    buildEnviron(&buf, environ);
    var n: usize = 0;
    var saw_term = false;
    var saw_colorterm = false;
    var saw_lang = false;
    while (buf[n] != null) : (n += 1) {
        const text = std.mem.span(buf[n].?);
        if (std.mem.eql(u8, text, "TERM=xterm-256color")) saw_term = true;
        if (std.mem.eql(u8, text, "COLORTERM=truecolor")) saw_colorterm = true;
        if (std.mem.eql(u8, text, "LANG=C.UTF-8")) saw_lang = true;
        try std.testing.expect(!std.mem.eql(u8, text, "TERM=dumb"));
    }
    try std.testing.expect(saw_term and saw_colorterm and saw_lang);
}
