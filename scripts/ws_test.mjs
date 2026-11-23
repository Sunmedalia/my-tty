#!/usr/bin/env node
// 最小 WebSocket 冒烟客户端：连上 PTY，执行命令，断言输出。
// 用法: node ws_test.mjs <ws-url> [期望字符串...]

const url = process.argv[2];
const expects = process.argv.slice(3);
if (!url) {
  console.error("usage: node ws_test.mjs <ws-url> [expect...]");
  process.exit(2);
}
if (expects.length === 0) expects.push("MYTTY_RESULT_OK", "Linux");

const ws = new WebSocket(url);
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
