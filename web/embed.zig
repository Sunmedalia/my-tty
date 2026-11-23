//! 前端静态资源的编译期入口。
//!
//! 单独做成一个 module，是因为 Zig 只允许 `@embedFile` 读取模块根目录内的文件；
//! 根模块在 `src/` 下，直接写 `../web/...` 会被拒绝。

pub const index_html = @embedFile("index.html");
pub const app_js = @embedFile("app.js");
pub const style_css = @embedFile("style.css");
pub const xterm_css = @embedFile("vendor/xterm/xterm.css");
pub const xterm_js = @embedFile("vendor/xterm/xterm.js");
pub const addon_fit_js = @embedFile("vendor/xterm/addon-fit.js");
