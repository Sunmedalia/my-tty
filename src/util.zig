//! HTTP 小工具：从 request target 里取路径和查询参数。
//! 单独放一个文件，测试时就不必把静态资源和整个 server 拉进来。

const std = @import("std");

pub fn pathOnly(target: []const u8) []const u8 {
    const end = std.mem.indexOfAny(u8, target, "?#") orelse target.len;
    return target[0..end];
}

pub const DecodeError = error{ InvalidEncoding, OutOfMemory };

/// 解码 query 参数（application/x-www-form-urlencoded：`+` 表示空格，`%XX`）。
/// 只解码一次；调用方仍要对结果做路径/长度校验。
pub fn queryParamDecoded(
    alloc: std.mem.Allocator,
    target: []const u8,
    key: []const u8,
) DecodeError!?[]u8 {
    const raw = queryParam(target, key) orelse return null;
    return try decodeForm(alloc, raw);
}

fn decodeForm(alloc: std.mem.Allocator, raw: []const u8) DecodeError![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    try out.ensureTotalCapacity(alloc, raw.len);

    var i: usize = 0;
    while (i < raw.len) : (i += 1) {
        const c = raw[i];
        if (c == '+') {
            try out.append(alloc, ' ');
        } else if (c == '%') {
            if (i + 2 >= raw.len) return error.InvalidEncoding;
            const hi = std.fmt.charToDigit(raw[i + 1], 16) catch return error.InvalidEncoding;
            const lo = std.fmt.charToDigit(raw[i + 2], 16) catch return error.InvalidEncoding;
            try out.append(alloc, hi << 4 | lo);
            i += 2;
        } else {
            try out.append(alloc, c);
        }
    }
    return try out.toOwnedSlice(alloc);
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

test "query decoding" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    try std.testing.expectEqualStrings("a b", (try queryParamDecoded(a, "/x?q=a+b", "q")).?);
    try std.testing.expectEqualStrings("中文.txt", (try queryParamDecoded(a, "/x?q=%E4%B8%AD%E6%96%87.txt", "q")).?);
    try std.testing.expectEqualStrings("a+b", (try queryParamDecoded(a, "/x?q=a%2Bb", "q")).?);
    try std.testing.expectEqualStrings("..", (try queryParamDecoded(a, "/x?q=%2e%2e", "q")).?);
    try std.testing.expect((try queryParamDecoded(a, "/x", "q")) == null);
    try std.testing.expectError(error.InvalidEncoding, queryParamDecoded(a, "/x?q=%2", "q"));
    try std.testing.expectError(error.InvalidEncoding, queryParamDecoded(a, "/x?q=%zz", "q"));
}

test "path strips query and fragment" {
    try std.testing.expectEqualStrings("/", pathOnly("/?a=1"));
    try std.testing.expectEqualStrings("/app.js", pathOnly("/app.js?v=1"));
    try std.testing.expectEqualStrings("/a", pathOnly("/a#x"));
}
