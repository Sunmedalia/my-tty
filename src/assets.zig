//! 内嵌静态资源。
//!
//! 所有前端文件在编译期用 `@embedFile` 打进二进制，运行时不读磁盘、不依赖
//! Node/npm。第三方 xterm.js 的版本与许可证见 `web/vendor/xterm/`。
//!
//! 启动时把可压缩的资源预压成 gzip（约 730 KiB → 218 KiB），并生成一个本进程
//! 唯一的 ETag：浏览器用 `no-cache` 每次校验，重启后 ETag 变化，不会拿旧文件。

const std = @import("std");
const util = @import("util.zig");
const web = @import("web_assets");

pub const Asset = struct {
    path: []const u8,
    mime: []const u8,
    body: []const u8,
    /// 资源只随二进制变化，用 no-cache + ETag 让浏览器每次校验、命中回 304。
    cache_control: []const u8 = "no-cache",
    /// 启动时预压缩的 gzip 副本；null 表示按明文发送（太小或压缩失败）。
    gzip: ?[]const u8 = null,
};

const html: []const u8 = "text/html; charset=utf-8";
const css: []const u8 = "text/css; charset=utf-8";
const js: []const u8 = "text/javascript; charset=utf-8";

pub var all = [_]Asset{
    .{
        .path = "/",
        .mime = html,
        .body = web.index_html,
    },
    .{
        .path = "/index.html",
        .mime = html,
        .body = web.index_html,
    },
    .{
        .path = "/app.js",
        .mime = js,
        .body = web.app_js,
    },
    .{
        .path = "/style.css",
        .mime = css,
        .body = web.style_css,
    },
    .{
        .path = "/vendor/xterm/xterm.css",
        .mime = css,
        .body = web.xterm_css,
    },
    .{
        .path = "/vendor/xterm/xterm.js",
        .mime = js,
        .body = web.xterm_js,
    },
    .{
        .path = "/vendor/xterm/addon-fit.js",
        .mime = js,
        .body = web.addon_fit_js,
    },
    .{
        .path = "/vendor/xterm/addon-search.js",
        .mime = js,
        .body = web.addon_search_js,
    },
    .{
        .path = "/vendor/xterm/addon-web-links.js",
        .mime = js,
        .body = web.addon_web_links_js,
    },
    .{
        .path = "/vendor/fonts/JetBrainsMono-Regular.woff2",
        .mime = "font/woff2",
        .body = web.jetbrains_mono_woff2,
    },
};

/// `"<32 hex>"` 与 `"<32 hex>-gz"`；两种编码使用不同 ETag，严格符合 Vary 语义。
var etag_plain: [34]u8 = undefined;
var etag_gzip: [37]u8 = undefined;

const min_gzip_bytes = 1024;

/// 启动时调用一次，之后 `all` 只读。内存不足时逐个回退成明文，不影响启动。
pub fn prepare(io: std.Io, allocator: std.mem.Allocator) void {
    var raw: [16]u8 = undefined;
    io.random(&raw);
    const hex = std.fmt.bytesToHex(raw, .lower);
    _ = std.fmt.bufPrint(&etag_plain, "\"{s}\"", .{&hex}) catch unreachable;
    _ = std.fmt.bufPrint(&etag_gzip, "\"{s}-gz\"", .{&hex}) catch unreachable;

    for (&all) |*asset| {
        if (asset.body.len < min_gzip_bytes) continue;
        const zipped = util.gzipAlloc(allocator, asset.body) catch continue;
        // woff2 之类本来就压缩过的资源再 gzip 只会更大，保持原样。
        if (zipped.len >= asset.body.len) {
            allocator.free(zipped);
            continue;
        }
        asset.gzip = zipped;
    }
}

pub fn deinit(allocator: std.mem.Allocator) void {
    for (&all) |*asset| {
        if (asset.gzip) |buf| allocator.free(buf);
        asset.gzip = null;
    }
}

pub fn etag(gzip: bool) []const u8 {
    return if (gzip) &etag_gzip else &etag_plain;
}

pub fn find(path: []const u8) ?*const Asset {
    for (&all) |*asset| {
        if (std.mem.eql(u8, asset.path, path)) return asset;
    }
    return null;
}
