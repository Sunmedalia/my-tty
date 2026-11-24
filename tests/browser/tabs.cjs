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

  // 窄屏：＋ 跟在可见标签后面，放不下的旧标签折叠进 ⋯ 菜单。
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i += 1) {
    await page.click("#tab-add");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  assert(await page.isVisible("#tab-more"), "overflow shows the collapsed-tabs button");
  const collapsed = await page.locator("#tab-list .tab.collapsed").count();
  assert(collapsed > 0, "old tabs are collapsed");
  assert(
    await page.evaluate(() => {
      const el = document.querySelector("#tab-list .tab.active");
      return !!el && !el.classList.contains("collapsed");
    }),
    "active tab stays visible"
  );
  assert(
    await page.evaluate(() => {
      const shown = [...document.querySelectorAll("#tab-list .tab:not(.collapsed)")];
      const last = shown[shown.length - 1];
      const add = document.querySelector("#tab-add");
      return !!last && add.getBoundingClientRect().left >= last.getBoundingClientRect().right;
    }),
    "+ sits after the last visible tab"
  );

  await page.click("#tab-more");
  await page.waitForSelector("#tab-menu:not([hidden])");
  assert(
    (await page.locator("#tab-menu .menu-tab").count()) === collapsed,
    "menu lists every collapsed tab"
  );
  const chosen = await page.locator("#tab-menu .menu-label").first().textContent();
  await page.locator("#tab-menu .menu-label").first().click();
  await page.waitForTimeout(400);
  assert(await page.isHidden("#tab-menu"), "menu closes after choosing a tab");
  assert(
    (await page.locator("#tab-list .tab.active .tab-label").textContent()) === chosen,
    "chosen tab becomes active"
  );
  assert(
    await page.evaluate(() => {
      const el = document.querySelector("#tab-list .tab.active");
      return !!el && !el.classList.contains("collapsed");
    }),
    "chosen tab is made visible"
  );

  // 收尾：关掉额外标签，避免给后续用例留下太多会话。
  while ((await tabCount(page)) > 1) {
    await page.locator("#tab-list .tab:not(.collapsed) .tab-close").last().click();
    await page.waitForTimeout(150);
  }

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("tabs: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
