const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    // 交叉编译时宿主机 strip 未必认识目标格式，交给 Zig 自己剥离。
    const strip = b.option(bool, "strip", "Strip the installed binary");

    const web_mod = b.createModule(.{
        .root_source_file = b.path("web/embed.zig"),
        .target = target,
        .optimize = optimize,
    });

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = strip,
    });
    mod.addImport("web_assets", web_mod);

    const exe = b.addExecutable(.{
        .name = "my-tty",
        .root_module = mod,
    });
    b.installArtifact(exe);
}
