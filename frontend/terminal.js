(() => {
  const RELAY_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const TOKEN_KEY = 'relay_token';

  // ── Token / login ──────────────────────────────────────────────────────────

  function getToken()        { return localStorage.getItem(TOKEN_KEY); }
  function saveToken(token)  { localStorage.setItem(TOKEN_KEY, token); }
  function clearToken()      { localStorage.removeItem(TOKEN_KEY); }

  // ── Encoding helpers (handle full Unicode, not just Latin-1) ──────────────
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
    const overlay = document.getElementById('login-overlay');
    overlay.classList.add('open');
    if (errorMsg) {
      document.getElementById('login-error').textContent = errorMsg;
    }
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

  let agents      = [];
  let ws          = null;
  let dialogTarget = null;

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
      if (ev.code === 4001) {
        clearToken();
        showLogin('Neplatný přístupový token.');
        return;
      }
      setTimeout(connect, 3000);
    });
  }

  // ── Tab management ─────────────────────────────────────────────────────────

  function createTab(panelId, agentName, session) {
    const panel   = panels[panelId];
    const tabbar  = document.getElementById(`tabs-${panelId}`);
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
      if (msg.type === 'output') {
        term.write(fromBase64(msg.data));
      } else if (msg.type === 'agent_disconnected') {
        term.write('\r\n\x1b[31m[Agent odpojen]\x1b[0m\r\n');
      }
    });

    tabWs.addEventListener('close', (ev) => {
      if (ev.code === 4001) {
        clearToken();
        showLogin('Neplatný přístupový token.');
        return;
      }
      term.write('\r\n\x1b[33m[Spojení přerušeno]\x1b[0m\r\n');
    });

    function sendInput(text) {
      if (tabWs.readyState === WebSocket.OPEN) {
        tabWs.send(JSON.stringify({ type: 'input', data: toBase64(text) }));
      }
    }

    // Direct key capture (desktop — special keys, Ctrl+C, arrows, etc.)
    term.onData((data) => sendInput(data));

    // ── Text input bar (diacritics, mobile IME) ──────────────────────────────
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
      const val = inputText.value;
      if (!val) return;
      sendInput(val);
      inputText.value = '';
      inputText.style.height = '';
      term.focus();
    }

    inputText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAndClear();
      }
    });

    inputText.addEventListener('input', () => {
      inputText.style.height = '';
      inputText.style.height = Math.min(inputText.scrollHeight, 120) + 'px';
    });

    inputSend.addEventListener('click', () => sendAndClear());

    // Prevent xterm from stealing focus when typing in input bar
    inputText.addEventListener('focus', () => term.blur());

    const ro = new ResizeObserver(() => fitAndSend());
    ro.observe(div);

    function fitAndSend() {
      if (!div.classList.contains('active')) return;
      fitAddon.fit();
      if (tabWs.readyState === WebSocket.OPEN) {
        tabWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }

    const tabEl = document.createElement('span');
    tabEl.className = 'tab';
    tabEl.dataset.id = id;
    tabEl.innerHTML = `<span class="tab-label">${label}</span><span class="tab-close">×</span>`;

    tabEl.querySelector('.tab-label').addEventListener('click', () => activateTab(panelId, id));
    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(panelId, id);
    });

    tabbar.insertBefore(tabEl, tabbar.querySelector('.tab-add'));

    const entry = { id, tabEl, div, term, fitAddon, tabWs, ro };
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

  function openDialog(panelId) {
    dialogTarget = panelId;
    const list = document.getElementById('agent-list');
    list.innerHTML = '';

    if (!agents.length) {
      list.textContent = 'Žádné agenty nejsou připojeny.';
    }

    for (const agent of agents) {
      const group = document.createElement('div');
      group.className = 'agent-group';
      group.innerHTML = `<div class="agent-name">${agent.name}</div>`;
      for (const session of agent.sessions) {
        const btn = document.createElement('button');
        btn.className = 'session-btn';
        btn.textContent = session;
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
    const divider   = document.getElementById('divider');
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
      const total  = panelLeft.offsetWidth + panelRight.offsetWidth;
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
    connect();
  }

  if (getToken()) {
    init();
  } else {
    showLogin();
  }
})();
