// 会话保持：刷新后回到同一个 shell、增量回放、页内重连不重建终端（选区保留）、
// 关闭分屏结束会话；同时验证复制/粘贴不受影响。
const { chromium } = require("playwright");

const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD;
const CHROME = process.env.CHROME || undefined;
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitReady(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ready frame")), 5000);
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      if (msg.t === "ready") {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.onerror = () => reject(new Error("probe websocket error"));
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 700 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) errors.push(m.text()); });

  const termText = () => page.locator(".xterm-rows").innerText();
  const storedIds = () =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem("myttty.sessions") || "[]"));
  const selectAllWithMouse = async () => {
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };

  await page.goto(BASE + "/");
  await page.fill("#login-password", PASSWORD);
  await page.click("#login-submit");
  await page.waitForSelector(".pane .xterm");
  await page.waitForSelector("#status.ok", { timeout: 5000 });
  await page.locator(".pane-term").click();

  await page.keyboard.type("export MYTTY_TOKEN=ALIVE; echo FIRST_MARK\r");
  await page.waitForFunction(() => document.querySelector(".xterm-rows").innerText.includes("FIRST_MARK"));
  const ids = await storedIds();
  assert(ids.length === 1 && /^[0-9a-f]{32}$/.test(ids[0]), "session id stored: " + JSON.stringify(ids));

  // 刷新：重连同一个 shell，并回放之前输出
  await page.reload();
  await page.waitForSelector(".pane .xterm");
  await page.waitForSelector("#status.ok", { timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("FIRST_MARK"),
    null,
    { timeout: 5000 }
  );
  await page.locator(".pane-term").click();
  await page.keyboard.type("echo TOKEN=$MYTTY_TOKEN; echo SECOND_MARK\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("SECOND_MARK"),
    null,
    { timeout: 5000 }
  );
  assert((await termText()).includes("TOKEN=ALIVE"), "same shell after reload");

  // 回放之后复制/粘贴仍然正常
  await selectAllWithMouse();
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert(copied.includes("SECOND_MARK"), "copy works after replay");

  await page.evaluate(() => navigator.clipboard.writeText("PASTE_AFTER_RESUME"));
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(400);
  assert((await termText()).includes("PASTE_AFTER_RESUME"), "paste works after replay");
  await page.keyboard.press("Control+U");

  // 页内重连：另一个前端接管会话 → 浏览器被踢下线 → 点击状态重连。
  // 终端不重建，所以选区还在、复制仍然可用。
  await selectAllWithMouse();
  const beforeReconnect = await termText();
  const sidNow = (await storedIds())[0];
  const ticket = await page.evaluate(async () => {
    const r = await fetch("/api/auth/ticket", { method: "POST" });
    return (await r.json()).ticket;
  });
  const other = new WebSocket(
    BASE.replace(/^http/, "ws") + `/ws?ticket=${encodeURIComponent(ticket)}&session=${sidNow}&offset=0`
  );
  other.binaryType = "arraybuffer";
  await new Promise((res, rej) => {
    other.onopen = res;
    other.onerror = () => rej(new Error("second websocket failed"));
  });
  await page.waitForFunction(
    () => document.querySelector(".pane-status").textContent.includes("已断开"),
    null,
    { timeout: 8000 }
  );
  other.close();
  await sleep(300);

  await page.locator(".pane-status").click();
  await page.waitForFunction(
    () => document.querySelector(".pane-status").textContent.includes("已连接"),
    null,
    { timeout: 8000 }
  );
  await page.waitForTimeout(400);

  const selectionAfter = await page.evaluate(() => document.querySelectorAll(".xterm-selection div").length);
  assert(selectionAfter > 0, "selection survives in-page reconnect");
  assert((await termText()).includes("SECOND_MARK"), "terminal content not reset");
  const duplicates = (await termText()).split("SECOND_MARK").length - 1;
  assert(
    duplicates === beforeReconnect.split("SECOND_MARK").length - 1,
    "no duplicated replay: " + duplicates
  );

  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL2"));
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(300);
  const copied2 = await page.evaluate(() => navigator.clipboard.readText());
  assert(copied2.includes("SECOND_MARK"), "copy works after in-page reconnect");

  await page.locator(".pane-term").click();
  await page.keyboard.type("echo STILL_ALIVE=$MYTTY_TOKEN\r");
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows").innerText.includes("STILL_ALIVE=ALIVE"),
    null,
    { timeout: 5000 }
  );

  // 关闭分屏 = 结束会话：旧 id 再连回来必须是新的会话
  const idBeforeClose = (await storedIds())[0];
  await page.locator(".pane-close").first().click();
  await page.waitForSelector(".pane .xterm");
  await page.waitForSelector("#status.ok", { timeout: 8000 });
  const ticket2 = await page.evaluate(async () => {
    const r = await fetch("/api/auth/ticket", { method: "POST" });
    return (await r.json()).ticket;
  });
  const probe = new WebSocket(
    BASE.replace(/^http/, "ws") + `/ws?ticket=${encodeURIComponent(ticket2)}&session=${idBeforeClose}&offset=0`
  );
  probe.binaryType = "arraybuffer";
  const ready = await waitReady(probe);
  assert(ready.session !== idBeforeClose, "closing a pane ends its session");
  probe.send(JSON.stringify({ t: "close" }));
  probe.close();

  assert(errors.length === 0, "console errors: " + errors.join(" | "));
  console.log("session: PASS");
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
