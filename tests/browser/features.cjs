// 字号、搜索、最大化、拖拽分栏、编辑器行号与 Tab。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const ROOT = process.env.ROOT;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };

(async () => {
  fs.writeFileSync(path.join(ROOT, "lines.txt"), "one\ntwo\nthree\n");
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });

  await page.goto(BASE + "/");
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.waitForTimeout(800);

  const before = await page.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")).fontSize);
  await page.click("#font-inc");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")).fontSize);
  assert(before === "14px" && after === "15px", `font size ${before} -> ${after}`);
  await page.click("#font-dec");

  await page.locator(".pane-term").click();
  await page.keyboard.type("printf 'ALPHA\\nBETA\\nALPHA\\n'\r");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("#find-bar:not([hidden])");
  await page.fill("#find-input", "ALPHA");
  await page.waitForTimeout(500);
  assert((await page.evaluate(() => document.querySelectorAll(".xterm-selection div").length)) > 0, "search highlights");
  await page.keyboard.press("Escape");

  await page.locator(".pane").first().hover();
  await page.locator(".pane-max").first().click();
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => document.querySelector("#workspace").classList.contains("maximized")), "maximized");
  const dims = await page.evaluate(() => {
    const a = document.querySelector(".pane.maximized").getBoundingClientRect();
    const b = document.querySelector("#workspace").getBoundingClientRect();
    return { aw: a.width, ah: a.height, bw: b.width, bh: b.height };
  });
  assert(Math.abs(dims.aw - dims.bw) < 4 && Math.abs(dims.ah - dims.bh) < 4, "maximized fills");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.click("#add-pane");
  await page.waitForTimeout(600);
  const splitter = page.locator(".splitter.v");
  assert(await splitter.isVisible(), "splitter visible");
  const box = await splitter.boundingBox();
  const ws = await page.evaluate(() => { const r = document.querySelector("#workspace").getBoundingClientRect(); return { x: r.x, w: r.width, y: r.y, h: r.height }; });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(ws.x + ws.w * 0.7, ws.y + ws.h / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const cols = await page.evaluate(() => document.querySelector("#workspace").style.gridTemplateColumns);
  assert(/0\.7fr 0\.3fr/.test(cols), "splitter moved: " + cols);

  await page.click("#toggle-files");
  await page.waitForSelector("#file-list .entry.file");
  await page.locator("#file-list .entry.file", { hasText: "lines.txt" }).locator(".name").click();
  await page.waitForSelector("#editor-overlay:not([hidden])");
  assert((await page.textContent("#editor-gutter")).trim().split("\n").length === 3, "gutter lines");
  await page.evaluate(() => { const el = document.querySelector("#editor"); el.focus(); el.setSelectionRange(3, 3); });
  await page.keyboard.press("Tab");
  assert((await page.inputValue("#editor")).split("\n")[0].endsWith("  "), "tab indents");
  await page.keyboard.press("Escape");

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("features: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
