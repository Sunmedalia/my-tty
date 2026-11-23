//! 受限文件系统 API：列目录、读、写、建目录、重命名、删除。
//!
//! 边界：所有路径参数都是相对 `root` 的 POSIX 路径。已存在的目标先
//! `realPathFileAlloc` 再校验前缀；新建目标先校验父目录。符号链接因此
//! 无法把访问范围带出 root。
//!
//! 只处理文本：读取上限 1 MiB，含 NUL 视为二进制拒绝。

const std = @import("std");
const http = std.http;
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Dir = std.Io.Dir;
const util = @import("util.zig");

pub const max_read: usize = 1024 * 1024;
pub const max_write: usize = 1024 * 1024;
pub const max_upload: usize = 64 * 1024 * 1024;

pub const Fs = struct {
    /// 规范化后的绝对路径，不以 `/` 结尾（根目录 `/` 除外）。
    root: []const u8,

    pub fn init(io: Io, alloc: Allocator, root: []const u8) !Fs {
        const abs = try Dir.cwd().realPathFileAlloc(io, root, alloc);
        return .{ .root = abs };
    }
};

const Entry = struct {
    name: []const u8,
    kind: []const u8,
    size: u64,
};

pub fn handle(io: Io, gpa: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const target = request.head.target;
    const path = util.pathOnly(target);

    if (std.mem.eql(u8, path, "/api/fs/list")) {
        if (request.head.method != .GET) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return list(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/read")) {
        if (request.head.method != .GET) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return read(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/write")) {
        if (request.head.method != .PUT) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return write(io, gpa, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/mkdir")) {
        if (request.head.method != .POST) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return makeDir(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/rename")) {
        if (request.head.method != .POST) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return rename(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/delete")) {
        if (request.head.method != .DELETE) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return delete(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/upload")) {
        if (request.head.method != .PUT) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return upload(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/download")) {
        if (request.head.method != .GET) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return download(io, arena, fs, request);
    }
    return fail(request, arena, .not_found, "not_found");
}

fn list(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    var dir = Dir.cwd().openDir(io, abs, .{ .iterate = true, .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    defer dir.close(io);

    var entries: std.ArrayList(Entry) = .empty;
    var it = dir.iterate();
    while (it.next(io) catch |err| return failMapped(request, arena, err)) |entry| {
        const name = arena.dupe(u8, entry.name) catch return fail(request, arena, .internal_server_error, "out_of_memory");
        const size: u64 = if (entry.kind == .file) blk: {
            const st = dir.statFile(io, entry.name, .{ .follow_symlinks = false }) catch break :blk 0;
            break :blk st.size;
        } else 0;
        entries.append(arena, .{
            .name = name,
            .kind = @tagName(entry.kind),
            .size = size,
        }) catch return fail(request, arena, .internal_server_error, "out_of_memory");
    }

    std.mem.sort(Entry, entries.items, {}, entryLessThan);

    const Payload = struct { path: []const u8, entries: []const Entry };
    return respondJson(request, arena, .ok, Payload{ .path = rel, .entries = entries.items });
}

fn read(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    const st = Dir.cwd().statFile(io, abs, .{ .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    if (st.kind != .file) return fail(request, arena, .bad_request, "not_a_file");
    if (st.size > max_read) return fail(request, arena, .payload_too_large, "file_too_large");

    const bytes = Dir.cwd().readFileAlloc(io, abs, arena, .limited(max_read)) catch |err|
        return failMapped(request, arena, err);
    if (std.mem.indexOfScalar(u8, bytes, 0) != null)
        return fail(request, arena, .unsupported_media_type, "binary_file");

    const Payload = struct { path: []const u8, content: []const u8, size: u64 };
    return respondJson(request, arena, .ok, Payload{ .path = rel, .content = bytes, .size = st.size });
}

fn write(io: Io, gpa: Allocator, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    if (request.head.content_length) |len| {
        if (len > max_write) return fail(request, arena, .payload_too_large, "body_too_large");
    }

    var body_buf: [4096]u8 = undefined;
    const body_reader = request.readerExpectNone(&body_buf);
    const body = body_reader.allocRemaining(gpa, .limited(max_write)) catch |err| switch (err) {
        error.StreamTooLong => return fail(request, arena, .payload_too_large, "body_too_large"),
        else => return fail(request, arena, .bad_request, "bad_body"),
    };
    defer gpa.free(body);

    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    var atomic = Dir.cwd().createFileAtomic(io, abs, .{ .replace = true }) catch |err|
        return failMapped(request, arena, err);
    defer atomic.deinit(io);
    atomic.file.writeStreamingAll(io, body) catch |err| return failMapped(request, arena, err);
    atomic.replace(io) catch |err| return failMapped(request, arena, err);

    const Payload = struct { ok: bool, path: []const u8, size: usize };
    return respondJson(request, arena, .ok, Payload{ .ok = true, .path = rel, .size = body.len });
}

fn makeDir(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveCreatePath(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    Dir.cwd().createDirPath(io, abs) catch |err| return failMapped(request, arena, err);
    const Payload = struct { ok: bool };
    return respondJson(request, arena, .ok, Payload{ .ok = true });
}

fn rename(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const from_rel = normalized(arena, util.queryParam(request.head.target, "from") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    const to_rel = normalized(arena, util.queryParam(request.head.target, "to") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (from_rel.len == 0 or to_rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    const from_abs = resolveExisting(io, arena, fs, from_rel) catch |err| return failMapped(request, arena, err);
    const to_abs = resolveNew(io, arena, fs, to_rel) catch |err| return failMapped(request, arena, err);
    if (std.mem.eql(u8, from_abs, fs.root)) return fail(request, arena, .forbidden, "cannot_move_root");

    Dir.rename(.cwd(), from_abs, .cwd(), to_abs, io) catch |err| return failMapped(request, arena, err);
    const Payload = struct { ok: bool };
    return respondJson(request, arena, .ok, Payload{ .ok = true });
}

fn delete(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    if (std.mem.eql(u8, abs, fs.root)) return fail(request, arena, .forbidden, "cannot_delete_root");

    const st = Dir.cwd().statFile(io, abs, .{ .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    if (st.kind == .directory) {
        Dir.cwd().deleteTree(io, abs) catch |err| return failMapped(request, arena, err);
    } else {
        Dir.cwd().deleteFile(io, abs) catch |err| return failMapped(request, arena, err);
    }
    const Payload = struct { ok: bool };
    return respondJson(request, arena, .ok, Payload{ .ok = true });
}

fn upload(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    if (request.head.content_length) |len| {
        if (len > max_upload) return fail(request, arena, .payload_too_large, "upload_too_large");
    }

    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    var atomic = Dir.cwd().createFileAtomic(io, abs, .{ .replace = true }) catch |err|
        return failMapped(request, arena, err);
    defer atomic.deinit(io);

    var head_buf: [16 * 1024]u8 = undefined;
    const body_reader = request.readerExpectNone(&head_buf);

    var chunk: [64 * 1024]u8 = undefined;
    var total: u64 = 0;
    while (true) {
        const n = body_reader.readSliceShort(&chunk) catch |err| return failMapped(request, arena, err);
        if (n == 0) break;
        total += n;
        if (total > max_upload) return fail(request, arena, .payload_too_large, "upload_too_large");
        atomic.file.writeStreamingAll(io, chunk[0..n]) catch |err| return failMapped(request, arena, err);
    }

    atomic.replace(io) catch |err| return failMapped(request, arena, err);

    const Payload = struct { ok: bool, path: []const u8, size: u64 };
    return respondJson(request, arena, .ok, Payload{ .ok = true, .path = rel, .size = total });
}

fn download(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, util.queryParam(request.head.target, "path") orelse "") catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const st = Dir.cwd().statFile(io, abs, .{ .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    if (st.kind != .file) return fail(request, arena, .bad_request, "not_a_file");

    var file = Dir.cwd().openFile(io, abs, .{ .mode = .read_only }) catch |err|
        return failMapped(request, arena, err);
    defer file.close(io);

    const name = basename(rel);
    var disposition_buf: [1024]u8 = undefined;
    const disposition = contentDisposition(&disposition_buf, name);

    var headers = [_]http.Header{
        .{ .name = "content-type", .value = "application/octet-stream" },
        .{ .name = "content-disposition", .value = disposition },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    var stream_buf: [64 * 1024]u8 = undefined;
    var body = try request.respondStreaming(&stream_buf, .{
        .content_length = st.size,
        .respond_options = .{ .extra_headers = &headers },
    });

    var file_buf: [64 * 1024]u8 = undefined;
    var file_reader = file.reader(io, &file_buf);
    _ = file_reader.interface.streamRemaining(&body.writer) catch |err| return err;
    return body.end();
}

fn basename(path: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, path, '/') orelse return path;
    return path[slash + 1 ..];
}

fn isUrlSafe(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.' or c == '~';
}

/// `attachment` + ASCII 回退名 + RFC 5987 的 UTF-8 文件名。
fn contentDisposition(buf: []u8, name: []const u8) []const u8 {
    var w: std.Io.Writer = .fixed(buf);
    w.writeAll("attachment; filename=\"") catch return "attachment";
    for (name) |c| {
        const safe = c >= 0x20 and c < 0x7f and c != '"' and c != '\\';
        w.writeByte(if (safe) c else '_') catch return "attachment";
    }
    w.writeAll("\"; filename*=UTF-8''") catch return "attachment";
    for (name) |c| {
        if (isUrlSafe(c)) {
            w.writeByte(c) catch return "attachment";
        } else {
            w.print("%{X:0>2}", .{c}) catch return "attachment";
        }
    }
    return w.buffered();
}

// ---------------------------------------------------------------------------
// 路径处理与响应
// ---------------------------------------------------------------------------

const PathError = error{
    InvalidPath,
    OutsideRoot,
    FileNotFound,
    AccessDenied,
    OutOfMemory,
    IoError,
};

/// 归一化相对路径：拒绝绝对路径、`..`、NUL；丢弃空段与 `.`。
fn normalized(alloc: Allocator, raw: []const u8) ![]const u8 {
    if (raw.len != 0 and raw[0] == '/') return error.InvalidPath;
    if (std.mem.indexOfScalar(u8, raw, 0) != null) return error.InvalidPath;

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);

    var it = std.mem.splitScalar(u8, raw, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) return error.InvalidPath;
        if (out.items.len != 0) try out.append(alloc, '/');
        try out.appendSlice(alloc, part);
    }
    return try alloc.dupe(u8, out.items);
}

fn joinAbs(alloc: Allocator, root: []const u8, rel: []const u8) ![]const u8 {
    if (rel.len == 0) return alloc.dupe(u8, root);
    if (std.mem.eql(u8, root, "/")) return std.fmt.allocPrint(alloc, "/{s}", .{rel});
    return std.fmt.allocPrint(alloc, "{s}/{s}", .{ root, rel });
}

fn resolveExisting(io: Io, alloc: Allocator, fs: *const Fs, rel: []const u8) PathError![:0]u8 {
    const joined = joinAbs(alloc, fs.root, rel) catch return error.OutOfMemory;
    const abs = Dir.cwd().realPathFileAlloc(io, joined, alloc) catch |err| return switch (err) {
        error.FileNotFound => error.FileNotFound,
        error.AccessDenied => error.AccessDenied,
        error.OutOfMemory => error.OutOfMemory,
        else => error.IoError,
    };
    if (!inside(fs.root, abs)) return error.OutsideRoot;
    return abs;
}

/// 目标可以不存在，但父目录必须存在且在 root 内。
fn resolveNew(io: Io, alloc: Allocator, fs: *const Fs, rel: []const u8) PathError![]const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, rel, '/') orelse {
        const parent = try resolveExisting(io, alloc, fs, "");
        return joinAbs(alloc, parent, rel);
    };
    const parent_rel = rel[0..slash];
    const base = rel[slash + 1 ..];
    if (base.len == 0 or std.mem.eql(u8, base, ".") or std.mem.eql(u8, base, ".."))
        return error.InvalidPath;
    const parent = try resolveExisting(io, alloc, fs, parent_rel);
    return joinAbs(alloc, parent, base);
}

/// 递归创建用：找到最深的已存在祖先，校验它在 root 内，再拼上待创建的部分。
fn resolveCreatePath(io: Io, alloc: Allocator, fs: *const Fs, rel: []const u8) PathError![]const u8 {
    var prefix = rel;
    while (true) {
        const joined = joinAbs(alloc, fs.root, prefix) catch return error.OutOfMemory;
        const abs = Dir.cwd().realPathFileAlloc(io, joined, alloc) catch |err| switch (err) {
            error.FileNotFound => {
                if (prefix.len == 0) return error.FileNotFound;
                const slash = std.mem.lastIndexOfScalar(u8, prefix, '/') orelse 0;
                const next = if (slash == 0) "" else prefix[0..slash];
                if (next.len == prefix.len) return error.FileNotFound;
                prefix = next;
                continue;
            },
            else => return error.IoError,
        };
        if (!inside(fs.root, abs)) return error.OutsideRoot;
        if (prefix.len == 0) return joinAbs(alloc, abs, rel);
        return std.fmt.allocPrint(alloc, "{s}/{s}", .{ abs, rel[prefix.len + 1 ..] }) catch
            return error.OutOfMemory;
    }
}

pub fn inside(root: []const u8, abs: []const u8) bool {
    if (std.mem.eql(u8, root, "/")) return abs.len != 0 and abs[0] == '/';
    if (!std.mem.startsWith(u8, abs, root)) return false;
    if (abs.len == root.len) return true;
    return abs[root.len] == '/';
}

fn entryLessThan(_: void, a: Entry, b: Entry) bool {
    const a_dir = std.mem.eql(u8, a.kind, "directory");
    const b_dir = std.mem.eql(u8, b.kind, "directory");
    if (a_dir != b_dir) return a_dir;
    return std.mem.lessThan(u8, a.name, b.name);
}

fn respondJson(request: *http.Server.Request, alloc: Allocator, status: http.Status, value: anytype) anyerror!void {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    std.json.Stringify.value(value, .{}, &out.writer) catch
        return fail(request, alloc, .internal_server_error, "json_encode_failed");

    var headers = [_]http.Header{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    };
    return request.respond(out.written(), .{ .status = status, .extra_headers = &headers });
}

fn fail(request: *http.Server.Request, alloc: Allocator, status: http.Status, code: []const u8) anyerror!void {
    const Payload = struct { @"error": []const u8 };
    return respondJson(request, alloc, status, Payload{ .@"error" = code });
}

fn failMapped(request: *http.Server.Request, alloc: Allocator, err: anyerror) anyerror!void {
    return switch (err) {
        error.InvalidPath => fail(request, alloc, .bad_request, "invalid_path"),
        error.OutsideRoot => fail(request, alloc, .forbidden, "outside_root"),
        error.FileNotFound => fail(request, alloc, .not_found, "not_found"),
        error.PathAlreadyExists => fail(request, alloc, .conflict, "already_exists"),
        error.AccessDenied => fail(request, alloc, .forbidden, "access_denied"),
        error.OutOfMemory => fail(request, alloc, .internal_server_error, "out_of_memory"),
        else => fail(request, alloc, .internal_server_error, "io_error"),
    };
}

// ---------------------------------------------------------------------------

test "normalized rejects traversal and absolute paths" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    try std.testing.expectEqualStrings("a/b", try normalized(a, "a//b/./"));
    try std.testing.expectEqualStrings("", try normalized(a, "."));
    try std.testing.expectError(error.InvalidPath, normalized(a, "../etc"));
    try std.testing.expectError(error.InvalidPath, normalized(a, "a/../../b"));
    try std.testing.expectError(error.InvalidPath, normalized(a, "/etc/passwd"));
}

test "content disposition encoding" {
    var buf: [128]u8 = undefined;
    const plain = contentDisposition(&buf, "a.txt");
    try std.testing.expect(std.mem.indexOf(u8, plain, "filename=\"a.txt\"") != null);

    var buf2: [256]u8 = undefined;
    const cjk = contentDisposition(&buf2, "\u{4e2d}\u{6587}.txt");
    try std.testing.expect(std.mem.indexOf(u8, cjk, "filename*=UTF-8''%E4%B8%AD%E6%96%87.txt") != null);
}

test "basename" {
    try std.testing.expectEqualStrings("b.txt", basename("a/b.txt"));
    try std.testing.expectEqualStrings("a.txt", basename("a.txt"));
}

test "inside boundary" {
    try std.testing.expect(inside("/srv/root", "/srv/root/a"));
    try std.testing.expect(inside("/srv/root", "/srv/root"));
    try std.testing.expect(!inside("/srv/root", "/srv/root2/a"));
    try std.testing.expect(!inside("/srv/root", "/srv"));
    try std.testing.expect(inside("/", "/anything"));
}
