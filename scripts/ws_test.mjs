#!/usr/bin/env node
// 认证 + WebSocket 冒烟：先登录取 Cookie，再领一次性票据，连 PTY 执行命令。
// 用法: node ws_test.mjs <http-base> <password> [期望字符串...]

const base = process.argv[2];
const password = process.argv[3];
const expects = process.argv.slice(4);
if (!base || !password) {
  console.error("usage: node ws_test.mjs <http-base> <password> [expect...]");
  process.exit(2);
}
if (expects.length === 0) expects.push("MYTTY_RESULT_OK", "Linux");

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error("login failed:", login.status);
  process.exit(1);
}
const setCookie =
  (login.headers.getSetCookie && login.headers.getSetCookie()[0]) ||
  login.headers.get("set-cookie") ||
  "";
const cookie = setCookie.split(";")[0];

const denied = await fetch(`${base}/api/fs/list?path=`);
if (denied.status !== 401) {
  console.error("expected 401 before auth, got", denied.status);
  process.exit(1);
}

const ticketRes = await fetch(`${base}/api/auth/ticket`, {
  method: "POST",
  headers: { cookie },
});
if (!ticketRes.ok) {
  console.error("ticket failed:", ticketRes.status);
  process.exit(1);
}
const { ticket } = await ticketRes.json();

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`);
ws.binaryType = "arraybuffer";

let output = "";
let settled = false;

const timer = setTimeout(() => {
  console.error("TIMEOUT");
  console.error(output);
  process.exit(1);
}, 8000);

function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    ws.close();
  } catch {}
  process.exit(code);
}

ws.onopen = () => {
  // 用拼接构造标记，避免回显的输入行提前命中期望值。
  const script = "printf 'MYTTY_%s_OK\\n' RESULT; uname -s; tty; exit\r";
  ws.send(new TextEncoder().encode(script));
};

ws.onmessage = (event) => {
  if (typeof event.data === "string") return;
  output += new TextDecoder().decode(event.data);
  maybeDone();
};

ws.onerror = () => {
  // 服务端发 Close 帧后断 TCP，部分 Node 版本会同时报 error；
  // 以已收到的输出为准，没有齐再交给 onclose / 超时判失败。
  maybeDone();
};

ws.onclose = () => maybeDone();

function maybeDone() {
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  for (const needle of expects) {
    if (!plain.includes(needle)) return;
  }
  console.log("ws smoke: PASS");
  finish(0);
}
