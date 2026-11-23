const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const web_mod = b.createModule(.{
        .root_source_file = b.path("web/embed.zig"),
        .target = target,
        .optimize = optimize,
    });

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    mod.addImport("web_assets", web_mod);

    const exe = b.addExecutable(.{
        .name = "my-tty",
        .root_module = mod,
    });
    b.installArtifact(exe);
}
