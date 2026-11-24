// 终端 cwd 同步：cd 后文件树跟随；手动回到根目录后执行 pwd 会重新同步。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const ROOT = process.env.ROOT;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  const sub = path.join(ROOT, "cwd-sub");
  fs.mkdirSync(sub, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });

  const activeCrumb = () =>
    page.evaluate(() => {
      const el = document.querySelector("#crumb button.active");
      return el ? el.textContent : "";
    });
  const waitCrumb = (name) =>
    page.waitForFunction(
      (want) => {
        const el = document.querySelector("#crumb button.active");
        return !!el && el.textContent === want;
      },
      name,
      { timeout: 10000 }
    );

  await page.goto(BASE + "/");
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.waitForSelector("#status.ok", { timeout: 10000 });
  await page.click("#toggle-files");
  await page.waitForSelector("#file-list");

  // cd 到 root 下的子目录：回车后客户端会主动请求 cwd。
  await page.locator(".pane-term").click();
  await page.keyboard.type(`cd '${sub}'\r`);
  await waitCrumb("cwd-sub");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#file-list .entry.selected");
      return !!el && el.textContent.includes("cwd-sub");
    },
    null,
    { timeout: 10000 }
  );

  // 手动把文件树切回根目录，再执行 pwd：树应重新跳到 shell 的 cwd。
  await page.locator("#crumb button").first().click();
  await waitCrumb("/");
  await page.locator(".pane-term").click();
  await page.keyboard.type("pwd\r");
  await waitCrumb("cwd-sub");
  assert((await activeCrumb()) === "cwd-sub", "pwd resyncs the tree");

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("cwd: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
