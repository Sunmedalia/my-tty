# JetBrains Mono（终端字体）

| 项 | 值 |
|---|---|
| 文件 | `JetBrainsMono-Regular.woff2`（由完整 TTF 子集化，仅保留终端需要的字符，约 40 KB） |
| 版本 | v2.304 |
| 来源 | https://github.com/JetBrains/JetBrainsMono/tree/v2.304 |
| 许可证 | SIL Open Font License 1.1（见 `OFL.txt`） |

## 为什么要内置字体

xterm.js 6 的 DOM 渲染器不支持 `customGlyphs`，方框线（U+2500–U+257F）和
方块（U+2580–U+259F）只能交给字体绘制。系统常见等宽字体（如 DejaVu Sans Mono）
的方块字形高度小于行高，`█` 会按行出现 1–2px 的横向缝隙，TUI 边框也会断线。

JetBrains Mono 的方块/制表符字形能填满单元格，配合 `document.fonts.load` 在创建
Terminal 之前完成字体加载，TUI 边框与色块就是连续的。

## 升级

```sh
# 1) 下载完整字体
curl -L -o /tmp/JetBrainsMono-Regular.ttf \
  https://raw.githubusercontent.com/JetBrains/JetBrainsMono/<tag>/fonts/ttf/JetBrainsMono-Regular.ttf
# 2) 子集化为 woff2（npx subset-font 或自写脚本，保留 ASCII/Latin-1/
#    General Punctuation/Arrows/Box Drawing/Block Elements/Geometric/Braille）
# 3) 放到 web/vendor/fonts/JetBrainsMono-Regular.woff2
curl -L -o web/vendor/fonts/OFL.txt \
  https://raw.githubusercontent.com/JetBrains/JetBrainsMono/<tag>/OFL.txt
```

升级后跑 `zig test src/tests.zig`、`scripts/smoke.sh`，并在浏览器里确认方框与 `█` 连续。
