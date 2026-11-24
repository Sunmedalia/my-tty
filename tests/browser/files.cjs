// 9 MiB 分片上传、下载往返、目录 tar、临时文件清理。
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const ROOT = process.env.ROOT;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const src = path.join(os.tmpdir(), "my-tty-upload-src.bin");
  const dst = path.join(os.tmpdir(), "my-tty-upload-dst.bin");
  const big = Buffer.alloc(9 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  fs.writeFileSync(src, big);

  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });

  await page.goto(BASE + "/");
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.click("#toggle-files");
  await page.waitForSelector("#file-list");

  // 新建文件名必须是应用内弹窗，而不是原生 prompt。
  await page.click("#files-new-file");
  await page.waitForSelector("#prompt-overlay:not([hidden])");
  await page.fill("#prompt-input", "created-by-modal.txt");
  await page.click("#prompt-ok");
  await page.waitForSelector("#editor-overlay:not([hidden])");
  await page.click("#editor-close");
  await page.waitForTimeout(200);

  await page.setInputFiles("#upload-input", src);
  await page.waitForFunction(() => document.querySelector("#file-list").innerText.includes("my-tty-upload-src.bin"), null, { timeout: 20000 });
  const onDisk = fs.readFileSync(path.join(ROOT, "my-tty-upload-src.bin"));
  assert(onDisk.equals(big), "9 MiB upload bytes match");

  const row = page.locator("#file-list .entry.file", { hasText: "my-tty-upload-src.bin" });
  await row.hover();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row.locator('button[title="下载"]').click(),
  ]);
  await download.saveAs(dst);
  assert(fs.readFileSync(dst).equals(big), "download bytes match");

  fs.mkdirSync(path.join(ROOT, "arch"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "arch", "x.txt"), "ARCHIVE_X");
  await page.click("#files-refresh");
  await page.waitForFunction(() => document.querySelector("#file-list").innerText.includes("arch"));
  const dirRow = page.locator("#file-list .entry.directory", { hasText: "arch" });
  await dirRow.locator(".caret").click();
  await page.waitForFunction(
    () => [...document.querySelectorAll("#file-list .entry.file")].some((el) => el.textContent.includes("x.txt")),
    null,
    { timeout: 8000 }
  );
  await dirRow.hover();
  const [tar] = await Promise.all([
    page.waitForEvent("download"),
    dirRow.locator('button[title="下载目录（tar）"]').click(),
  ]);
  const tarPath = path.join(os.tmpdir(), "my-tty-arch.tar");
  await tar.saveAs(tarPath);
  assert(fs.statSync(tarPath).size > 512, "tar downloaded");
  assert(tar.suggestedFilename() === "arch.tar", "tar filename");

  const leftovers = fs.readdirSync(ROOT).filter((n) => n.startsWith(".myty-upload-"));
  assert(leftovers.length === 0, "no temp files");
  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("files: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
