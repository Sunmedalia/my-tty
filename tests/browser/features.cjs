// 字号、搜索、拖拽分栏、编辑器行号与 Tab。
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

  // 顶栏 ^C：不依赖键盘 Ctrl（RDP 等环境）
  await page.locator(".pane-term").click();
  await page.keyboard.type("sleep 30\r");
  await page.waitForTimeout(400);
  await page.click("#send-interrupt");
  await page.keyboard.type("printf 'INTERRUPT_BTN_%s\\n' OK\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("INTERRUPT_BTN_OK"),
    null,
    { timeout: 8000 }
  );

  // Safari / 输入法丢字回归：keydown 之后到达的 composed insertText 不能被
  // xterm 的 _keyDownSeen 去重逻辑吞掉。
  await page.locator(".pane-term").click();
  await page.keyboard.type("printf 'READY_%s\\n' MARK; read -r X; echo ILEN=${#X}; echo IVAL=$X\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("READY_MARK"),
    null,
    { timeout: 8000 }
  );
  await page.evaluate(() => {
    const ta = document.querySelector(".xterm-helper-textarea");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true }));
    const opts = { data: "Z", inputType: "insertText", composed: true, bubbles: true, cancelable: true };
    ta.dispatchEvent(new InputEvent("beforeinput", opts));
    ta.dispatchEvent(new InputEvent("input", opts));
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("IVAL=Z"),
    null,
    { timeout: 8000 }
  );
  assert(
    (await page.locator(".xterm-rows").innerText()).includes("ILEN=1"),
    "composed insertText is not dropped"
  );

  // 移动端重复输入回归：keydown 已经发出字符后，浏览器又补发一次 composed
  // insertText。不能再清 _keyDownSeen，否则 Z 会变成 ZZ（ls -> llss）。
  await page.keyboard.type("printf 'READY2_%s\\n' MARK; read -r Y; echo YLEN=${#Y}; echo YVAL=$Y\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("READY2_MARK"),
    null,
    { timeout: 8000 }
  );
  await page.evaluate(() => document.querySelector(".xterm-helper-textarea").focus());
  await page.keyboard.down("Z");
  await page.evaluate(() => {
    const ta = document.querySelector(".xterm-helper-textarea");
    ta.focus();
    const opts = { data: "Z", inputType: "insertText", composed: true, bubbles: true, cancelable: true };
    ta.dispatchEvent(new InputEvent("beforeinput", opts));
    ta.dispatchEvent(new InputEvent("input", opts));
  });
  await page.keyboard.up("Z");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("YVAL=Z"),
    null,
    { timeout: 8000 }
  );
  assert(
    (await page.locator(".xterm-rows").innerText()).includes("YLEN=1"),
    "composed insertText after keydown must not double the character"
  );

  await page.locator(".pane-term").click();
  await page.keyboard.type("printf 'FIND_%s\\nOTHER\\nFIND\\n' MARK\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("FIND_MARK"),
    null,
    { timeout: 8000 }
  );
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("#find-bar:not([hidden])");
  await page.fill("#find-input", "FIND");
  await page.waitForFunction(
    () => document.querySelectorAll(".xterm-selection div").length > 0,
    null,
    { timeout: 8000 }
  );
  await page.keyboard.press("Escape");

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
