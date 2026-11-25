单文件 Web 终端：一个静态链接的 Zig 二进制，内置 PTY、多标签/分屏、密码登录、文件管理器和内嵌前端，不需要 Node、数据库或反向代理。

## 下载

| 文件 | 平台 |
|---|---|
| `my-tty-@VERSION@-x86_64-linux.tar.gz` | x86_64 Linux |
| `my-tty-@VERSION@-aarch64-linux.tar.gz` | ARM64 / aarch64 Linux |
| `SHA256SUMS` | 全部资产的校验和 |

每个包里是静态链接的 `my-tty`、中英文 README、`my-tty.example.json` 和 `deploy/my-tty.service`，无运行时依赖。

## 运行

```bash
tar xzf my-tty-@VERSION@-x86_64-linux.tar.gz   # ARM64 换成 aarch64 包名
cd my-tty-@VERSION@-x86_64
./my-tty --host 127.0.0.1 --port 7387 --password '换成你的密码'
```

浏览器打开 `http://127.0.0.1:7387`。自身不处理 TLS，对外部署请放在本机反向代理后面。`deploy/my-tty.service` 是 systemd 示例，配置项和默认值见 `my-tty.example.json` 与 README。

## 功能

- **会话持久**：PTY 由服务端持有，刷新页面或断网重连都回到同一个 shell；输出环形缓冲从 64 KiB 按需增长到 512 KiB，断线期间不丢尾部。
- **多标签 / 分屏**：xterm.js + WebSocket，支持搜索、剪贴板、字体缩放和移动端按键栏；20 秒心跳与自动重连，接管同一会话时有明确提示。
- **文件管理**：树状浏览（只渲染视口附近的行，几千项的目录也流畅）、分片上传与断点偏移续传、下载、在线编辑、目录 tar 下载。
- **登录与边界**：密码登录，HttpOnly cookie，默认 7 天过期 / 24 小时空闲过期；同源检查、连接数上限、未认证请求日志按来源 IP 限速、慢上传整体时限。
- **传输**：前端资源编译期内嵌、启动时预压缩，ETag + `no-cache`（命中回 304）；大于 1 KiB 的 JSON 响应按需 gzip。
- **构建**：CI 用 Zig 0.17.1 在 x86_64 和 ARM64 原生 runner 上编译并剥离符号，二进制在各自架构上直接启动检查。

## 校验

```bash
sha256sum -c SHA256SUMS
```

---

Static single-binary web terminal for Linux (x86_64, aarch64): PTY sessions survive reloads, tabs/panes, password auth, file manager, embedded gzip assets. No Node, database, or reverse proxy required. Built with Zig 0.17.1; see README.en.md.
