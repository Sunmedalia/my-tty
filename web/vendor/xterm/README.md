# 前端第三方依赖

这些文件是从 npm 包中原样拷出的 **构建产物**，构建 `my-tty` 时不需要 Node/npm。

| 文件 | 来源 | 版本 | 许可证 |
|---|---|---|---|
| `xterm.js` / `xterm.css` | `@xterm/xterm` | 6.0.0 | MIT（见 `LICENSE`） |
| `addon-fit.js` | `@xterm/addon-fit` | 0.11.0 | MIT（见 `LICENSE.addon-fit`） |

## 为什么只用这两个

- xterm 6 的默认渲染器就是 **DOM renderer**（`CoreBrowserTerminal._createRenderer()` 直接
  实例化 `DomRenderer`），不需要、也不引入 WebGL/Canvas addon。
  DOM 渲染保留浏览器原生文本选择，复制粘贴符合直觉。
- `addon-fit` 只负责根据容器尺寸计算行列数，与渲染方式无关。

## 升级方式

```sh
npm pack @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
tar xzf xterm-6.0.0.tgz
cp package/lib/xterm.js package/css/xterm.css package/LICENSE web/vendor/xterm/
tar xzf xterm-addon-fit-0.11.0.tgz
cp package/lib/addon-fit.js package/LICENSE web/vendor/xterm/LICENSE.addon-fit
```

升级后跑 `zig build test` 和 `scripts/smoke.sh`，并在浏览器里确认选择/复制仍然可用。
