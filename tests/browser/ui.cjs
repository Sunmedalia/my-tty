// 登录、会话保持、分屏布局、独立 PTY、编辑器、注销。
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const ROOT = process.env.ROOT;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const near = (a, b, tol = 10) => Math.abs(a - b) <= tol;

(async () => {
  fs.writeFileSync(path.join(ROOT, "edit-me.txt"), "original line\n");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE + "/");
  await page.waitForSelector("#login-overlay:not([hidden])");
  await page.fill("#login-password", "wrong-password");
  await page.click("#login-submit");
  await page.waitForFunction(() => document.querySelector("#login-error").textContent.length > 0);
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("已连接"), null, { timeout: 10000 });

  await page.reload();
  await page.waitForSelector(".pane .xterm");
  assert(await page.isHidden("#login-overlay"), "session survives reload");

  const rects = () => page.evaluate(() => [...document.querySelectorAll(".pane")].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));

  await page.click("#add-pane");
  await page.waitForTimeout(600);
  let r = await rects();
  assert(r.length === 2 && near(r[0].w, r[1].w), "2 panes equal width");
  await page.click("#add-pane");
  await page.waitForTimeout(600);
  r = await rects();
  assert(r.length === 3, "3 panes");
  assert(near(r[0].h, r[1].h + r[2].h, 18), "3 panes: left spans");
  await page.click("#add-pane");
  await page.waitForTimeout(600);
  r = await rects();
  assert(r.length === 4 && near(r[0].w, r[1].w) && near(r[0].h, r[1].h), "4 panes 2x2");
  assert(await page.isDisabled("#add-pane"), "max 4");

  const panes = page.locator(".pane");
  await panes.nth(1).locator(".pane-term").click();
  await page.keyboard.type("echo PANE_ONE_MARK\r");
  await page.waitForTimeout(1200);
  const texts = await page.evaluate(() => [...document.querySelectorAll(".pane")].map((el) => el.innerText));
  assert(texts[1].includes("PANE_ONE_MARK"), "pane 1 ran command");
  assert(!texts[0].includes("PANE_ONE_MARK"), "output not shared");

  await page.click("#toggle-files");
  await page.waitForSelector("#file-list .entry");
  await page.locator("#file-list .entry.file", { hasText: "edit-me.txt" }).locator(".name").click();
  await page.waitForSelector("#editor-overlay:not([hidden])");
  assert((await page.locator("#editor-save svg").count()) === 1, "editor save uses an svg icon");
  assert((await page.locator("#editor-close svg").count()) === 1, "editor close uses an svg icon");
  await page.fill("#editor", "edited from browser\nsecond line\n");
  await page.keyboard.press("Control+KeyS");
  await page.waitForTimeout(800);
  assert(fs.readFileSync(path.join(ROOT, "edit-me.txt"), "utf8") === "edited from browser\nsecond line\n", "editor saved");
  await page.keyboard.press("Escape");

  // 移动端只保留底部按键条里的一个 ^C。
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(250);
  const visibleInterrupts = await page.evaluate(
    () =>
      [...document.querySelectorAll('#send-interrupt, #keys [data-key="ctrlc"]')].filter(
        (el) => el.offsetParent !== null
      ).length
  );
  assert(visibleInterrupts === 1, "mobile shows exactly one ^C button");

  await page.click("#logout");
  await page.waitForSelector("#login-overlay:not([hidden])");
  assert((await rects()).length === 0, "logout closes panes");

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("ui: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
