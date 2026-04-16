(() => {
  const RELAY_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  // ── State ──────────────────────────────────────────────────────────────────

  let agents = [];        // [{ name, sessions, busy }]
  let ws = null;
  let dialogTarget = null; // which panel opened the dialog

  const panels = {
    left:  { tabs: [], active: null },
    right: { tabs: [], active: null },
  };

  // ── WebSocket connection to relay ──────────────────────────────────────────

  function connect() {
    ws = new WebSocket(RELAY_WS);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'list' }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.type === 'agents') {
        agents = msg.list;
      } else if (msg.type === 'output') {
        // find the tab that owns this ws — each tab has its own ws
        // (relay sends output only to the ws that issued connect)
        // handled per-tab below
      }
    });

    ws.addEventListener('close', () => {
      setTimeout(connect, 3000);
    });
  }

  // ── Tab management ─────────────────────────────────────────────────────────

  function createTab(panelId, agentName, session) {
    const panel = panels[panelId];
    const tabbar = document.getElementById(`tabs-${panelId}`);
    const termWrap = document.getElementById(`terms-${panelId}`);

    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const label = `${agentName}:${session}`;

    // xterm instance
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

    // dedicated WebSocket per tab
    const tabWs = new WebSocket(RELAY_WS);

    tabWs.addEventListener('open', () => {
      tabWs.send(JSON.stringify({ type: 'connect', agent: agentName, session }));
    });

    tabWs.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'output') {
        term.write(atob(msg.data));
      } else if (msg.type === 'agent_disconnected') {
        term.write('\r\n\x1b[31m[Agent odpojen]\x1b[0m\r\n');
      }
    });

    tabWs.addEventListener('close', () => {
      term.write('\r\n\x1b[33m[Spojení přerušeno]\x1b[0m\r\n');
    });

    term.onData((data) => {
      if (tabWs.readyState === WebSocket.OPEN) {
        tabWs.send(JSON.stringify({ type: 'input', data: btoa(data) }));
      }
    });

    // resize: fit terminal to container, send to relay
    const ro = new ResizeObserver(() => fitAndSend());
    ro.observe(div);

    function fitAndSend() {
      if (!div.classList.contains('active')) return;
      fitAddon.fit();
      if (tabWs.readyState === WebSocket.OPEN) {
        tabWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }

    // DOM tab element
    const tabEl = document.createElement('span');
    tabEl.className = 'tab';
    tabEl.dataset.id = id;
    tabEl.innerHTML = `<span class="tab-label">${label}</span><span class="tab-close">×</span>`;

    tabEl.querySelector('.tab-label').addEventListener('click', () => activateTab(panelId, id));
    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(panelId, id);
    });

    // insert before the + button
    const addBtn = tabbar.querySelector('.tab-add');
    tabbar.insertBefore(tabEl, addBtn);

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
      if (isActive) {
        t.fitAddon.fit();
        t.term.focus();
      }
    }
  }

  function closeTab(panelId, id) {
    const panel = panels[panelId];
    const idx = panel.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;

    const entry = panel.tabs[idx];
    entry.tabWs.close();
    entry.ro.disconnect();
    entry.term.dispose();
    entry.div.remove();
    entry.tabEl.remove();
    panel.tabs.splice(idx, 1);

    // activate neighbour
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
          closeDialogEl();
          createTab(dialogTarget, agent.name, session);
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

  // ── Divider drag (PC two-panel split) ─────────────────────────────────────

  function initDivider() {
    const divider = document.getElementById('divider');
    const panelLeft = document.getElementById('panel-left');
    const panelRight = document.getElementById('panel-right');
    let dragging = false;
    let startX, startLeftW;

    divider.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startLeftW = panelLeft.offsetWidth;
      divider.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const total = panelLeft.offsetWidth + panelRight.offsetWidth;
      const newLeft = Math.max(150, Math.min(total - 150, startLeftW + delta));
      panelLeft.style.flex = 'none';
      panelLeft.style.width = `${newLeft}px`;
      panelRight.style.flex = '1';
      // refit active tabs
      for (const p of Object.values(panels)) {
        const active = p.tabs.find(t => t.id === p.active);
        if (active) { active.fitAddon.fit(); }
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
      // refresh agent list before opening dialog
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'list' }));
      }
      openDialog(e.target.dataset.panel);
    }
  });

  document.getElementById('dialog-cancel').addEventListener('click', closeDialogEl);

  document.getElementById('dialog-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDialogEl();
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  initDivider();
  connect();
})();
