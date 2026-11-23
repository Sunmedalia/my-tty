(() => {
  "use strict";

  const MAX_PANES = 4;

  const workspace = document.getElementById("workspace");
  const addPaneBtn = document.getElementById("add-pane");
  const filesBtn = document.getElementById("toggle-files");
  const filesEl = document.getElementById("files");
  const crumbEl = document.getElementById("crumb");
  const uploadBtn = document.getElementById("files-upload");
  const uploadInput = document.getElementById("upload-input");
  const fileList = document.getElementById("file-list");
  const noticeEl = document.getElementById("notice");
  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");

  const editorOverlay = document.getElementById("editor-overlay");
  const editorEl = document.getElementById("editor");
  const editorPathEl = document.getElementById("editor-path");
  const editorStateEl = document.getElementById("editor-state");
  const editorSaveBtn = document.getElementById("editor-save");
  const editorCloseBtn = document.getElementById("editor-close");
  const logoutBtn = document.getElementById("logout");
  const loginOverlay = document.getElementById("login-overlay");
  const loginForm = document.getElementById("login-form");
  const loginPassword = document.getElementById("login-password");
  const loginError = document.getElementById("login-error");
  const loginSubmit = document.getElementById("login-submit");
  const findBar = document.getElementById("find-bar");
  const findInput = document.getElementById("find-input");
  const findCount = document.getElementById("find-count");
  const interruptBtn = document.getElementById("send-interrupt");
  const fontDecBtn = document.getElementById("font-dec");
  const fontIncBtn = document.getElementById("font-inc");
  const keysBar = document.getElementById("keys");
  const uploadProgress = document.getElementById("upload-progress");
  const uprogFill = document.getElementById("uprog-fill");
  const uprogText = document.getElementById("uprog-text");
  const uprogCancel = document.getElementById("uprog-cancel");
  const editorGutter = document.getElementById("editor-gutter");

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = `${scheme}//${location.host}/ws`;

  const panes = [];
  let activePane = null;
  let currentDir = "";
  let editing = null; // { path, dirty }
  let started = false;
  let fontsize = clampFont(parseInt(localStorage.getItem("myttty.fontsize") || "14", 10) || 14);
  let splitX = parseFloat(localStorage.getItem("myttty.splitX") || "0.5") || 0.5;
  let splitY = parseFloat(localStorage.getItem("myttty.splitY") || "0.5") || 0.5;
  let uploader = null; // { xhr, id, cancelled }

  function clampFont(n) {
    return Math.min(24, Math.max(10, n));
  }

  // ---------------------------------------------------------------- terminals

  function createPane(initialSession = "") {
    if (panes.length >= MAX_PANES) return;

    const el = document.createElement("section");
    el.className = "pane";
    el.innerHTML = `
      <div class="pane-bar">
        <span class="pane-dot"></span>
        <span class="pane-status">连接中…</span>
        <button class="pane-max" type="button" title="最大化 / 还原">⤢</button>
        <button class="pane-close" type="button" title="关闭此分屏">✕</button>
      </div>
      <div class="pane-term"></div>`;
    workspace.appendChild(el);

    const termEl = el.querySelector(".pane-term");
    const bar = el.querySelector(".pane-bar");
    const status = el.querySelector(".pane-status");
    const dot = el.querySelector(".pane-dot");

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: fontsize,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: terminalTheme,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(termEl);

    // xterm 6.0 的去重条件：composed 的 insertText 只要内部的 _keyDownSeen 为真
    // 就会被当成重复事件丢掉。Safari，以及部分输入法（例如中文输入法的英文模式）
    // 会出现字符的 input 早于自己的 keydown，或 keydown 直接是 229，结果字符被吞。
    // 在 beforeinput 阶段清掉标记，让 xterm 自己的 input 路径把它发出去；正常按键
    // 已经被 xterm preventDefault，不会产生 input 事件，所以不会重复发送。
    const helperTextarea = term.textarea;
    if (helperTextarea && term._core) {
      helperTextarea.addEventListener("beforeinput", (event) => {
        if (!event.composed || !event.data) return;
        if (event.inputType !== "insertText" || event.isComposing) return;
        term._core._keyDownSeen = false;
      });
    }

    const pane = {
      el,
      termEl,
      term,
      fit,
      search,
      bar,
      status,
      dot,
      sessionId: initialSession,
      offset: 0,
      ws: null,
      alive: false,
      reconnect: null,
    };
    panes.push(pane);

    term.attachCustomKeyEventHandler((event) => handleTermKey(event, pane));
    term.onData((data) => sendInput(pane, data));
    term.onResize(() => sendResize(pane));

    el.addEventListener("mousedown", () => focusPane(pane));
    termEl.addEventListener("focusin", () => focusPane(pane));
    el.querySelector(".pane-close").addEventListener("click", (ev) => {
      ev.stopPropagation();
      removePane(pane);
    });
    el.querySelector(".pane-max").addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleMaximize(pane);
    });
    status.addEventListener("click", () => {
      if (!pane.alive && pane.reconnect) pane.reconnect();
    });

    connectPane(pane);
    layout();
    focusPane(pane);
  }

  function focusPane(pane) {
    activePane = pane;
    for (const p of panes) p.el.classList.toggle("active", p === pane);
    if (pane) pane.term.focus();
  }

  function removePane(pane, respawn = true) {
    const idx = panes.indexOf(pane);
    if (idx === -1) return;
    if (pane.ws) {
      // 显式关闭分屏 = 结束这个会话；页面刷新/断网不会发这条消息。
      try {
        if (pane.ws.readyState === WebSocket.OPEN) {
          pane.ws.send(JSON.stringify({ t: "close" }));
        }
      } catch (_) {}
      try {
        pane.ws.close();
      } catch (_) {}
      pane.ws = null;
    }
    pane.term.dispose();
    pane.el.remove();
    panes.splice(idx, 1);
    if (activePane === pane) {
      activePane = panes[Math.min(idx, panes.length - 1)] || null;
      if (activePane) focusPane(activePane);
    }
    pane.sessionId = "";
    saveSessions();
    if (panes.length === 0) {
      if (respawn && started) createPane();
    } else {
      layout();
    }
  }

  function saveSessions() {
    try {
      sessionStorage.setItem(
        "myttty.sessions",
        JSON.stringify(panes.map((p) => p.sessionId || ""))
      );
    } catch (_) {}
  }

  async function connectPane(pane) {
    setPaneStatus(pane, "连接中…", "pending");

    let ticket = "";
    try {
      const res = await fetch("/api/auth/ticket", { method: "POST" });
      if (!res.ok) {
        if (res.status === 401) showLogin("登录已失效，请重新登录");
        setPaneStatus(pane, "认证失败（点击重试）", "error");
        pane.reconnect = () => connectPane(pane);
        return;
      }
      ticket = (await res.json()).ticket || "";
    } catch (err) {
      setPaneStatus(pane, "无法获取连接票据", "error");
      pane.reconnect = () => connectPane(pane);
      return;
    }

    let url = `${wsBase}?ticket=${encodeURIComponent(ticket)}&offset=${pane.offset}`;
    if (pane.sessionId) url += `&session=${encodeURIComponent(pane.sessionId)}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      setPaneStatus(pane, "连接失败", "error");
      return;
    }
    ws.binaryType = "arraybuffer";
    pane.ws = ws;
    pane.reconnect = () => connectPane(pane);

    ws.onopen = () => {
      pane.alive = true;
      setPaneStatus(pane, "已连接", "ok");
      fitPane(pane);
      // 点击状态栏重连后把焦点还给终端，否则接下来的按键会落到 body 上。
      focusPane(pane);
      updateSummary();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        const bytes = new Uint8Array(event.data);
        pane.offset += bytes.byteLength;
        pane.term.write(bytes);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (msg.t === "ready") {
        // 服务端会在回放前给出权威起点；换会话（如服务端重启）时重置偏移。
        if (typeof msg.offset === "number") pane.offset = msg.offset;
        if (msg.session && msg.session !== pane.sessionId) {
          const replaced = !!pane.sessionId;
          pane.sessionId = msg.session;
          saveSessions();
          if (replaced) setPaneStatus(pane, "已连接 · 原会话已失效", "pending");
        }
        sendResize(pane);
      } else if (msg.t === "gap") {
        notice(`缓冲区已满，丢弃了 ${msg.lost} 字节历史输出`, true);
      } else if (msg.t === "exit") {
        pane.sessionId = "";
        pane.offset = 0;
        saveSessions();
        setPaneStatus(pane, "Shell 已退出（点击重连）", "error");
      } else if (msg.t === "error") {
        setPaneStatus(
          msg.reason === "too_many_sessions" ? "会话数已满（点击重试）" : "会话异常（点击重连）",
          "error"
        );
      }
    };
    ws.onclose = () => {
      pane.alive = false;
      if (pane.status.textContent === "连接中…" || pane.status.textContent === "已连接") {
        setPaneStatus(pane, "已断开（点击重连）", "error");
      }
      updateSummary();
    };
    ws.onerror = () => {
      if (!pane.alive) setPaneStatus(pane, "连接被拒绝", "error");
    };
  }

  function setPaneStatus(pane, text, kind) {
    pane.status.textContent = text;
    pane.status.className = `pane-status ${kind || ""}`;
    pane.dot.className = `pane-dot ${kind || ""}`;
    // 悬浮标题栏默认隐藏；出错时常驻，方便点击重连/关闭。
    pane.bar.classList.toggle("attention", kind === "error");
    updateSummary();
  }

  function updateSummary() {
    const alive = panes.filter((p) => p.alive).length;
    statusEl.textContent = panes.length === 0 ? "无会话" : `${alive}/${panes.length} 已连接`;
    statusEl.className = alive === panes.length && panes.length > 0 ? "ok" : panes.length ? "pending" : "";
  }

  function sendInput(pane, data) {
    if (ctrlSticky && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      ctrlSticky = false;
      if (keysBar) keysBar.querySelector('[data-key="ctrl"]').classList.remove("active");
    }
    const ws = pane.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(data);
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      ws.send(bytes.subarray(i, i + CHUNK));
    }
  }

  function sendResize(pane) {
    const ws = pane.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "resize", cols: pane.term.cols, rows: pane.term.rows }));
  }

  function fitPane(pane) {
    try {
      pane.fit.fit();
    } catch (_) {
      return;
    }

    // DOM renderer 的单元格高度会取整：fit() 偶尔会多算 1 行，导致最后一行
    // 被容器裁掉。这里用真实布局尺寸校验一次，放不下就收缩。
    const host = pane.term.element;
    const screen = host && host.querySelector(".xterm-screen");
    if (host && screen) {
      // 裁切发生在 .pane-term（overflow:hidden）的边框盒，按它的尺寸判断。
      const box = pane.termEl.getBoundingClientRect();
      for (let i = 0; i < 4; i++) {
        const sr = screen.getBoundingClientRect();
        const tooWide = sr.right > box.right + 0.5;
        const tooTall = sr.bottom > box.bottom + 0.5;
        if (!tooWide && !tooTall) break;
        const cols = tooWide ? Math.max(2, pane.term.cols - 1) : pane.term.cols;
        const rows = tooTall ? Math.max(1, pane.term.rows - 1) : pane.term.rows;
        if (cols === pane.term.cols && rows === pane.term.rows) break;
        pane.term.resize(cols, rows);
      }
    }

    sendResize(pane);
  }

  const splitters = { v: null, h: null };

  function ensureSplitters() {
    if (!splitters.v) {
      const v = document.createElement("div");
      v.className = "splitter v";
      v.addEventListener("pointerdown", (ev) => startSplitDrag(ev, "x"));
      workspace.appendChild(v);
      splitters.v = v;
    }
    if (!splitters.h) {
      const h = document.createElement("div");
      h.className = "splitter h";
      h.addEventListener("pointerdown", (ev) => startSplitDrag(ev, "y"));
      workspace.appendChild(h);
      splitters.h = h;
    }
  }

  function clampSplit(v) {
    return Math.min(0.85, Math.max(0.15, v));
  }

  function startSplitDrag(ev, axis) {
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");

    const move = (e) => {
      const r = workspace.getBoundingClientRect();
      if (axis === "x") {
        splitX = clampSplit((e.clientX - r.left) / r.width);
        localStorage.setItem("myttty.splitX", String(splitX));
      } else {
        splitY = clampSplit((e.clientY - r.top) / r.height);
        localStorage.setItem("myttty.splitY", String(splitY));
      }
      applyGrid();
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function positionSplitters() {
    const n = panes.length;
    if (splitters.v) {
      splitters.v.hidden = n < 2;
      splitters.v.style.left = `${splitX * 100}%`;
    }
    if (splitters.h) {
      splitters.h.hidden = n !== 4;
      splitters.h.style.top = `${splitY * 100}%`;
    }
  }

  function applyGrid() {
    const n = panes.length;
    for (const p of panes) p.el.style.gridArea = "";

    const cols = n >= 2 ? `${splitX}fr ${1 - splitX}fr` : "1fr";
    if (n === 3) {
      workspace.style.gridTemplateColumns = cols;
      workspace.style.gridTemplateRows = "1fr 1fr";
      panes[0].el.style.gridArea = "1 / 1 / span 2 / span 1";
    } else if (n === 4) {
      workspace.style.gridTemplateColumns = cols;
      workspace.style.gridTemplateRows = `${splitY}fr ${1 - splitY}fr`;
    } else if (n === 2) {
      workspace.style.gridTemplateColumns = cols;
      workspace.style.gridTemplateRows = "1fr";
    } else {
      workspace.style.gridTemplateColumns = "1fr";
      workspace.style.gridTemplateRows = "1fr";
    }

    positionSplitters();
    requestAnimationFrame(() => {
      for (const p of panes) fitPane(p);
    });
  }

  function layout() {
    workspace.dataset.count = String(panes.length);
    ensureSplitters();
    applyGrid();
    addPaneBtn.disabled = panes.length >= MAX_PANES;
    updateSummary();
  }

  // xterm 的 attachCustomKeyEventHandler 返回 false 只是让 xterm 不再处理，
  // 不会阻止浏览器默认行为。Ctrl+Shift+C 在 Chrome/Edge 里是 DevTools 的
  // “检查元素”，所以必须自己 preventDefault，否则快捷键照样被浏览器截走。
  function consumeKey(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  // 复制/粘贴只处理 Ctrl（Linux/Windows）：
  //   Ctrl+C  有选区 → 复制；没有选区 → 原样交给 shell（SIGINT）
  //   Ctrl+Insert / Ctrl+Shift+C → 复制（后者挡掉 Chrome 的 DevTools 快捷键）
  //   Ctrl+V / Ctrl+Shift+V / Shift+Insert → 不拦，交给浏览器原生 paste 事件，
  //   xterm 自己处理 bracketed paste，也不需要 clipboard-read 权限。
  // macOS 的 Cmd+C / Cmd+V 不在这里处理：xterm 本来就不会拦截它们，浏览器的
  // 原生 copy/paste 事件会照常触发，由 xterm 自己完成复制和粘贴。
  function handleTermKey(event, pane) {
    if (event.type !== "keydown") return true;
    if (event.key === "Escape") {
      if (workspace.classList.contains("maximized")) {
        const max = panes.find((p) => p.el.classList.contains("maximized"));
        if (max) toggleMaximize(max);
        return false;
      }
      if (!findBar.hidden) {
        closeFind();
        return false;
      }
    }

    const explicitCopy =
      (event.ctrlKey && event.shiftKey && event.code === "KeyC") ||
      (event.ctrlKey && !event.shiftKey && event.code === "Insert");
    if (explicitCopy) {
      consumeKey(event);
      copyText(pane.term.getSelection());
      return false;
    }

    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "KeyC") {
      const selection = pane.term.getSelection();
      if (selection) {
        consumeKey(event);
        copyText(selection);
        // 复制后清掉选区：这样下一次 Ctrl+C 就是中断，而不是重复复制。
        pane.term.clearSelection();
        return false;
      }
      // 没有选区：交回 xterm，正常发送 ^C。
      return true;
    }

    if (event.ctrlKey && event.code === "KeyV") return false;
    if (event.shiftKey && !event.ctrlKey && !event.altKey && event.code === "Insert") return false;

    if (event.ctrlKey && event.shiftKey && event.code === "KeyF") {
      consumeKey(event);
      openFind();
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------- files

  async function api(method, action, query, body) {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "text/plain; charset=utf-8";
    const res = await fetch(`/api/fs/${action}${qs}`, { method, headers, body });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (res.status === 401) {
      showLogin("登录已失效，请重新登录");
      throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : name;
  }

  function parentOf(path) {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
  }

  function notice(text, isError) {
    noticeEl.textContent = text || "";
    noticeEl.className = isError ? "error" : "";
    if (text) clearTimeout(notice._t);
    if (text) notice._t = setTimeout(() => (noticeEl.textContent = ""), 4000);
  }

  async function refreshFiles() {
    notice("");
    try {
      const data = await api("GET", "list", { path: currentDir });
      renderCrumbs();
      renderEntries(data.entries || []);
    } catch (err) {
      notice(`列目录失败: ${err.message}`, true);
    }
  }

  function renderCrumbs() {
    crumbEl.innerHTML = "";
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.textContent = "/";
    rootBtn.addEventListener("click", () => {
      currentDir = "";
      refreshFiles();
    });
    crumbEl.appendChild(rootBtn);

    if (!currentDir) return;
    let acc = "";
    for (const part of currentDir.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      const sep = document.createElement("span");
      sep.textContent = "/";
      sep.className = "sep";
      crumbEl.appendChild(sep);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = part;
      const target = acc;
      btn.addEventListener("click", () => {
        currentDir = target;
        refreshFiles();
      });
      crumbEl.appendChild(btn);
    }
  }

  function renderEntries(entries) {
    fileList.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "（空目录）";
      fileList.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = `entry ${entry.kind}`;

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "name";
      nameBtn.textContent = (entry.kind === "directory" ? "▸ " : "· ") + entry.name;
      nameBtn.title = entry.name;
      nameBtn.addEventListener("click", () => {
        if (entry.kind === "directory") {
          currentDir = joinPath(currentDir, entry.name);
          refreshFiles();
        } else {
          openEditor(joinPath(currentDir, entry.name));
        }
      });
      li.appendChild(nameBtn);

      if (entry.kind === "file") {
        const size = document.createElement("span");
        size.className = "size";
        size.textContent = humanSize(entry.size);
        li.appendChild(size);
      }

      const actions = document.createElement("span");
      actions.className = "actions";

      const entryPath = joinPath(currentDir, entry.name);
      if (entry.kind === "file") {
        actions.appendChild(
          smallButton("⤓", "下载", () => downloadFile(entryPath, entry.name))
        );
      } else if (entry.kind === "directory") {
        actions.appendChild(
          smallButton("⤓", "下载目录（tar）", () => downloadArchive(entryPath, entry.name))
        );
      }

      const renameBtn = smallButton("✎", "重命名", async () => {
        const next = prompt("新名字", entry.name);
        if (!next || next === entry.name) return;
        try {
          await api("POST", "rename", {
            from: joinPath(currentDir, entry.name),
            to: joinPath(currentDir, next),
          });
          refreshFiles();
        } catch (err) {
          notice(`重命名失败: ${err.message}`, true);
        }
      });
      actions.appendChild(renameBtn);

      const delBtn = smallButton("✕", "删除", async () => {
        if (!confirm(`删除 ${entry.name}？此操作不可撤销。`)) return;
        try {
          await api("DELETE", "delete", { path: joinPath(currentDir, entry.name) });
          refreshFiles();
        } catch (err) {
          notice(`删除失败: ${err.message}`, true);
        }
      });
      actions.appendChild(delBtn);
      li.appendChild(actions);

      if (entry.kind === "directory") {
        li.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          li.classList.add("drop-target");
        });
        li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
        li.addEventListener("drop", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          li.classList.remove("drop-target");
          if (ev.dataTransfer && ev.dataTransfer.files.length) {
            uploadFiles(ev.dataTransfer.files, joinPath(currentDir, entry.name));
          }
        });
      }

      fileList.appendChild(li);
    }
  }

  function smallButton(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  function humanSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  }

  function downloadFile(path, name) {
    const a = document.createElement("a");
    a.href = `/api/fs/download?path=${encodeURIComponent(path)}`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadArchive(path, name) {
    const a = document.createElement("a");
    a.href = `/api/fs/archive?path=${encodeURIComponent(path)}`;
    a.download = `${name}.tar`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const upload_limit = 64 * 1024 * 1024;
  const upload_chunk = 4 * 1024 * 1024;

  function randomUploadId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function showUploadProgress(show, fraction, text) {
    uploadProgress.hidden = !show;
    if (!show) return;
    uprogFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    uprogText.textContent = text;
  }

  function putChunk(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      uploader = { xhr, cancelled: false, url };
      xhr.open("PUT", url);
      xhr.responseType = "text";
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(ev.loaded);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else if (xhr.status === 401) reject(new Error("unauthorized"));
        else reject(new Error(data.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("network"));
      xhr.onabort = () => reject(new Error("cancelled"));
      xhr.send(blob);
    });
  }

  async function uploadOne(file, targetDir) {
    const path = joinPath(targetDir, file.name);
    const encoded = encodeURIComponent(path);
    const total = file.size;

    if (total === 0) {
      const res = await fetch(`/api/fs/upload?path=${encoded}`, { method: "PUT", body: new Blob([]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    }

    const id = randomUploadId();
    let offset = 0;
    let retries = 0;

    while (offset < total) {
      const end = Math.min(offset + upload_chunk, total);
      const blob = file.slice(offset, end);
      const url =
        `/api/fs/upload?path=${encoded}&id=${id}&offset=${offset}&total=${total}`;
      try {
        const data = await putChunk(url, blob, (loaded) => {
          showUploadProgress(
            true,
            (offset + loaded) / total,
            `${file.name} ${Math.round(((offset + loaded) / total) * 100)}%`
          );
        });
        offset = typeof data.offset === "number" ? data.offset : end;
        retries = 0;
      } catch (err) {
        if (uploader && uploader.cancelled) throw err;
        if (err.message === "unauthorized") {
          showLogin("登录已失效，请重新登录");
          throw err;
        }
        retries++;
        if (retries > 3) throw err;
        // 断点续传：向服务端确认已经写入的偏移量。
        try {
          const res = await fetch(`/api/fs/upload?path=${encoded}&id=${id}`, { method: "GET" });
          if (res.ok) {
            const data = await res.json();
            offset = data.offset || 0;
          }
        } catch (_) {}
      }
    }
  }

  async function uploadFiles(fileList, targetDir = currentDir) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    let done = 0;
    let failed = 0;
    showUploadProgress(true, 0, "准备上传…");

    for (const file of files) {
      if (file.size > upload_limit) {
        failed++;
        notice(`${file.name} 超过 64 MiB 上限`, true);
        continue;
      }
      try {
        await uploadOne(file, targetDir);
        done++;
      } catch (err) {
        failed++;
        if (err.message !== "cancelled") {
          notice(`上传 ${file.name} 失败: ${err.message}`, true);
        }
        if (uploader && uploader.cancelled) break;
      }
    }

    showUploadProgress(false, 0, "");
    uploader = null;
    if (failed === 0) notice(`已上传 ${done} 个文件`);
    else if (done > 0) notice(`上传完成 ${done} 个，失败 ${failed} 个`, true);
    refreshFiles();
  }

  async function newFile() {
    const name = prompt("新文件名");
    if (!name) return;
    const path = joinPath(currentDir, name);
    try {
      await api("PUT", "write", { path }, "");
      await refreshFiles();
      openEditor(path);
    } catch (err) {
      notice(`新建失败: ${err.message}`, true);
    }
  }

  async function newDir() {
    const name = prompt("新目录名");
    if (!name) return;
    try {
      await api("POST", "mkdir", { path: joinPath(currentDir, name) });
      refreshFiles();
    } catch (err) {
      notice(`新建目录失败: ${err.message}`, true);
    }
  }

  // ------------------------------------------------------------------- editor

  async function openEditor(path) {
    if (editing && editing.dirty && editing.path !== path) {
      if (!confirm("当前文件有未保存的修改，确定切换？")) return;
    }
    try {
      const data = await api("GET", "read", { path });
      editing = { path, dirty: false };
      editorPathEl.textContent = path;
      editorEl.value = data.content;
      editorStateEl.textContent = `${data.size} 字节 · 未修改`;
      editorOverlay.hidden = false;
      updateGutter();
      editorEl.focus();
      editorEl.setSelectionRange(0, 0);
    } catch (err) {
      notice(`打开失败: ${err.message}`, true);
    }
  }

  function closeEditor() {
    if (editing && editing.dirty && !confirm("有未保存的修改，确定关闭？")) return;
    editing = null;
    editorOverlay.hidden = true;
  }

  async function saveEditor() {
    if (!editing) return;
    try {
      const res = await api("PUT", "write", { path: editing.path }, editorEl.value);
      editing.dirty = false;
      editorStateEl.textContent = `${res.size} 字节 · 已保存`;
      notice(`已保存 ${editing.path}`);
      refreshFiles();
    } catch (err) {
      editorStateEl.textContent = `保存失败: ${err.message}`;
      notice(`保存失败: ${err.message}`, true);
    }
  }

  editorEl.addEventListener("input", () => {
    if (!editing) return;
    editing.dirty = true;
    editorStateEl.textContent = "未保存的修改";
    updateGutter();
  });
  editorEl.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      saveEditor();
    }
  });
  editorSaveBtn.addEventListener("click", saveEditor);
  editorCloseBtn.addEventListener("click", closeEditor);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !editorOverlay.hidden) {
      ev.preventDefault();
      closeEditor();
    }
  });

  // -------------------------------------------------------------------- boot

  addPaneBtn.addEventListener("click", () => createPane());

  findInput.addEventListener("input", () => runFind(false, true));
  findInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runFind(ev.shiftKey, false);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeFind();
    }
  });
  document.getElementById("find-prev").addEventListener("click", () => runFind(true, false));
  document.getElementById("find-next").addEventListener("click", () => runFind(false, false));
  document.getElementById("find-close").addEventListener("click", closeFind);

  interruptBtn.addEventListener("click", () => sendKey("ctrlc"));
  fontDecBtn.addEventListener("click", () => setFontSize(fontsize - 1));
  fontIncBtn.addEventListener("click", () => setFontSize(fontsize + 1));

  keysBar.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-key]");
    if (btn) sendKey(btn.dataset.key);
  });

  window.addEventListener("keydown", (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.shiftKey && (ev.key === "+" || ev.key === "=" || ev.code === "Equal")) {
      ev.preventDefault();
      setFontSize(fontsize + 1);
      return;
    }
    if (mod && ev.shiftKey && (ev.key === "-" || ev.key === "_" || ev.code === "Minus")) {
      ev.preventDefault();
      setFontSize(fontsize - 1);
      return;
    }
    if (ev.key === "F3") {
      ev.preventDefault();
      if (findBar.hidden) openFind();
      else runFind(ev.shiftKey, false);
      return;
    }
    if (ev.key === "Escape") {
      if (!editorOverlay.hidden) return; // 编辑器自己处理
      if (workspace.classList.contains("maximized")) {
        ev.preventDefault();
        const max = panes.find((p) => p.el.classList.contains("maximized"));
        if (max) toggleMaximize(max);
        return;
      }
      if (!findBar.hidden) {
        ev.preventDefault();
        closeFind();
      }
    }
  });
  filesBtn.addEventListener("click", () => {
    filesEl.hidden = !filesEl.hidden;
    if (!filesEl.hidden) {
      refreshFiles();
      requestAnimationFrame(() => panes.forEach(fitPane));
    }
  });
  document.getElementById("files-refresh").addEventListener("click", refreshFiles);
  document.getElementById("files-new-file").addEventListener("click", newFile);
  document.getElementById("files-new-dir").addEventListener("click", newDir);

  uploadBtn.addEventListener("click", () => uploadInput.click());
  uprogCancel.addEventListener("click", () => {
    if (!uploader) return;
    uploader.cancelled = true;
    try {
      uploader.xhr.abort();
    } catch (_) {}
    fetch(uploader.url.replace(/&offset=.*$/, "").replace(/&total=.*$/, ""), { method: "DELETE" }).catch(() => {});
  });
  uploadInput.addEventListener("change", () => {
    uploadFiles(uploadInput.files);
    uploadInput.value = "";
  });
  filesEl.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    filesEl.classList.add("drop");
  });
  filesEl.addEventListener("dragleave", () => filesEl.classList.remove("drop"));
  filesEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    filesEl.classList.remove("drop");
    if (ev.dataTransfer && ev.dataTransfer.files.length) uploadFiles(ev.dataTransfer.files);
  });

  let resizeQueued = false;
  const ro = new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      for (const p of panes) fitPane(p);
    });
  });
  ro.observe(workspace);

  window.addEventListener("resize", () => panes.forEach(fitPane));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => panes.forEach(fitPane));
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) panes.forEach(fitPane);
  });

  if (window.matchMedia && window.matchMedia("(max-width: 820px)").matches) {
    hintEl.textContent = "";
    filesEl.hidden = true;
  }

  // 低饱和配色：与页面外壳共用同一组中性色，避免终端里突然跳出高饱和色块。
  const terminalTheme = {
    background: "#101319",
    foreground: "#c8cdd8",
    cursor: "#8ea3c0",
    cursorAccent: "#101319",
    selectionBackground: "#2b3444",
    black: "#191d25",
    red: "#c18d92",
    green: "#9fb392",
    yellow: "#c2b18c",
    blue: "#8ba1bf",
    magenta: "#b09eb4",
    cyan: "#8fafb2",
    white: "#c2c7d1",
    brightBlack: "#4a5262",
    brightRed: "#d0a0a5",
    brightGreen: "#b2c5a6",
    brightYellow: "#d3c39f",
    brightBlue: "#a3b7d1",
    brightMagenta: "#c2b1c5",
    brightCyan: "#a2c0c2",
    brightWhite: "#e0e4ec",
  };

  // ------------------------------------------------------------ 搜索/字号

  function openFind() {
    if (!activePane) return;
    findBar.hidden = false;
    findCount.textContent = "";
    findInput.focus();
    findInput.select();
  }

  function closeFind() {
    findBar.hidden = true;
    findCount.textContent = "";
    for (const p of panes) {
      p.search.clearDecorations();
      p.term.clearSelection();
    }
    if (activePane) activePane.term.focus();
    requestAnimationFrame(() => panes.forEach(fitPane));
  }

  function runFind(backwards, incremental) {
    const pane = activePane;
    if (!pane) return;
    const query = findInput.value;
    if (!query) {
      pane.search.clearDecorations();
      pane.term.clearSelection();
      findCount.textContent = "";
      return;
    }
    const options = { caseSensitive: false, incremental };
    let found = backwards
      ? pane.search.findPrevious(query, options)
      : pane.search.findNext(query, options);
    if (!found && incremental) {
      // 输入时是增量查找（从上次结果继续）；没找到就从缓冲区头/尾再兜底一次，
      // 否则光标后方的历史输出会看起来像“没有结果”。
      const wrap = { caseSensitive: false };
      found = backwards
        ? pane.search.findPrevious(query, wrap)
        : pane.search.findNext(query, wrap);
    }
    findCount.textContent = found ? "" : incremental ? "" : "无结果";
  }

  function setFontSize(next) {
    fontsize = clampFont(next);
    localStorage.setItem("myttty.fontsize", String(fontsize));
    for (const p of panes) {
      p.term.options.fontSize = fontsize;
      fitPane(p);
    }
  }

  function toggleMaximize(pane) {
    const isMax = pane.el.classList.contains("maximized");
    for (const p of panes) p.el.classList.remove("maximized");
    if (isMax) {
      workspace.classList.remove("maximized");
    } else {
      pane.el.classList.add("maximized");
      workspace.classList.add("maximized");
      focusPane(pane);
    }
    requestAnimationFrame(() => panes.forEach(fitPane));
  }

  // --------------------------------------------------------- 剪贴板兜底

  function copyText(text) {
    if (!text) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    legacyCopy(text);
    return Promise.resolve();
  }

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    ta.remove();
  }

  // ---------------------------------------------------------- 移动按键条

  let ctrlSticky = false;

  const keySequences = {
    esc: "\x1b",
    tab: "\t",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    ctrlc: "\x03",
    ctrld: "\x04",
    ctrll: "\x0c",
  };

  function sendKey(name) {
    const pane = activePane;
    if (!pane) return;
    if (name === "ctrl") {
      ctrlSticky = !ctrlSticky;
      keysBar.querySelector('[data-key="ctrl"]').classList.toggle("active", ctrlSticky);
      pane.term.focus();
      return;
    }
    const seq = keySequences[name];
    if (seq == null) return;
    sendInput(pane, seq);
    if (ctrlSticky) {
      ctrlSticky = false;
      keysBar.querySelector('[data-key="ctrl"]').classList.remove("active");
    }
    pane.term.focus();
  }

  // ------------------------------------------------------------- 编辑辅助

  function updateGutter() {
    const value = editorEl.value;
    let count = value.split("\n").length;
    if (value.endsWith("\n")) count -= 1;
    count = Math.max(1, count);
    let text = "";
    for (let i = 1; i <= count; i++) text += i + "\n";
    editorGutter.textContent = text;
    editorGutter.scrollTop = editorEl.scrollTop;
  }

  editorEl.addEventListener("scroll", () => {
    editorGutter.scrollTop = editorEl.scrollTop;
  });
  editorEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      editorEl.setRangeText("  ", start, end, "end");
      editorEl.dispatchEvent(new Event("input"));
    }
  });
  window.addEventListener("beforeunload", (ev) => {
    if (editing && editing.dirty) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  // -------------------------------------------------------------- 弹窗

  // ------------------------------------------------------------- 登录状态

  function showLogin(message) {
    loginOverlay.hidden = false;
    loginError.textContent = message || "";
    loginPassword.value = "";
    setTimeout(() => loginPassword.focus(), 30);
  }

  function hideLogin() {
    loginOverlay.hidden = true;
    loginError.textContent = "";
  }

  async function startApp() {
    hideLogin();
    if (started) return;
    started = true;
    // 终端字体必须在创建 Terminal 之前就绪，否则 xterm 会按回退字体算字宽，
    // 之后字体加载完也不会重算 letter-spacing，方框/方块字符会出现缝隙。
    try {
      await document.fonts.load('14px "JetBrains Mono"');
      await document.fonts.ready;
    } catch (_) {}
    if (panes.length === 0) {
      let restored = 0;
      try {
        const saved = JSON.parse(sessionStorage.getItem("myttty.sessions") || "[]");
        if (Array.isArray(saved)) {
          for (const sid of saved.slice(0, MAX_PANES)) {
            if (typeof sid === "string" && /^[0-9a-f]{32}$/.test(sid)) {
              createPane(sid);
              restored += 1;
            }
          }
        }
      } catch (_) {}
      if (restored === 0) createPane();
    } else {
      layout();
    }
    refreshFiles();
  }

  function stopApp() {
    started = false;
    for (const pane of [...panes]) removePane(pane, false);
    panes.length = 0;
    try {
      sessionStorage.removeItem("myttty.sessions");
    } catch (_) {}
  }

  async function refreshAuth() {
    try {
      // 状态接口本身也要求认证：401 就是“未登录”。
      const res = await fetch("/api/auth/status");
      if (res.ok) startApp();
      else if (res.status === 401) showLogin();
      else showLogin(`服务端错误（HTTP ${res.status}）`);
    } catch (_) {
      showLogin("无法连接服务端");
    }
  }

  loginForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const password = loginPassword.value;
    if (!password) return;
    loginSubmit.disabled = true;
    loginError.textContent = "";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        loginError.textContent =
          res.status === 401 ? "密码不正确" : `登录失败（HTTP ${res.status}）`;
        loginPassword.select();
        return;
      }
      loginPassword.value = "";
      startApp();
    } catch (_) {
      loginError.textContent = "网络错误，请重试";
    } finally {
      loginSubmit.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (_) {}
    logoutBtn.disabled = false;
    stopApp();
    showLogin("已注销");
  });

  refreshAuth();
})();
