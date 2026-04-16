(() => {
  const RELAY_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const TOKEN_KEY = 'relay_token';

  function getToken()        { return localStorage.getItem(TOKEN_KEY); }
  function saveToken(token)  { localStorage.setItem(TOKEN_KEY, token); }
  function clearToken()      { localStorage.removeItem(TOKEN_KEY); }

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...bytes));
  }
  function fromBase64(b64) {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  }

  function wsUrl() {
    return `${RELAY_WS}?role=client&token=${encodeURIComponent(getToken())}`;
  }

  function showLogin(errorMsg) {
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-overlay').classList.add('open');
    if (errorMsg) document.getElementById('login-error').textContent = errorMsg;
    document.getElementById('login-input').focus();
  }

  function hideLogin() {
    document.getElementById('login-overlay').classList.remove('open');
    document.getElementById('app').style.display = '';
    document.getElementById('login-error').textContent = '';
  }

  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('login-input').value.trim();
    if (!val) return;
    saveToken(val);
    hideLogin();
    init();
  });

  // ── State ──────────────────────────────────────────────────────────────────

  let agents       = [];
  let ws           = null;
  let dialogTarget = null;
  let draggedEntry = null;

  const panels = {
    left:  { tabs: [], active: null },
    right: { tabs: [], active: null },
  };

  // ── WebSocket connection to relay ──────────────────────────────────────────

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'list' }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'agents') agents = msg.list;
    });
    ws.addEventListener('close', (ev) => {
      if (ev.code === 4001) { clearToken(); showLogin('Neplatný přístupový token.'); return; }
      setTimeout(connect, 3000);
    });
  }

  // ── Layout: single / double panel ──────────────────────────────────────────

  const mql = window.matchMedia('(max-width: 1399px), (orientation: portrait)');

  function isSingle() { return mql.matches; }

  function collapseToSingle() {
    const leftTabbar = document.getElementById('tabs-left');
    const leftTerms  = document.getElementById('terms-left');

    for (const entry of [...panels.right.tabs]) {
      entry.originPanel = 'right';
      entry.panelId = 'left';
      leftTabbar.insertBefore(entry.tabEl, leftTabbar.querySelector('.tab-add'));
      leftTerms.appendChild(entry.div);
      panels.left.tabs.push(entry);
    }

    const prevRightActive = panels.right.active;
    panels.right.tabs = [];
    panels.right.active = null;

    document.getElementById('panel-right').style.display = 'none';
    document.getElementById('divider').style.display = 'none';

    if (!panels.left.active && prevRightActive) panels.left.active = prevRightActive;
    if (panels.left.active) activateTab('left', panels.left.active);
    else if (panels.left.tabs.length) activateTab('left', panels.left.tabs[0].id);
  }

  function expandToDouble() {
    document.getElementById('panel-right').style.display = '';
    document.getElementById('divider').style.display = '';

    const rightTabbar = document.getElementById('tabs-right');
    const rightTerms  = document.getElementById('terms-right');

    const toRight = panels.left.tabs.filter(t => t.originPanel === 'right');
    for (const entry of toRight) {
      entry.panelId = 'right';
      delete entry.originPanel;
      rightTabbar.insertBefore(entry.tabEl, rightTabbar.querySelector('.tab-add'));
      rightTerms.appendChild(entry.div);
      panels.right.tabs.push(entry);
      panels.left.tabs = panels.left.tabs.filter(t => t !== entry);
      if (panels.left.active === entry.id) panels.left.active = null;
    }

    if (!panels.left.active && panels.left.tabs.length)
      activateTab('left', panels.left.tabs[0].id);
    if (!panels.right.active && panels.right.tabs.length)
      activateTab('right', panels.right.tabs[0].id);

    for (const [pid, panel] of Object.entries(panels))
      if (panel.active) activateTab(pid, panel.active);
  }

  mql.addEventListener('change', (e) => {
    if (e.matches) collapseToSingle();
    else expandToDouble();
  });

  // ── Move tab between panels ────────────────────────────────────────────────

  function moveTab(entry, targetPanelId) {
    const srcPanelId = entry.panelId;
    if (srcPanelId === targetPanelId) return;

    const srcPanel  = panels[srcPanelId];
    const dstPanel  = panels[targetPanelId];
    const dstTabbar = document.getElementById(`tabs-${targetPanelId}`);
    const dstTerms  = document.getElementById(`terms-${targetPanelId}`);

    srcPanel.tabs = srcPanel.tabs.filter(t => t !== entry);
    if (srcPanel.active === entry.id) {
      const fallback = srcPanel.tabs[0] || null;
      srcPanel.active = fallback ? fallback.id : null;
      if (fallback) activateTab(srcPanelId, fallback.id);
      else {
        for (const t of document.querySelectorAll(`#terms-${srcPanelId} .xterm-instance`))
          t.classList.remove('active');
        for (const t of document.querySelectorAll(`#tabs-${srcPanelId} .tab`))
          t.classList.remove('active');
      }
    }

    entry.panelId = targetPanelId;
    delete entry.originPanel;
    // Deactivate before DOM move to suppress spurious resize(0,0)
    entry.div.classList.remove('active');
    entry.tabEl.classList.remove('active');
    dstTabbar.insertBefore(entry.tabEl, dstTabbar.querySelector('.tab-add'));
    dstTerms.appendChild(entry.div);
    dstPanel.tabs.push(entry);
    activateTab(targetPanelId, entry.id);
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────────

  function setupDrag(entry) {
    entry.tabEl.draggable = true;

    entry.tabEl.addEventListener('dragstart', (e) => {
      draggedEntry = entry;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => entry.tabEl.classList.add('dragging'), 0);
    });

    entry.tabEl.addEventListener('dragend', () => {
      entry.tabEl.classList.remove('dragging');
      document.querySelectorAll('.tabbar').forEach(tb => tb.classList.remove('drag-over'));
      draggedEntry = null;
    });
  }

  function setupTabbarDrop(panelId) {
    const tabbar = document.getElementById(`tabs-${panelId}`);

    tabbar.addEventListener('dragover', (e) => {
      if (!draggedEntry || draggedEntry.panelId === panelId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.tabbar').forEach(tb => tb.classList.remove('drag-over'));
      tabbar.classList.add('drag-over');
    });

    tabbar.addEventListener('dragleave', (e) => {
      if (!tabbar.contains(e.relatedTarget)) tabbar.classList.remove('drag-over');
    });

    tabbar.addEventListener('drop', (e) => {
      e.preventDefault();
      tabbar.classList.remove('drag-over');
      if (draggedEntry && draggedEntry.panelId !== panelId) {
        moveTab(draggedEntry, panelId);
      }
      draggedEntry = null;
    });
  }

  // ── Tab management ─────────────────────────────────────────────────────────

  function createTab(panelId, agentName, session) {
    // In single mode, always create in left panel
    if (isSingle()) panelId = 'left';

    const panel    = panels[panelId];
    const tabbar   = document.getElementById(`tabs-${panelId}`);
    const termWrap = document.getElementById(`terms-${panelId}`);

    const id    = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const label = `${agentName}:${session}`;

    const div = document.createElement('div');
    div.className = 'xterm-instance';
    div.dataset.id = id;
    termWrap.appendChild(div);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: '#000000' },
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(div);

    const tabWs = new WebSocket(wsUrl());

    tabWs.addEventListener('open', () => {
      tabWs.send(JSON.stringify({ type: 'connect', agent: agentName, session }));
    });

    tabWs.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'output') term.write(fromBase64(msg.data));
      else if (msg.type === 'agent_disconnected') term.write('\r\n\x1b[31m[Agent odpojen]\x1b[0m\r\n');
    });

    tabWs.addEventListener('close', (ev) => {
      if (ev.code === 4001) { clearToken(); showLogin('Neplatný přístupový token.'); return; }
      term.write('\r\n\x1b[33m[Spojení přerušeno]\x1b[0m\r\n');
    });

    function sendInput(text) {
      if (tabWs.readyState === WebSocket.OPEN)
        tabWs.send(JSON.stringify({ type: 'input', data: toBase64(text) }));
    }

    term.onData((data) => sendInput(data));

    // ── Input bar ────────────────────────────────────────────────────────────
    const inputBar = document.createElement('div');
    inputBar.className = 'input-bar';
    inputBar.innerHTML = `
      <textarea class="input-text" rows="1" placeholder="Zadejte text (Enter = odeslat, Shift+Enter = nový řádek)"></textarea>
      <button class="input-send">↵</button>
    `;
    div.appendChild(inputBar);

    const inputText = inputBar.querySelector('.input-text');
    const inputSend = inputBar.querySelector('.input-send');

    function sendAndClear() {
      sendInput(inputText.value + '\r');
      inputText.value = '';
      inputText.style.height = '';
      term.focus();
    }

    inputText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAndClear(); }
    });
    inputText.addEventListener('input', () => {
      inputText.style.height = '';
      inputText.style.height = Math.min(inputText.scrollHeight, 120) + 'px';
    });
    inputSend.addEventListener('click', () => sendAndClear());
    inputText.addEventListener('focus', () => term.blur());

    const ro = new ResizeObserver(() => fitAndSend());
    ro.observe(div);

    function fitAndSend() {
      if (!div.classList.contains('active')) return;
      fitAddon.fit();
      if (tabWs.readyState === WebSocket.OPEN)
        tabWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }

    // ── Tab element ──────────────────────────────────────────────────────────
    const tabEl = document.createElement('span');
    tabEl.className = 'tab';
    tabEl.dataset.id = id;
    tabEl.innerHTML = `<span class="tab-label">${label}</span><span class="tab-close">×</span>`;

    tabEl.querySelector('.tab-label').addEventListener('click', () => activateTab(entry.panelId, id));
    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(entry.panelId, id);
    });

    tabbar.insertBefore(tabEl, tabbar.querySelector('.tab-add'));

    const entry = { id, panelId, tabEl, div, term, fitAddon, tabWs, ro };
    setupDrag(entry);
    panel.tabs.push(entry);
    activateTab(panelId, id);
    return entry;
  }

  function activateTab(panelId, id) {
    const panel = panels[panelId];
    panel.active = id;
    for (const t of panel.tabs) {
      const isActive = t.id === id;
      t.tabEl.classList.toggle('active', isActive);
      t.div.classList.toggle('active', isActive);
      if (isActive) { t.fitAddon.fit(); t.term.focus(); }
    }
  }

  function closeTab(panelId, id) {
    const panel = panels[panelId];
    const idx   = panel.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const entry = panel.tabs[idx];
    entry.tabWs.close();
    entry.ro.disconnect();
    entry.term.dispose();
    entry.div.remove();
    entry.tabEl.remove();
    panel.tabs.splice(idx, 1);
    if (panel.active === id) {
      const next = panel.tabs[idx] || panel.tabs[idx - 1];
      if (next) activateTab(panelId, next.id);
      else panel.active = null;
    }
  }

  // ── Connect dialog ─────────────────────────────────────────────────────────

  function openSessionsInUse() {
    const inUse = new Set();
    for (const panel of Object.values(panels))
      for (const t of panel.tabs) inUse.add(t.tabEl.querySelector('.tab-label').textContent);
    return inUse;
  }

  function openDialog(panelId) {
    dialogTarget = panelId;
    const list = document.getElementById('agent-list');
    list.innerHTML = '';

    if (!agents.length) {
      list.textContent = 'Žádné agenty nejsou připojeny.';
    }

    const inUse = openSessionsInUse();

    for (const agent of agents) {
      const group = document.createElement('div');
      group.className = 'agent-group';
      group.innerHTML = `<div class="agent-name">${agent.name}</div>`;
      for (const session of agent.sessions) {
        const key = `${agent.name}:${session}`;
        const btn = document.createElement('button');
        btn.className = 'session-btn' + (inUse.has(key) ? ' session-open' : '');
        btn.textContent = session;
        if (inUse.has(key)) btn.title = 'Již otevřeno';
        btn.addEventListener('click', () => {
          const target = dialogTarget;
          closeDialogEl();
          createTab(target, agent.name, session);
        });
        group.appendChild(btn);
      }
      list.appendChild(group);
    }

    document.getElementById('dialog-overlay').classList.add('open');
  }

  function closeDialogEl() {
    document.getElementById('dialog-overlay').classList.remove('open');
    dialogTarget = null;
  }

  // ── Divider drag ───────────────────────────────────────────────────────────

  function initDivider() {
    const divider    = document.getElementById('divider');
    const panelLeft  = document.getElementById('panel-left');
    const panelRight = document.getElementById('panel-right');
    let dragging = false, startX, startLeftW;

    divider.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startLeftW = panelLeft.offsetWidth;
      divider.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const total   = panelLeft.offsetWidth + panelRight.offsetWidth;
      const newLeft = Math.max(150, Math.min(total - 150, startLeftW + e.clientX - startX));
      panelLeft.style.flex  = 'none';
      panelLeft.style.width = `${newLeft}px`;
      panelRight.style.flex = '1';
      for (const p of Object.values(panels)) {
        const a = p.tabs.find(t => t.id === p.active);
        if (a) a.fitAddon.fit();
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      document.body.style.userSelect = '';
    });
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-add')) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'list' }));
      openDialog(e.target.dataset.panel);
    }
  });

  document.getElementById('dialog-cancel').addEventListener('click', closeDialogEl);
  document.getElementById('dialog-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDialogEl();
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    initDivider();
    setupTabbarDrop('left');
    setupTabbarDrop('right');

    // Apply initial layout
    if (isSingle()) {
      document.getElementById('panel-right').style.display = 'none';
      document.getElementById('divider').style.display = 'none';
    }

    connect();
  }

  if (getToken()) {
    init();
  } else {
    showLogin();
  }
})();
