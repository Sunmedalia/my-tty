(() => {
  "use strict";

  const MAX_PANES = 4;
  const MAX_TABS = 8;

  const workspace = document.getElementById("workspace");
  const tabStripEl = document.getElementById("tab-strip");
  const tabListEl = document.getElementById("tab-list");
  const tabMoreBtn = document.getElementById("tab-more");
  const tabMenuEl = document.getElementById("tab-menu");
  const tabAddBtn = document.getElementById("tab-add");
  const addPaneBtn = document.getElementById("add-pane");
  const filesBtn = document.getElementById("toggle-files");
  const filesEl = document.getElementById("files");
  const filesResizeEl = document.getElementById("files-resize");
  const cwdSyncBtn = document.getElementById("files-cwd-sync");
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
  const promptOverlay = document.getElementById("prompt-overlay");
  const promptForm = document.getElementById("prompt-form");
  const promptTitle = document.getElementById("prompt-title");
  const promptInput = document.getElementById("prompt-input");
  const promptError = document.getElementById("prompt-error");
  const promptCancel = document.getElementById("prompt-cancel");
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

  // 触摸设备把可打印字符统一交给浏览器的 input 事件：xterm 的 keydown/keypress
  // 和 input 各发一次，是手机端 ls → llss 的根因。桌面（细指针）完全不受影响。
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  // 每个标签页有自己的 pane 数组；`panes` 始终指向当前标签页的数组。
  const tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  let panes = [];
  let activePane = null;
  let currentDir = "";
  const treeExpanded = new Set([""]);
  const treeChildren = new Map();
  const treeLoading = new Set();
  let treeRootError = false;
  let cwdSyncEnabled = localStorage.getItem("myttty.cwdSync") !== "0";
  let editing = null; // { path, dirty }
  let started = false;
  let fontsize = clampFont(parseInt(localStorage.getItem("myttty.fontsize") || "14", 10) || 14);
  let splitX = parseFloat(localStorage.getItem("myttty.splitX") || "0.5") || 0.5;
  let splitY = parseFloat(localStorage.getItem("myttty.splitY") || "0.5") || 0.5;
  let filesWidth = parseInt(localStorage.getItem("myttty.filesWidth") || "300", 10);
  if (!Number.isFinite(filesWidth)) filesWidth = 300;
  let uploader = null; // { xhr, id, cancelled }

  function clampFont(n) {
    return Math.min(24, Math.max(10, n));
  }

  // ---------------------------------------------------------------- tabs

  function updateTabHint() {
    tabAddBtn.disabled = tabs.length >= MAX_TABS;
  }

  let tabMenuOpen = false;

  function positionTabMenu() {
    if (tabMenuEl.hidden) return;
    const r = tabMoreBtn.getBoundingClientRect();
    tabMenuEl.style.left = `${Math.max(4, Math.round(r.left))}px`;
    tabMenuEl.style.top = `${Math.round(r.bottom + 4)}px`;
  }

  function closeTabMenu() {
    tabMenuEl.hidden = true;
    tabMenuOpen = false;
  }

  function openTabMenu() {
    if (tabMoreBtn.hidden) return;
    tabMenuEl.hidden = false;
    tabMenuOpen = true;
    positionTabMenu();
  }

  function renderTabMenu(collapsedTabs) {
    tabMenuEl.replaceChildren();
    for (const tab of collapsedTabs) {
      const row = document.createElement("div");
      row.className = "menu-tab";

      const label = document.createElement("button");
      label.type = "button";
      label.className = "menu-label";
      label.textContent = tab.label.textContent;
      label.classList.toggle("active", tab === activeTab);
      label.addEventListener("click", () => {
        activateTab(tab);
        closeTabMenu();
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "menu-close";
      close.title = "关闭标签页";
      close.appendChild(iconNode("delete"));
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTab(tab);
        closeTabMenu();
      });

      row.appendChild(label);
      row.appendChild(close);
      tabMenuEl.appendChild(row);
    }
  }

  // 标签栏放不下时，把最旧的标签折叠到左侧的“⋯”菜单里；当前标签始终可见。
  function layoutTabs() {
    const n = tabs.length;
    if (n === 0) {
      tabMoreBtn.hidden = true;
      closeTabMenu();
      return;
    }

    // 先全部展开量一次真实宽度（同步完成，不会绘制到屏幕）。
    for (const tab of tabs) tab.btn.classList.remove("collapsed");
    const widths = tabs.map((tab) => tab.btn.getBoundingClientRect().width);
    const gap = parseFloat(getComputedStyle(tabStripEl).columnGap) || 4;
    const plusW = tabAddBtn.getBoundingClientRect().width;

    tabMoreBtn.hidden = false;
    const moreW = tabMoreBtn.getBoundingClientRect().width;
    const available = tabStripEl.clientWidth - 2;
    const activeIdx = tabs.indexOf(activeTab);

    let visible = null;
    let collapsed = 0;
    for (let suffix = n; suffix >= 0; suffix -= 1) {
      const set = new Set();
      if (activeIdx >= 0) set.add(activeIdx);
      for (let i = Math.max(0, n - suffix); i < n; i += 1) set.add(i);

      collapsed = n - set.size;
      let width = plusW + (collapsed > 0 ? moreW : 0);
      const items = 1 + (collapsed > 0 ? 1 : 0) + set.size;
      for (const i of set) width += widths[i];
      width += gap * Math.max(0, items - 1);

      if (width <= available) {
        visible = set;
        break;
      }
    }

    if (!visible) {
      visible = new Set();
      collapsed = n;
    }

    const collapsedTabs = [];
    for (let i = 0; i < n; i += 1) {
      const show = visible.has(i);
      tabs[i].btn.classList.toggle("collapsed", !show);
      if (!show) collapsedTabs.push(tabs[i]);
    }

    const hasCollapsed = collapsedTabs.length > 0;
    tabMoreBtn.hidden = !hasCollapsed;
    tabMoreBtn.classList.toggle(
      "active",
      activeTab !== null && collapsedTabs.includes(activeTab)
    );
    tabMoreBtn.title = hasCollapsed ? `还有 ${collapsedTabs.length} 个标签页` : "";

    if (!hasCollapsed) {
      closeTabMenu();
      tabMenuEl.replaceChildren();
    } else {
      renderTabMenu(collapsedTabs);
      if (tabMenuOpen) positionTabMenu();
    }
  }

  function addTab() {
    if (tabs.length >= MAX_TABS) return null;

    const el = document.createElement("div");
    el.className = "tab-workspace";
    el.hidden = true;
    workspace.appendChild(el);

    const btn = document.createElement("div");
    btn.className = "tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab-label";
    label.textContent = `终端 ${++tabSeq}`;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.title = "关闭标签页";
    close.appendChild(iconNode("delete"));

    btn.appendChild(label);
    btn.appendChild(close);
    tabListEl.appendChild(btn);

    const tab = { el, btn, label, panes: [], activePane: null, splitX: 0.5, splitY: 0.5 };
    tabs.push(tab);

    btn.addEventListener("click", () => activateTab(tab));
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTab(tab);
    });

    updateTabHint();
    layoutTabs();
    return tab;
  }

  function newTab() {
    const tab = addTab();
    if (!tab) return;
    activateTab(tab);
    createPane("", tab);
  }

  function activateTab(tab) {
    if (!tab || tab === activeTab) return;

    if (activeTab) {
      activeTab.splitX = splitX;
      activeTab.splitY = splitY;
      activeTab.activePane = activePane;
      activeTab.el.hidden = true;
      activeTab.btn.classList.remove("active");
      activeTab.btn.setAttribute("aria-selected", "false");
      if (activePane) activePane.term.blur();
    }

    activeTab = tab;
    panes = tab.panes;
    splitX = tab.splitX;
    splitY = tab.splitY;
    activePane =
      tab.activePane && tab.panes.includes(tab.activePane)
        ? tab.activePane
        : tab.panes[tab.panes.length - 1] || null;

    tab.el.hidden = false;
    tab.btn.classList.add("active");
    tab.btn.setAttribute("aria-selected", "true");
    for (const p of panes) p.el.classList.toggle("active", p === activePane);

    layout(tab);
    layoutTabs();
    updateSummary();
    saveSessions();
    if (cwdSyncEnabled && activePane && activePane.cwd) syncFilesToCwd(activePane.cwd);
    requestAnimationFrame(() => {
      for (const p of tab.panes) fitPane(p);
      if (activePane && !coarsePointer) activePane.term.focus();
    });
  }

  function closeTab(tab) {
    const idx = tabs.indexOf(tab);
    if (idx === -1) return;

    for (const pane of [...tab.panes]) removePane(pane, false);
    tab.el.remove();
    tab.btn.remove();
    tabs.splice(idx, 1);
    if (tabs.length === 0) tabSeq = 0;

    if (activeTab === tab) {
      activeTab = null;
      panes = [];
      activePane = null;
      const next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) activateTab(next);
      else newTab();
    }

    updateTabHint();
    layoutTabs();
    saveSessions();
  }

  // ---------------------------------------------------------------- terminals

  function createPane(initialSession = "", tab = activeTab) {
    if (!tab || tab.panes.length >= MAX_PANES) return;

    const el = document.createElement("section");
    el.className = "pane";
    el.innerHTML = `
      <div class="pane-bar">
        <span class="pane-dot"></span>
        <span class="pane-status">连接中…</span>
        <button class="pane-close" type="button" title="关闭此分屏" aria-label="关闭此分屏"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8"/><path d="M12 4l-8 8"/></svg></button>
      </div>
      <div class="pane-term"></div>`;
    tab.el.appendChild(el);

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

    // xterm 6.0 用 _keyDownSeen 去重：composed 的 insertText 只要该标记为真
    // 就会被忽略。Safari/输入法会出现 keydown 是 229/Process、字符只能靠随后的
    // input 送达；移动端浏览器又可能在 keydown/keypress 已经发出字符后，再派发
    // 一次 composed insertText——无条件清标记会让同一个字符发两遍（ls → llss）。
    //
    // 不猜“哪个键发出了字符”，而是记录 xterm 在键盘事件里实际发出的数据：
    // 只有 input 的数据与刚才键盘路径发出的不一致时，才清标记让 input 补发。
    // term.onData 是所有发送的唯一出口，keydown/keypress/input 都会经过它。
    const helperTextarea = term.textarea;
    if (helperTextarea && term._core) {
      let keyEventActive = false;
      let sentThisKeyEvent = false;
      let lastKeySent = null;
      let lastKeySentAt = 0;
      let swallowInput = false;
      let lastBeforeInputData = null;
      let lastBeforeInputAt = 0;

      term.onData((data) => {
        if (!keyEventActive) return;
        sentThisKeyEvent = true;
        lastKeySent = data;
        lastKeySentAt = performance.now();
      });

      const beginKey = () => {
        keyEventActive = true;
        sentThisKeyEvent = false;
      };
      const endKey = (event) => {
        keyEventActive = false;
        // keydown 已经发过字符时压掉紧随其后的 keypress，避免第二条键盘路径重复。
        if (event.type === "keydown" && sentThisKeyEvent) {
          term._core._keyDownHandled = true;
        }
      };

      const letInputThrough = (event) => {
        if (event.target !== helperTextarea) return;
        if (!event.composed || !event.data) return;
        if (event.inputType !== "insertText" || event.isComposing) return;

        const now = performance.now();

        if (event.type === "beforeinput") {
          lastBeforeInputData = event.data;
          lastBeforeInputAt = now;
        } else if (lastBeforeInputData === event.data && now - lastBeforeInputAt < 100) {
          // 同一个数据已经由 beforeinput 处理过，input 只做兜底，不能重复决定。
          lastBeforeInputData = null;
          return;
        }

        keyEventActive = false;
        const alreadySent =
          lastKeySent !== null &&
          event.data === lastKeySent &&
          now - lastKeySentAt < 500;
        lastKeySent = null;

        if (alreadySent) {
          // 键盘路径已经发过：阻止 input 再发一次。极少数移动浏览器即使取消
          // beforeinput 仍会派发 input，下面的捕获监听会把它挡住。
          if (event.cancelable) event.preventDefault();
          swallowInput = true;
          setTimeout(() => {
            swallowInput = false;
          }, 0);
          return;
        }
        term._core._keyDownSeen = false;
      };

      const swallowIfNeeded = (event) => {
        if (!swallowInput) return;
        swallowInput = false;
        event.stopPropagation();
      };

      termEl.addEventListener("keydown", beginKey, true);
      termEl.addEventListener("keypress", beginKey, true);
      termEl.addEventListener("keydown", endKey);
      termEl.addEventListener("keypress", endKey);
      // beforeinput 是最早的时机；input 捕获阶段始终保留兜底（在 xterm 自己的
      // textarea 监听器之前执行），并用 lastBeforeInputData 避免同一事件处理两次。
      if ("onbeforeinput" in helperTextarea) {
        helperTextarea.addEventListener("beforeinput", letInputThrough);
      }
      termEl.addEventListener("input", letInputThrough, true);
      termEl.addEventListener("input", swallowIfNeeded, true);

      // 排查用：URL 加 ?debug-input=1 时把原始事件打到控制台，默认不输出。
      if (new URLSearchParams(location.search).has("debug-input")) {
        const types = [
          "keydown",
          "keypress",
          "beforeinput",
          "input",
          "compositionstart",
          "compositionend",
        ];
        for (const type of types) {
          helperTextarea.addEventListener(
            type,
            (event) => {
              console.log("[my-tty input]", type, {
                key: event.key,
                code: event.code,
                keyCode: event.keyCode,
                charCode: event.charCode,
                data: event.data,
                inputType: event.inputType,
                composed: event.composed,
                isComposing: event.isComposing,
              });
            },
            true
          );
        }
      }
    }

    const pane = {
      el,
      tab,
      termEl,
      term,
      fit,
      search,
      bar,
      status,
      dot,
      sessionId: initialSession,
      offset: 0,
      cwd: null,
      ws: null,
      alive: false,
      reconnect: null,
    };
    tab.panes.push(pane);
    tab.activePane = pane;
    if (tab === activeTab) panes = tab.panes;

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
    layout(tab);
    if (tab === activeTab) focusPane(pane);
    saveSessions();
  }

  function focusPane(pane) {
    if (!pane) return;
    if (pane.tab && pane.tab !== activeTab) activateTab(pane.tab);
    activePane = pane;
    if (pane.tab) pane.tab.activePane = pane;
    for (const p of panes) p.el.classList.toggle("active", p === pane);
    if (cwdSyncEnabled && pane.cwd) syncFilesToCwd(pane.cwd);
    pane.term.focus();
  }

  function removePane(pane, respawn = true) {
    const tab = pane.tab;
    const list = tab ? tab.panes : panes;
    const idx = list.indexOf(pane);
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
    list.splice(idx, 1);

    if (tab && tab.activePane === pane) tab.activePane = null;
    if (tab === activeTab && activePane === pane) {
      activePane = list[Math.min(idx, list.length - 1)] || null;
      if (tab) tab.activePane = activePane;
      if (activePane) focusPane(activePane);
      else for (const p of panes) p.el.classList.remove("active");
    }

    pane.sessionId = "";
    saveSessions();
    if (list.length === 0) {
      if (respawn && started && tab) createPane("", tab);
    } else if (tab === activeTab) {
      layout(tab);
    }
    if (tab === activeTab) updateSummary();
  }

  function saveSessions() {
    try {
      sessionStorage.setItem(
        "myttty.tabs",
        JSON.stringify({
          active: Math.max(0, tabs.indexOf(activeTab)),
          tabs: tabs.map((t) => ({
            x: t.splitX,
            y: t.splitY,
            s: t.panes.map((p) => p.sessionId || ""),
          })),
        })
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

    // pane 可能在等待 ticket 时被关闭，或所在标签页被删掉。
    if (!pane.el.isConnected) return;

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
      // 点击状态栏重连后把焦点还给终端，否则接下来的按键会落到 body 上；
      // 后台标签页连上时不能把用户切走。
      if (pane.tab === activeTab) focusPane(pane);
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
      } else if (msg.t === "cwd") {
        if (typeof msg.path === "string") {
          pane.cwd = msg.path;
          if (cwdSyncEnabled && pane === activePane) syncFilesToCwd(msg.path);
        }
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
    if (pane.tab) {
      pane.tab.btn.classList.toggle(
        "down",
        pane.tab.panes.some((p) => p.status.classList.contains("error"))
      );
    }
    updateSummary();
  }

  function updateSummary() {
    const total = panes.length;
    const alive = panes.filter((p) => p.alive).length;
    // 全部正常时只显示“已连接”；只有分屏掉线时才显示 alive/total，
    // 避免出现 1/1、2/2 这种没有信息量的分数。
    statusEl.textContent =
      total === 0 ? "无会话" : alive === total ? "已连接" : `${alive}/${total} 已连接`;
    statusEl.title = statusEl.textContent;
    statusEl.className = alive === total && total > 0 ? "ok" : total ? "pending" : "";
  }

  function requestCwd(pane) {
    const ws = pane.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ t: "cwd" }));
    } catch (_) {}
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
    // 用户执行完一条命令（回车）后主动对一次 cwd：pwd/cd 都能立刻同步文件树，
    // 不需要等服务端 500ms 的轮询。
    if (data.includes("\r") || data.includes("\n")) {
      setTimeout(() => requestCwd(pane), 100);
    }
  }

  function sendResize(pane) {
    const ws = pane.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "resize", cols: pane.term.cols, rows: pane.term.rows }));
  }

  function fitPane(pane) {
    // 后台标签页 / 被隐藏的 pane 量不到尺寸，强行 fit 会把终端缩成 2x1。
    if (!pane.el.isConnected || pane.el.offsetParent === null) return;
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
      v.hidden = true;
      v.addEventListener("pointerdown", (ev) => startSplitDrag(ev, "x"));
      workspace.appendChild(v);
      splitters.v = v;
    }
    if (!splitters.h) {
      const h = document.createElement("div");
      h.className = "splitter h";
      h.hidden = true;
      h.addEventListener("pointerdown", (ev) => startSplitDrag(ev, "y"));
      workspace.appendChild(h);
      splitters.h = h;
    }
  }

  function clampSplit(v) {
    return Math.min(0.85, Math.max(0.15, v));
  }

  function startSplitDrag(ev, axis) {
    if (!activeTab) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");

    const move = (e) => {
      const r = workspace.getBoundingClientRect();
      if (axis === "x") {
        splitX = clampSplit((e.clientX - r.left) / r.width);
        activeTab.splitX = splitX;
        localStorage.setItem("myttty.splitX", String(splitX));
      } else {
        splitY = clampSplit((e.clientY - r.top) / r.height);
        activeTab.splitY = splitY;
        localStorage.setItem("myttty.splitY", String(splitY));
      }
      applyGrid(activeTab);
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      saveSessions();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function positionSplitters(tab) {
    const n = tab.panes.length;
    if (splitters.v) {
      splitters.v.hidden = n < 2;
      splitters.v.style.left = `${tab.splitX * 100}%`;
    }
    if (splitters.h) {
      // 3 屏时只有右列上下分，横把手从竖直分栏处开始，避免切到左边整高的 pane。
      splitters.h.hidden = n < 3;
      splitters.h.style.top = `${tab.splitY * 100}%`;
      splitters.h.style.left = n === 3 ? `${tab.splitX * 100}%` : "0";
    }
  }

  function applyGrid(tab) {
    const n = tab.panes.length;
    for (const p of tab.panes) p.el.style.gridArea = "";

    const cols = n >= 2 ? `${tab.splitX}fr ${1 - tab.splitX}fr` : "1fr";
    if (n === 3) {
      tab.el.style.gridTemplateColumns = cols;
      tab.el.style.gridTemplateRows = `${tab.splitY}fr ${1 - tab.splitY}fr`;
      tab.panes[0].el.style.gridArea = "1 / 1 / span 2 / span 1";
    } else if (n === 4) {
      tab.el.style.gridTemplateColumns = cols;
      tab.el.style.gridTemplateRows = `${tab.splitY}fr ${1 - tab.splitY}fr`;
    } else if (n === 2) {
      tab.el.style.gridTemplateColumns = cols;
      tab.el.style.gridTemplateRows = "1fr";
    } else {
      tab.el.style.gridTemplateColumns = "1fr";
      tab.el.style.gridTemplateRows = "1fr";
    }

    if (tab !== activeTab) return;
    positionSplitters(tab);
    requestAnimationFrame(() => {
      for (const p of tab.panes) fitPane(p);
    });
  }

  function layout(tab = activeTab) {
    if (!tab) return;
    tab.el.dataset.count = String(tab.panes.length);
    ensureSplitters();
    applyGrid(tab);
    if (tab !== activeTab) return;
    addPaneBtn.disabled = tab.panes.length >= MAX_PANES;
    updateSummary();
  }

  // xterm 的 attachCustomKeyEventHandler 返回 false 只是让 xterm 不再处理，
  // 不会阻止浏览器默认行为。Ctrl+Shift+C 在 Chrome/Edge 里是 DevTools 的
  // “检查元素”，所以必须自己 preventDefault，否则快捷键照样被浏览器截走。
  function consumeKey(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  // 可打印字符（不含 Ctrl/Alt/Meta、组合输入和功能键）。
  function isPrintableKeyEvent(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key && event.key.length === 1) return true;
    const code = event.keyCode || event.charCode;
    return (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 32
    );
  }

  // 复制/粘贴只处理 Ctrl（Linux/Windows）：
  //   Ctrl+C  有选区 → 复制；没有选区 → 原样交给 shell（SIGINT）
  //   Ctrl+Insert / Ctrl+Shift+C → 复制（后者挡掉 Chrome 的 DevTools 快捷键）
  //   Ctrl+V / Ctrl+Shift+V / Shift+Insert → 不拦，交给浏览器原生 paste 事件，
  //   xterm 自己处理 bracketed paste，也不需要 clipboard-read 权限。
  // macOS 的 Cmd+C / Cmd+V 不在这里处理：xterm 本来就不会拦截它们，浏览器的
  // 原生 copy/paste 事件会照常触发，由 xterm 自己完成复制和粘贴。
  function handleTermKey(event, pane) {
    // 触摸设备：可打印字符只走 input 路径；keydown/keypress 交给浏览器默认行为
    // 产生 input，避免 xterm 在键盘事件里先发一次、input 再发一次。
    if (coarsePointer && event.type !== "keyup" && isPrintableKeyEvent(event)) {
      return false;
    }
    if (event.type !== "keydown") return true;
    if (event.key === "Escape" && !findBar.hidden) {
      closeFind();
      return false;
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

  function setFilesWidth(next, persist = false) {
    const body = filesEl.parentElement;
    const max = Math.max(200, body.clientWidth - 320);
    filesWidth = Math.round(Math.min(Math.max(next, 180), max));
    filesEl.style.setProperty("--files-width", `${filesWidth}px`);
    if (persist) {
      try {
        localStorage.setItem("myttty.filesWidth", String(filesWidth));
      } catch (_) {}
    }
  }

  function setCwdSync(enabled, persist = true) {
    cwdSyncEnabled = enabled;
    cwdSyncBtn.classList.toggle("off", !enabled);
    cwdSyncBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    cwdSyncBtn.title = enabled ? "目录跟随：开（点击关闭）" : "目录跟随：关（点击开启）";
    if (persist) {
      try {
        localStorage.setItem("myttty.cwdSync", enabled ? "1" : "0");
      } catch (_) {}
    }
    if (!enabled || !activePane) return;
    // 重新开启时立即对齐；请求一次 cwd 覆盖关闭期间发生的 cd。
    if (activePane.cwd) syncFilesToCwd(activePane.cwd);
    requestCwd(activePane);
  }

  function startFilesResize(ev) {
    ev.preventDefault();
    const el = filesResizeEl;
    el.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");
    const bodyLeft = filesEl.parentElement.getBoundingClientRect().left;

    const move = (e) => setFilesWidth(e.clientX - bodyLeft);
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setFilesWidth(filesWidth, true);
    };

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  async function refreshFiles() {
    notice("");
    const dirs = new Set(["", currentDir, ...treeExpanded]);
    const failed = [];
    let truncated = false;

    await Promise.all(
      [...dirs].map(async (dir) => {
        try {
          const data = await loadDir(dir);
          if (data.truncated) truncated = true;
        } catch (err) {
          failed.push({ dir, err });
        }
      })
    );

    for (const item of failed) {
      if (item.dir === "") {
        treeRootError = true;
      } else {
        treeExpanded.delete(item.dir);
        treeChildren.delete(item.dir);
      }
      notice(`列目录失败: ${item.err.message}`, true);
      if (item.dir === currentDir) currentDir = "";
    }
    if (!failed.some((item) => item.dir === "")) treeRootError = false;
    if (currentDir && !treeChildren.has(currentDir)) currentDir = "";

    renderCrumbs();
    renderTree();
    if (truncated) notice("部分目录条目过多，仅显示前 1 万项");
  }

  async function loadDir(path) {
    const data = await api("GET", "list", { path });
    const result = { entries: data.entries || [], truncated: !!data.truncated };
    treeChildren.set(path, result);
    return result;
  }

  function expandPath(path) {
    treeExpanded.add("");
    let acc = "";
    for (const part of path.split("/")) {
      if (!part) continue;
      acc = joinPath(acc, part);
      treeExpanded.add(acc);
    }
  }

  function pathPrefixes(path) {
    const list = [""];
    let acc = "";
    for (const part of path.split("/")) {
      if (!part) continue;
      acc = joinPath(acc, part);
      list.push(acc);
    }
    return list;
  }

  async function ensureTreeLoaded(path, force = false) {
    if (treeLoading.has(path)) return;
    if (!force && treeChildren.has(path)) return;

    treeLoading.add(path);
    if (!treeChildren.has(path)) renderTree();
    try {
      const data = await loadDir(path);
      if (data.truncated) notice(`目录 ${path || "/"} 条目过多，仅显示前 1 万项`);
    } catch (err) {
      if (!treeChildren.has(path)) treeExpanded.delete(path);
      notice(`列目录失败: ${err.message}`, true);
    } finally {
      treeLoading.delete(path);
      renderTree();
    }
  }

  function applyDir(path, force = false, alignTop = false) {
    currentDir = path;
    expandPath(path);
    // 面板关着时只记住位置，等打开时 refreshFiles() 一次性加载。
    if (filesEl.hidden) return;
    renderCrumbs();
    renderTree();
    scrollTreeToSelected(alignTop);
    const pending = pathPrefixes(path).map((prefix) => ensureTreeLoaded(prefix, force));
    Promise.all(pending).then(() => {
      if (currentDir === path && !filesEl.hidden) scrollTreeToSelected(alignTop);
    });
  }

  function selectDir(path) {
    if (path === currentDir && treeExpanded.has(path)) return;
    applyDir(path);
  }

  /// shell 的 cwd 变化或用户按回车后，把文件树跳到对应目录。
  /// 强制重读路径上的目录，终端里新建的目录也能立即出现在树里。
  function syncFilesToCwd(path) {
    if (typeof path !== "string" || path === currentDir) return;
    applyDir(path, true, true);
  }

  function toggleDir(path) {
    if (treeExpanded.has(path)) {
      treeExpanded.delete(path);
      renderTree();
      return;
    }
    treeExpanded.add(path);
    ensureTreeLoaded(path, true);
    renderTree();
  }

  function dropTreePath(path) {
    for (const p of [...treeExpanded]) {
      if (p === path || p.startsWith(`${path}/`)) treeExpanded.delete(p);
    }
    for (const p of [...treeChildren.keys()]) {
      if (p === path || p.startsWith(`${path}/`)) treeChildren.delete(p);
    }
    if (currentDir === path || currentDir.startsWith(`${path}/`)) {
      currentDir = parentOf(path);
    }
  }

  function rebaseTree(oldPath, newPath) {
    const mapped = (p) =>
      p === oldPath
        ? newPath
        : p.startsWith(`${oldPath}/`)
          ? newPath + p.slice(oldPath.length)
          : p;

    for (const p of [...treeExpanded]) {
      if (p === oldPath || p.startsWith(`${oldPath}/`)) {
        treeExpanded.delete(p);
        treeExpanded.add(mapped(p));
      }
    }
    for (const p of [...treeChildren.keys()]) {
      if (p === oldPath || p.startsWith(`${oldPath}/`)) treeChildren.delete(p);
    }
    if (currentDir === oldPath || currentDir.startsWith(`${oldPath}/`)) {
      currentDir = mapped(currentDir);
    }
  }

  function renderCrumbs() {
    crumbEl.innerHTML = "";
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.textContent = "/";
    rootBtn.classList.toggle("active", currentDir === "");
    rootBtn.addEventListener("click", () => selectDir(""));
    crumbEl.appendChild(rootBtn);

    if (!currentDir) return;
    let acc = "";
    const parts = currentDir.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      acc = joinPath(acc, part);
      const sep = document.createElement("span");
      sep.textContent = "/";
      sep.className = "sep";
      crumbEl.appendChild(sep);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = part;
      if (i === parts.length - 1) btn.classList.add("active");
      const target = acc;
      btn.addEventListener("click", () => selectDir(target));
      crumbEl.appendChild(btn);
    }
  }

  function renderTree() {
    const scrollTop = fileList.scrollTop;
    fileList.innerHTML = "";
    const root = treeChildren.get("");
    if (!root) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = treeRootError ? "无法读取目录" : "加载中…";
      fileList.appendChild(li);
      fileList.scrollTop = scrollTop;
      return;
    }
    if (root.entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "（空目录）";
      fileList.appendChild(li);
      fileList.scrollTop = scrollTop;
      return;
    }
    for (const entry of root.entries) {
      fileList.appendChild(renderNode("", entry));
    }
    fileList.scrollTop = scrollTop;
  }

  function scrollTreeToSelected(alignTop = false) {
    const sel = fileList.querySelector(".entry.selected");
    if (!sel) return;
    const list = fileList.getBoundingClientRect();
    const row = sel.getBoundingClientRect();
    if (alignTop) {
      // cwd 同步时尽量把目标放到列表顶部，下面直接露出目录内容。
      fileList.scrollTop = Math.max(0, fileList.scrollTop + (row.top - list.top) - 4);
      return;
    }
    if (row.top < list.top) {
      fileList.scrollTop -= list.top - row.top;
    } else if (row.bottom > list.bottom) {
      fileList.scrollTop += row.bottom - list.bottom;
    }
  }

  function renderNode(parentPath, entry) {
    const isDir = entry.kind === "directory";
    const path = joinPath(parentPath, entry.name);
    const li = document.createElement("li");
    li.className = "tree-node";

    const row = document.createElement("div");
    row.className = `entry ${isDir ? "directory" : "file"}`;
    row.dataset.path = path;
    row.classList.toggle("selected", isDir && path === currentDir);

    if (isDir) {
      const open = treeExpanded.has(path);
      const caret = document.createElement("button");
      caret.type = "button";
      caret.className = "caret";
      caret.classList.toggle("open", open);
      caret.appendChild(iconNode("chevron"));
      caret.title = open ? "折叠" : "展开";
      caret.setAttribute("aria-label", caret.title);
      caret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleDir(path);
      });
      row.appendChild(caret);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "caret-spacer";
      row.appendChild(spacer);
    }

    const name = document.createElement("button");
    name.type = "button";
    name.className = "name";
    name.textContent = entry.name;
    name.title = entry.name;
    name.addEventListener("click", () => {
      if (isDir) selectDir(path);
      else openEditor(path);
    });
    row.appendChild(name);

    if (entry.kind === "file") {
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = humanSize(entry.size);
      row.appendChild(size);
    }

    const actions = document.createElement("span");
    actions.className = "actions";

    if (isDir) {
      actions.appendChild(
        smallButton("download", "下载目录（tar）", () => downloadArchive(path, entry.name))
      );
    } else {
      actions.appendChild(smallButton("download", "下载", () => downloadFile(path, entry.name)));
    }

    const renameBtn = smallButton("rename", "重命名", async () => {
      const next = await askText("重命名", entry.name);
      if (!next || next === entry.name) return;
      const newPath = joinPath(parentPath, next);
      try {
        await api("POST", "rename", { from: path, to: newPath });
        if (isDir) rebaseTree(path, newPath);
        refreshFiles();
      } catch (err) {
        notice(`重命名失败: ${err.message}`, true);
      }
    });
    actions.appendChild(renameBtn);

    const delBtn = smallButton("delete", "删除", async () => {
      if (!confirm(`删除 ${entry.name}？此操作不可撤销。`)) return;
      try {
        await api("DELETE", "delete", { path });
        if (isDir) dropTreePath(path);
        refreshFiles();
      } catch (err) {
        notice(`删除失败: ${err.message}`, true);
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    if (isDir) {
      row.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-target");
        if (ev.dataTransfer && ev.dataTransfer.files.length) {
          uploadFiles(ev.dataTransfer.files, path);
        }
      });
    }

    li.appendChild(row);

    if (isDir && treeExpanded.has(path)) {
      const children = document.createElement("ul");
      children.className = "tree-children";
      const data = treeChildren.get(path);
      if (!data) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = treeLoading.has(path) ? "加载中…" : "（未加载）";
        children.appendChild(empty);
      } else if (data.entries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "（空目录）";
        children.appendChild(empty);
      } else {
        for (const child of data.entries) {
          children.appendChild(renderNode(path, child));
        }
      }
      li.appendChild(children);
    }

    return li;
  }

  const actionIcons = {
    download: ["M8 2.5v8", "M4.5 7 8 10.5 11.5 7", "M3.5 13h9"],
    rename: ["M3 13l1-3 7-7 2 2-7 7z", "M9.5 3.5l2 2"],
    delete: ["M4 4l8 8", "M12 4l-8 8"],
    chevron: ["M6 4l4 4-4 4"],
  };

  function iconNode(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "ico");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const d of actionIcons[name] || []) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  function smallButton(icon, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(iconNode(icon));
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
    if (targetDir) treeExpanded.add(targetDir);
    refreshFiles();
  }

  // 应用内文本输入弹窗；返回 null 表示取消。
  function askText(title, initial = "") {
    return new Promise((resolve) => {
      promptTitle.textContent = title;
      promptInput.value = initial;
      promptError.textContent = "";
      promptOverlay.hidden = false;
      promptInput.focus();
      promptInput.select();

      const finish = (value) => {
        promptOverlay.hidden = true;
        promptForm.removeEventListener("submit", onSubmit);
        promptForm.removeEventListener("keydown", onKey);
        promptCancel.removeEventListener("click", onCancel);
        resolve(value);
      };
      const onSubmit = (event) => {
        event.preventDefault();
        if (!promptInput.value) {
          promptError.textContent = "名字不能为空";
          promptInput.focus();
          return;
        }
        finish(promptInput.value);
      };
      const onCancel = () => finish(null);
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      };

      promptForm.addEventListener("submit", onSubmit);
      promptForm.addEventListener("keydown", onKey);
      promptCancel.addEventListener("click", onCancel);
    });
  }

  async function newFile() {
    const name = await askText("新建文件");
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
    const name = await askText("新建目录");
    if (!name) return;
    const path = joinPath(currentDir, name);
    try {
      await api("POST", "mkdir", { path });
      currentDir = path;
      treeExpanded.add(path);
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
    if (!promptOverlay.hidden) return;
    if (ev.key === "Escape" && !editorOverlay.hidden) {
      ev.preventDefault();
      closeEditor();
    }
  });

  // -------------------------------------------------------------------- boot

  addPaneBtn.addEventListener("click", () => createPane());
  tabAddBtn.addEventListener("click", () => newTab());
  tabMoreBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (tabMenuEl.hidden) openTabMenu();
    else closeTabMenu();
  });
  document.addEventListener("click", (ev) => {
    if (tabMenuEl.hidden) return;
    if (tabMoreBtn.contains(ev.target) || tabMenuEl.contains(ev.target)) return;
    closeTabMenu();
  });
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape" || tabMenuEl.hidden) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeTabMenu();
    },
    true
  );

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
    if (!promptOverlay.hidden) return;
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
      if (!findBar.hidden) {
        ev.preventDefault();
        closeFind();
      }
    }
  });
  filesBtn.addEventListener("click", () => {
    filesEl.hidden = !filesEl.hidden;
    filesResizeEl.hidden = filesEl.hidden;
    if (!filesEl.hidden) {
      refreshFiles()
        .then(() => {
          if (!filesEl.hidden) scrollTreeToSelected(true);
        })
        .catch(() => {});
      requestAnimationFrame(() => panes.forEach(fitPane));
    }
  });
  document.getElementById("files-refresh").addEventListener("click", refreshFiles);
  cwdSyncBtn.addEventListener("click", () => setCwdSync(!cwdSyncEnabled));
  setCwdSync(cwdSyncEnabled, false);
  document.getElementById("files-new-file").addEventListener("click", newFile);
  document.getElementById("files-new-dir").addEventListener("click", newDir);
  filesResizeEl.addEventListener("pointerdown", startFilesResize);
  filesResizeEl.addEventListener("dblclick", () => setFilesWidth(300, true));
  setFilesWidth(filesWidth);

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

  window.addEventListener("resize", () => {
    setFilesWidth(filesWidth);
    panes.forEach(fitPane);
    layoutTabs();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      panes.forEach(fitPane);
      layoutTabs();
    });
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
    for (const tab of tabs) {
      for (const p of tab.panes) {
        p.term.options.fontSize = fontsize;
        if (tab === activeTab) fitPane(p);
      }
    }
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
    if (tabs.length === 0) {
      const restored = restoreTabs();
      if (!restored) newTab();
    } else {
      layout();
    }
    layoutTabs();
    refreshFiles();
  }

  function validSessionId(sid) {
    return typeof sid === "string" && /^[0-9a-f]{32}$/.test(sid);
  }

  function restoreTabs() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem("myttty.tabs") || "null");
    } catch (_) {}

    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      for (const t of saved.tabs.slice(0, MAX_TABS)) {
        const tab = addTab();
        if (!tab) break;
        const sx = Number(t && t.x);
        const sy = Number(t && t.y);
        if (Number.isFinite(sx)) tab.splitX = clampSplit(sx);
        if (Number.isFinite(sy)) tab.splitY = clampSplit(sy);
        // 先让标签页可见再创建终端，避免在 display:none 的容器里 open()。
        activateTab(tab);
        const ids = Array.isArray(t && t.s) ? t.s.slice(0, MAX_PANES) : [];
        for (const sid of ids) {
          if (validSessionId(sid)) createPane(sid, tab);
        }
        if (tab.panes.length === 0) createPane("", tab);
      }
      const wanted = Number.isInteger(saved.active) ? saved.active : 0;
      activateTab(tabs[Math.min(Math.max(wanted, 0), tabs.length - 1)]);
      return true;
    }

    // 兼容旧版本：只有一组 pane 会话 id。
    try {
      const old = JSON.parse(sessionStorage.getItem("myttty.sessions") || "null");
      if (Array.isArray(old) && old.length) {
        const tab = addTab();
        activateTab(tab);
        for (const sid of old.slice(0, MAX_PANES)) {
          if (validSessionId(sid)) createPane(sid, tab);
        }
        if (tab.panes.length === 0) createPane("", tab);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function stopApp() {
    started = false;
    for (const tab of [...tabs]) {
      for (const pane of [...tab.panes]) removePane(pane, false);
      tab.el.remove();
      tab.btn.remove();
    }
    tabs.length = 0;
    activeTab = null;
    tabSeq = 0;
    panes = [];
    activePane = null;
    if (splitters.v) splitters.v.hidden = true;
    if (splitters.h) splitters.h.hidden = true;
    updateTabHint();
    updateSummary();
    try {
      sessionStorage.removeItem("myttty.tabs");
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
