//! my-tty：把 Linux PTY 暴露成浏览器里的终端。
//!
//! 只做三件事：静态页面、WebSocket 升级、PTY 桥接。
//! TLS、鉴权体系、反向代理配置都不在本项目内。

const std = @import("std");
const config = @import("config.zig");
const server = @import("server.zig");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = init.minimal.args.toSlice(arena) catch {
        std.debug.print("无法解析命令行参数\n", .{});
        std.process.exit(2);
    };

    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) {
            std.debug.print("{s}", .{config.Config.usage});
            return;
        }
    }

    var cfg = config.Config.parse(arena, init) catch |err| {
        std.debug.print("配置错误: {s}\n\n{s}", .{ describe(err), config.Config.usage });
        std.process.exit(2);
    };

    server.run(init.io, init.gpa, &cfg) catch |err| {
        std.debug.print("启动失败: {t}\n", .{err});
        std.process.exit(1);
    };
}

fn describe(err: config.Config.ParseError) []const u8 {
    return switch (err) {
        error.UnknownArgument => "未知参数",
        error.MissingValue => "参数缺少取值",
        error.InvalidPort => "端口或并发数不合法",
        error.InvalidHost => "监听地址必须是 IPv4 字面量",
        error.EmptyToken => "token 不能为空",
        error.TokenRequired => "监听非回环地址时必须设置 --token",
        error.ConfigReadFailed => "配置文件读取失败",
        error.ConfigInvalid => "配置文件不是合法 JSON 或字段类型不对",
        else => "未知错误",
    };
}
