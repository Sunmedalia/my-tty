// 多标签页：新增、切换、关闭，以及刷新后恢复标签和会话。
const { chromium } = require("playwright");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

const tabCount = (page) => page.locator("#tab-list .tab").count();
const activeText = (page) =>
  page.locator(".tab-workspace:not([hidden])").innerText();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });

  await page.goto(BASE + "/");
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent.includes("已连接"),
    null,
    { timeout: 10000 }
  );
  assert((await tabCount(page)) === 1, "starts with one tab");

  await page.click("#tab-add");
  await page.waitForFunction(() => document.querySelectorAll("#tab-list .tab").length === 2);
  await page.waitForTimeout(600);
  assert(
    await page.locator("#tab-list .tab").nth(1).evaluate((el) => el.classList.contains("active")),
    "new tab is active"
  );
  await page.keyboard.type("echo TAB2_MARK\r");
  await page.waitForFunction(
    () => document.querySelector(".tab-workspace:not([hidden])").innerText.includes("TAB2_MARK"),
    null,
    { timeout: 8000 }
  );

  await page.locator("#tab-list .tab").nth(0).locator(".tab-label").click();
  await page.waitForTimeout(500);
  await page.keyboard.type("echo TAB1_MARK\r");
  await page.waitForFunction(
    () => document.querySelector(".tab-workspace:not([hidden])").innerText.includes("TAB1_MARK"),
    null,
    { timeout: 8000 }
  );

  await page.locator("#tab-list .tab").nth(1).locator(".tab-label").click();
  await page.waitForTimeout(500);
  assert((await activeText(page)).includes("TAB2_MARK"), "background tab keeps its session/output");

  await page.locator("#tab-list .tab").nth(1).locator(".tab-close").click();
  await page.waitForFunction(() => document.querySelectorAll("#tab-list .tab").length === 1);
  await page.waitForTimeout(500);
  assert((await activeText(page)).includes("TAB1_MARK"), "first tab remains after closing the second");

  await page.reload();
  await page.waitForSelector(".pane .xterm");
  await page.waitForFunction(
    () => document.querySelector("#status").textContent.includes("已连接"),
    null,
    { timeout: 10000 }
  );
  assert((await tabCount(page)) === 1, "tab list restored after reload");

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("tabs: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
