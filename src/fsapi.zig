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

/// 单次 list 最多返回的条目数；超出时截断并标记 `truncated`。
pub const max_list_entries: usize = 10_000;
/// 目录归档的条目/字节上限；超出时停止追加并写入说明文件。
pub const max_tar_entries: usize = 50_000;
pub const max_tar_bytes: u64 = 8 * 1024 * 1024 * 1024;

/// 断点续传临时文件的保留时间；超过后由维护线程清理。
pub const upload_temp_ttl_ns: i96 = 24 * std.time.ns_per_hour;

/// 清理时要遍历的目录深度/条目上限，避免维护线程在大目录上跑太久。
const sweep_max_depth: u32 = 16;
const sweep_max_entries: usize = 50_000;

/// 上传临时文件只对当前用户可读写；完成后再改回普通文件权限。
const upload_temp_mode: std.posix.mode_t = 0o600;
const upload_final_mode: std.posix.mode_t = 0o644;

pub const Fs = struct {
    /// 规范化后的绝对路径，不以 `/` 结尾（根目录 `/` 除外）。
    root: []const u8,

    pub fn init(io: Io, alloc: Allocator, root: []const u8) !Fs {
        var buf: [std.fs.max_path_bytes]u8 = undefined;
        const n = try Dir.cwd().realPathFile(io, root, &buf);
        return .{ .root = try alloc.dupe(u8, buf[0..n]) };
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
        return switch (request.head.method) {
            .PUT => upload(io, arena, fs, request),
            .GET => uploadStatus(io, arena, fs, request),
            .DELETE => uploadCancel(io, arena, fs, request),
            else => fail(request, arena, .method_not_allowed, "method_not_allowed"),
        };
    }
    if (std.mem.eql(u8, path, "/api/fs/archive")) {
        if (request.head.method != .GET) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return archive(io, arena, fs, request);
    }
    if (std.mem.eql(u8, path, "/api/fs/download")) {
        if (request.head.method != .GET) return fail(request, arena, .method_not_allowed, "method_not_allowed");
        return download(io, arena, fs, request);
    }
    return fail(request, arena, .not_found, "not_found");
}

/// 取 query 参数并按 urlencoded 解码（`+` = 空格，`%XX`）。编码非法时按空串处理，
/// 由各接口返回 invalid_path / invalid_id 之类的参数错误。
fn param(arena: Allocator, request: *http.Server.Request, key: []const u8) []const u8 {
    return (util.queryParamDecoded(arena, request.head.target, key) catch null) orelse "";
}

