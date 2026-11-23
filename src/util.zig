//! HTTP 小工具：从 request target 里取路径和查询参数。
//! 单独放一个文件，测试时就不必把静态资源和整个 server 拉进来。

const std = @import("std");

pub fn pathOnly(target: []const u8) []const u8 {
    const end = std.mem.indexOfAny(u8, target, "?#") orelse target.len;
    return target[0..end];
}

pub fn queryParam(target: []const u8, key: []const u8) ?[]const u8 {
    const qmark = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    var it = std.mem.splitScalar(u8, target[qmark + 1 ..], '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (std.mem.eql(u8, pair[0..eq], key)) return pair[eq + 1 ..];
    }
    return null;
}

test "query param extraction" {
    try std.testing.expectEqualStrings("abc", queryParam("/ws?token=abc", "token").?);
    try std.testing.expectEqualStrings("x", queryParam("/ws?a=1&token=x&b=2", "token").?);
    try std.testing.expect(queryParam("/ws?a=1", "token") == null);
    try std.testing.expect(queryParam("/ws", "token") == null);
}

test "path strips query and fragment" {
    try std.testing.expectEqualStrings("/", pathOnly("/?a=1"));
    try std.testing.expectEqualStrings("/app.js", pathOnly("/app.js?v=1"));
    try std.testing.expectEqualStrings("/a", pathOnly("/a#x"));
}
