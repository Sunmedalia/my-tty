(() => {
  "use strict";

  const MAX_PANES = 4;

  const workspace = document.getElementById("workspace");
  const addPaneBtn = document.getElementById("add-pane");
  const filesBtn = document.getElementById("toggle-files");
  const filesEl = document.getElementById("files");
  const crumbEl = document.getElementById("crumb");
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

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = `${scheme}//${location.host}/ws`;

  const panes = [];
  let activePane = null;
  let currentDir = "";
  let editing = null; // { path, dirty }
  let started = false;

  // ---------------------------------------------------------------- terminals

  function createPane() {
    if (panes.length >= MAX_PANES) return;

    const el = document.createElement("section");
    el.className = "pane";
    el.innerHTML = `
      <div class="pane-bar">
        <span class="pane-dot"></span>
        <span class="pane-status">连接中…</span>
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
      fontSize: 14,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: terminalTheme,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);

    const pane = { el, termEl, term, fit, bar, status, dot, ws: null, alive: false, reconnect: null };
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
    if (panes.length === 0) {
      if (respawn && started) createPane();
    } else {
      layout();
    }
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

    let ws;
    try {
      ws = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
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
      updateSummary();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        pane.term.write(new Uint8Array(event.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (msg.t === "exit") {
        setPaneStatus(pane, "Shell 已退出（点击重连）", "error");
      } else if (msg.t === "error") {
        setPaneStatus(pane, "会话异常（点击重连）", "error");
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

  function layout() {
    const n = panes.length;
    workspace.dataset.count = String(n);

    for (const p of panes) {
      p.el.style.gridArea = "";
    }

    if (n === 2) {
      workspace.style.gridTemplateColumns = "1fr 1fr";
      workspace.style.gridTemplateRows = "1fr";
    } else if (n === 3) {
      // 左一半整高，右一半上下均分。
      workspace.style.gridTemplateColumns = "1fr 1fr";
      workspace.style.gridTemplateRows = "1fr 1fr";
      panes[0].el.style.gridArea = "1 / 1 / span 2 / span 1";
    } else if (n === 4) {
      workspace.style.gridTemplateColumns = "1fr 1fr";
      workspace.style.gridTemplateRows = "1fr 1fr";
    } else {
      workspace.style.gridTemplateColumns = "1fr";
      workspace.style.gridTemplateRows = "1fr";
    }

    addPaneBtn.disabled = n >= MAX_PANES;
    updateSummary();

    requestAnimationFrame(() => {
      for (const p of panes) fitPane(p);
    });
  }

  // Ctrl/Cmd+Shift+C 复制，Ctrl/Cmd+Shift+V 粘贴；普通 Ctrl+C 照旧发给 shell。
  function handleTermKey(event, pane) {
    if (event.type !== "keydown") return true;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey && event.code === "KeyC") {
      const selection = pane.term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
      return false;
    }
    if (mod && event.shiftKey && event.code === "KeyV") {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) sendInput(pane, text);
        })
        .catch(() => {});
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
    try {
      const data = await api("GET", "read", { path });
      editing = { path, dirty: false };
      editorPathEl.textContent = path;
      editorEl.value = data.content;
      editorStateEl.textContent = `${data.size} 字节 · 未修改`;
      editorOverlay.hidden = false;
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

  addPaneBtn.addEventListener("click", createPane);
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

  const terminalTheme = {
    background: "#0f1115",
    foreground: "#d7dae0",
    cursor: "#7aa2f7",
    selectionBackground: "#33467c",
    black: "#15161a",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  };

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
    if (panes.length === 0) createPane();
    else layout();
    refreshFiles();
  }

  function stopApp() {
    started = false;
    for (const pane of [...panes]) removePane(pane, false);
    panes.length = 0;
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