fn list(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    var dir = Dir.cwd().openDir(io, abs, .{ .iterate = true, .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    defer dir.close(io);

    var entries: std.ArrayList(Entry) = .empty;
    var truncated = false;
    var it = dir.iterate();
    while (it.next(io) catch |err| return failMapped(request, arena, err)) |entry| {
        // 目录可能非常大；先截断再排序，避免一次请求吃光内存。
        if (entries.items.len >= max_list_entries) {
            truncated = true;
            break;
        }
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

    const Payload = struct { path: []const u8, entries: []const Entry, truncated: bool };
    return respondJson(request, arena, .ok, Payload{
        .path = rel,
        .entries = entries.items,
        .truncated = truncated,
    });
}

fn read(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
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
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    if (request.head.content_length) |len| {
        if (len > max_write) return fail(request, arena, .payload_too_large, "body_too_large");
    }

    var body_buf: [4096]u8 = undefined;
    const body_reader = request.readerExpectContinue(&body_buf) catch return fail(request, arena, .bad_request, "bad_body");
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
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveCreatePath(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    Dir.cwd().createDirPath(io, abs) catch |err| return failMapped(request, arena, err);
    const Payload = struct { ok: bool };
    return respondJson(request, arena, .ok, Payload{ .ok = true });
}

fn rename(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const from_rel = normalized(arena, param(arena, request, "from")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    const to_rel = normalized(arena, param(arena, request, "to")) catch
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
    const rel = normalized(arena, param(arena, request, "path")) catch
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
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    const raw_id = param(arena, request, "id");
    if (raw_id.len != 0) {
        const valid = validUploadId(raw_id) orelse
            return fail(request, arena, .bad_request, "invalid_id");
        return uploadChunk(io, arena, fs, rel, valid, request);
    }
    return uploadSingle(io, arena, fs, rel, request);
}

fn uploadSingle(io: Io, arena: Allocator, fs: *const Fs, rel: []const u8, request: *http.Server.Request) !void {
    if (request.head.content_length) |len| {
        if (len > max_upload) return fail(request, arena, .payload_too_large, "upload_too_large");
    }

    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);

    var atomic = Dir.cwd().createFileAtomic(io, abs, .{ .replace = true }) catch |err|
        return failMapped(request, arena, err);
    defer atomic.deinit(io);

    var head_buf: [16 * 1024]u8 = undefined;
    const body_reader = request.readerExpectContinue(&head_buf) catch return fail(request, arena, .bad_request, "bad_body");

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

    const Payload = struct { ok: bool, done: bool, path: []const u8, offset: u64 };
    return respondJson(request, arena, .ok, Payload{ .ok = true, .done = true, .path = rel, .offset = total });
}

fn uploadChunk(io: Io, arena: Allocator, fs: *const Fs, rel: []const u8, id: []const u8, request: *http.Server.Request) !void {
    const offset = parseU64(param(arena, request, "offset")) orelse
        return fail(request, arena, .bad_request, "invalid_offset");
    const total = parseU64(param(arena, request, "total")) orelse
        return fail(request, arena, .bad_request, "invalid_total");
    if (total == 0 or total > max_upload) return fail(request, arena, .payload_too_large, "upload_too_large");
    if (offset > total) return fail(request, arena, .bad_request, "invalid_offset");

    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const temp = uploadTempPath(arena, abs, id) catch
        return fail(request, arena, .internal_server_error, "out_of_memory");

    var file: std.Io.File = undefined;
    if (offset == 0) {
        // 先删掉旧临时文件再独占创建：既避免复用上次的半截内容，也避免
        // open(O_TRUNC) 跟随攻击者预先放在这里的符号链接写到 root 之外。
        Dir.cwd().deleteFile(io, temp) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return failMapped(request, arena, err),
        };
        // 半截文件只有本用户可以读写，避免多用户机器上被其他本地用户读到。
        file = Dir.cwd().createFile(io, temp, .{
            .truncate = true,
            .exclusive = true,
            .permissions = .fromMode(upload_temp_mode),
        }) catch |err| return failMapped(request, arena, err);
    } else {
        file = Dir.cwd().openFile(io, temp, .{ .mode = .read_write, .follow_symlinks = false }) catch |err| switch (err) {
            error.FileNotFound => return failOffset(request, arena, .conflict, "offset_mismatch", 0),
            else => return failMapped(request, arena, err),
        };
        const st = file.stat(io) catch |err| {
            file.close(io);
            return failMapped(request, arena, err);
        };
        if (st.size != offset) {
            file.close(io);
            return failOffset(request, arena, .conflict, "offset_mismatch", st.size);
        }
    }

    var closed = false;
    defer if (!closed) file.close(io);

    var write_buf: [64 * 1024]u8 = undefined;
    var fw = file.writer(io, &write_buf);
    fw.seekTo(offset) catch |err| return failMapped(request, arena, err);

    var head_buf: [16 * 1024]u8 = undefined;
    const body_reader = request.readerExpectContinue(&head_buf) catch return fail(request, arena, .bad_request, "bad_body");

    var chunk: [64 * 1024]u8 = undefined;
    var written: u64 = offset;
    while (true) {
        const n = body_reader.readSliceShort(&chunk) catch |err| return failMapped(request, arena, err);
        if (n == 0) break;
        written += n;
        if (written > total) return fail(request, arena, .payload_too_large, "upload_too_large");
        fw.interface.writeAll(chunk[0..n]) catch |err| return failMapped(request, arena, err);
    }
    fw.interface.flush() catch |err| return failMapped(request, arena, err);

    // 完整写入后改回普通文件权限再 rename；未完成的半截文件保持 0600。
    // 用 fd 上的 chmod，不经过路径，因此不受符号链接替换影响。
    if (written == total) {
        file.setPermissions(io, .fromMode(upload_final_mode)) catch {};
    }

    file.close(io);
    closed = true;

    if (written < total) {
        const Payload = struct { ok: bool, done: bool, offset: u64 };
        return respondJson(request, arena, .ok, Payload{ .ok = true, .done = false, .offset = written });
    }

    Dir.rename(.cwd(), temp, .cwd(), abs, io) catch |err| return failMapped(request, arena, err);
    const Payload = struct { ok: bool, done: bool, path: []const u8, offset: u64 };
    return respondJson(request, arena, .ok, Payload{ .ok = true, .done = true, .path = rel, .offset = total });
}

fn uploadStatus(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    const raw_id = param(arena, request, "id");
    if (raw_id.len == 0) return fail(request, arena, .bad_request, "invalid_id");
    const id = validUploadId(raw_id) orelse return fail(request, arena, .bad_request, "invalid_id");
    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const temp = uploadTempPath(arena, abs, id) catch
        return fail(request, arena, .internal_server_error, "out_of_memory");

    const st = Dir.cwd().statFile(io, temp, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return failMapped(request, arena, err),
    };
    const Payload = struct { offset: u64 };
    return respondJson(request, arena, .ok, Payload{ .offset = if (st) |x| x.size else 0 });
}

fn uploadCancel(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    const raw_id = param(arena, request, "id");
    if (raw_id.len == 0) return fail(request, arena, .bad_request, "invalid_id");
    const id = validUploadId(raw_id) orelse return fail(request, arena, .bad_request, "invalid_id");
    const abs = resolveNew(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const temp = uploadTempPath(arena, abs, id) catch
        return fail(request, arena, .internal_server_error, "out_of_memory");

    Dir.cwd().deleteFile(io, temp) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return failMapped(request, arena, err),
    };
    const Payload = struct { ok: bool };
    return respondJson(request, arena, .ok, Payload{ .ok = true });
}

fn validUploadId(raw: []const u8) ?[]const u8 {
    if (raw.len < 8 or raw.len > 32) return null;
    for (raw) |c| if (!std.ascii.isHex(c)) return null;
    return raw;
}

fn uploadTempPath(alloc: Allocator, target_abs: []const u8, id: []const u8) ![]const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, target_abs, '/') orelse return error.InvalidPath;
    return std.fmt.allocPrint(alloc, "{s}/.myty-upload-{s}", .{ target_abs[0..slash], id });
}

/// `.myty-upload-<8..32 hex>`，与上传时生成的临时文件名一致。
fn isUploadTempName(name: []const u8) bool {
    const prefix = ".myty-upload-";
    if (!std.mem.startsWith(u8, name, prefix)) return false;
    return validUploadId(name[prefix.len..]) != null;
}

/// 清理超过 `ttl_ns` 没有更新的断点续传临时文件。
///
/// 只删除 root 内、名字严格匹配 `.myty-upload-<8..32 hex>` 的普通文件；
/// 不跟随符号链接，深度和条目数都有上限，避免维护线程在超大目录上跑太久。
pub fn sweepUploadTemps(io: Io, alloc: Allocator, fs: *const Fs, ttl_ns: i96) void {
    const cutoff = Io.Clock.real.now(io).nanoseconds - ttl_ns;
    var budget: usize = sweep_max_entries;
    const root = alloc.dupe(u8, fs.root) catch return;
    defer alloc.free(root);
    sweepTempsIn(io, alloc, root, 0, cutoff, &budget);
}

fn sweepTempsIn(
    io: Io,
    alloc: Allocator,
    dir_abs: []const u8,
    depth: u32,
    cutoff: i96,
    budget: *usize,
) void {
    if (depth > sweep_max_depth) return;

    var dir = Dir.cwd().openDir(io, dir_abs, .{ .iterate = true, .follow_symlinks = false }) catch return;
    defer dir.close(io);

    var it = dir.iterate();
    while (true) {
        if (budget.* == 0) return;
        const entry = it.next(io) catch return orelse return;
        budget.* -= 1;

        if (isUploadTempName(entry.name)) {
            const st = dir.statFile(io, entry.name, .{ .follow_symlinks = false }) catch continue;
            if (st.kind != .file) continue;
            if (st.mtime.nanoseconds > cutoff) continue;
            const path = std.fmt.allocPrint(alloc, "{s}/{s}", .{ dir_abs, entry.name }) catch continue;
            defer alloc.free(path);
            Dir.cwd().deleteFile(io, path) catch {};
            continue;
        }

        if (entry.kind != .directory) continue;
        const child = std.fmt.allocPrint(alloc, "{s}/{s}", .{ dir_abs, entry.name }) catch continue;
        defer alloc.free(child);
        sweepTempsIn(io, alloc, child, depth + 1, cutoff, budget);
    }
}

fn parseU64(text: []const u8) ?u64 {
    return std.fmt.parseInt(u64, text, 10) catch null;
}

fn failOffset(request: *http.Server.Request, alloc: Allocator, status: http.Status, code: []const u8, offset: u64) !void {
    const Payload = struct { @"error": []const u8, offset: u64 };
    return respondJson(request, alloc, status, Payload{ .@"error" = code, .offset = offset });
}

fn archive(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const st = Dir.cwd().statFile(io, abs, .{ .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    if (st.kind != .directory) return fail(request, arena, .bad_request, "not_a_directory");

    const base = basename(rel);
    const root_name = if (base.len == 0) "root" else base;

    var name_buf: [512]u8 = undefined;
    const tar_name = std.fmt.bufPrint(&name_buf, "{s}.tar", .{root_name}) catch "archive.tar";
    var disposition_buf: [1024]u8 = undefined;
    const disposition = contentDisposition(&disposition_buf, tar_name);

    var headers = [_]http.Header{
        .{ .name = "content-type", .value = "application/x-tar" },
        .{ .name = "content-disposition", .value = disposition },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    var stream_buf: [64 * 1024]u8 = undefined;
    var body = try request.respondStreaming(&stream_buf, .{
        .respond_options = .{ .extra_headers = &headers },
    });

    var tw: std.tar.Writer = .{ .underlying_writer = &body.writer };
    tw.setRoot(root_name) catch return error.WriteFailed;
    var state: TarState = .{};
    try walkTar(io, arena, &tw, &state, abs, "", 0);
    if (state.truncated) {
        // 不能中途直接断流（客户端会当成损坏的 tar）；写完截止点再补一个说明文件。
        tw.writeFileBytes(
            "MY-TTY-TRUNCATED.txt",
            "归档内容超过服务端上限，已截断。请改为下载子目录，或单独下载文件。\n" ++
                "本文件由 my-tty 自动生成。\n",
            .{},
        ) catch {};
    }
    tw.finishPedantically() catch return error.WriteFailed;
    return body.end();
}

const TarState = struct {
    entries: usize = 0,
    bytes: u64 = 0,
    truncated: bool = false,
};

fn walkTar(
    io: Io,
    alloc: Allocator,
    tw: *std.tar.Writer,
    state: *TarState,
    dir_abs: []const u8,
    prefix: []const u8,
    depth: u32,
) !void {
    if (state.truncated) return;
    if (depth > 64) {
        state.truncated = true;
        return;
    }

    var dir = Dir.cwd().openDir(io, dir_abs, .{ .iterate = true, .follow_symlinks = false }) catch return;
    defer dir.close(io);

    var it = dir.iterate();
    while (it.next(io) catch return) |entry| {
        if (state.truncated) return;
        if (state.entries >= max_tar_entries) {
            state.truncated = true;
            return;
        }

        const sub = if (prefix.len == 0)
            try alloc.dupe(u8, entry.name)
        else
            try std.fmt.allocPrint(alloc, "{s}/{s}", .{ prefix, entry.name });

        switch (entry.kind) {
            .directory => {
                state.entries += 1;
                tw.writeDir(sub, .{}) catch continue;
                const child_abs = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ dir_abs, entry.name });
                walkTar(io, alloc, tw, state, child_abs, sub, depth + 1) catch {};
            },
            .file => {
                var file = dir.openFile(io, entry.name, .{ .follow_symlinks = false }) catch continue;
                defer file.close(io);
                const st = file.stat(io) catch continue;
                // 流式 tar 的头部要预先写长度，不能一边超限一边回头改。
                if (st.size > max_tar_bytes - state.bytes) {
                    state.truncated = true;
                    return;
                }
                state.entries += 1;
                state.bytes += st.size;
                var buf: [64 * 1024]u8 = undefined;
                var fr = file.reader(io, &buf);
                tw.writeFileStream(sub, st.size, &fr.interface, .{}) catch continue;
            },
            else => {},
        }
    }
}

fn download(io: Io, arena: Allocator, fs: *const Fs, request: *http.Server.Request) !void {
    const rel = normalized(arena, param(arena, request, "path")) catch
        return fail(request, arena, .bad_request, "invalid_path");
    if (rel.len == 0) return fail(request, arena, .bad_request, "invalid_path");

    const abs = resolveExisting(io, arena, fs, rel) catch |err| return failMapped(request, arena, err);
    const st = Dir.cwd().statFile(io, abs, .{ .follow_symlinks = false }) catch |err|
        return failMapped(request, arena, err);
    if (st.kind != .file) return fail(request, arena, .bad_request, "not_a_file");

    var file = Dir.cwd().openFile(io, abs, .{ .mode = .read_only, .follow_symlinks = false }) catch |err|
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
    // 必须按 stat 得到的长度发送，否则文件在传输期间变长会多发字节、破坏
    // Content-Length 和 keep-alive 的帧边界。
    file_reader.interface.streamExact64(&body.writer, st.size) catch |err| return err;
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
        return respondStatic(request, .internal_server_error, "{\"error\":\"json_encode_failed\"}");

    var headers = [_]http.Header{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    };
    return request.respond(out.written(), .{ .status = status, .extra_headers = &headers });
}

/// 不经过 JSON 编码 / 分配器的固定响应，避免 OOM 时递归调用自身。
fn respondStatic(request: *http.Server.Request, status: http.Status, body: []const u8) !void {
    var headers = [_]http.Header{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "cache-control", .value = "no-store" },
    };
    return request.respond(body, .{ .status = status, .extra_headers = &headers });
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

test "upload id validation" {
    try std.testing.expect(validUploadId("abcdef0123456789") != null);
    try std.testing.expect(validUploadId("abcdef") == null);
    try std.testing.expect(validUploadId("zzzzzzzz") == null);
    try std.testing.expect(validUploadId("0123456789abcdef0123456789abcdef0") == null);
}

test "upload temp name matching" {
    try std.testing.expect(isUploadTempName(".myty-upload-abcdef0123456789"));
    try std.testing.expect(!isUploadTempName(".myty-upload-abc"));
    try std.testing.expect(!isUploadTempName(".myty-upload-zzzzzzzz"));
    try std.testing.expect(!isUploadTempName("myty-upload-abcdef0123456789"));
}

test "upload temp path stays beside the target" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try std.testing.expectEqualStrings(
        "/srv/work/dir/.myty-upload-abcdef01",
        try uploadTempPath(a, "/srv/work/dir/file.txt", "abcdef01"),
    );
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
