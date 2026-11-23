//! 内嵌静态资源。
//!
//! 所有前端文件在编译期用 `@embedFile` 打进二进制，运行时不读磁盘、不依赖
//! Node/npm。第三方 xterm.js 的版本与许可证见 `web/vendor/xterm/`。

const std = @import("std");
const web = @import("web_assets");

pub const Asset = struct {
    path: []const u8,
    mime: []const u8,
    body: []const u8,
    cache_control: []const u8,
};

const html: []const u8 = "text/html; charset=utf-8";
const css: []const u8 = "text/css; charset=utf-8";
const js: []const u8 = "text/javascript; charset=utf-8";

pub const all = [_]Asset{
    .{
        .path = "/",
        .mime = html,
        .body = web.index_html,
        .cache_control = "no-store",
    },
    .{
        .path = "/index.html",
        .mime = html,
        .body = web.index_html,
        .cache_control = "no-store",
    },
    .{
        .path = "/app.js",
        .mime = js,
        .body = web.app_js,
        .cache_control = "no-store",
    },
    .{
        .path = "/style.css",
        .mime = css,
        .body = web.style_css,
        .cache_control = "no-store",
    },
    .{
        .path = "/vendor/xterm/xterm.css",
        .mime = css,
        .body = web.xterm_css,
        .cache_control = "public, max-age=86400",
    },
    .{
        .path = "/vendor/xterm/xterm.js",
        .mime = js,
        .body = web.xterm_js,
        .cache_control = "public, max-age=86400",
    },
    .{
        .path = "/vendor/xterm/addon-fit.js",
        .mime = js,
        .body = web.addon_fit_js,
        .cache_control = "public, max-age=86400",
    },
    .{
        .path = "/vendor/fonts/JetBrainsMono-Regular.ttf",
        .mime = "font/ttf",
        .body = web.jetbrains_mono_ttf,
        .cache_control = "public, max-age=86400",
    },
};

pub fn find(path: []const u8) ?*const Asset {
    for (&all) |*asset| {
        if (std.mem.eql(u8, asset.path, path)) return asset;
    }
    return null;
}
