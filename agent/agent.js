require('dotenv').config();
const fs   = require('fs');
const pty  = require('node-pty');
const { WebSocket } = require('ws');

const RELAY_URL  = process.env.RELAY_URL;
const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_KEY  = process.env.AGENT_KEY;
const AGENT_CERT = process.env.AGENT_CERT;
const CA_CERT    = process.env.CA_CERT;

for (const v of ['RELAY_URL', 'AGENT_NAME', 'AGENT_KEY', 'AGENT_CERT', 'CA_CERT']) {
  if (!process.env[v]) { console.error(`[ERROR] ${v} not set`); process.exit(1); }
}

const RECONNECT_BASE = 2000;
const RECONNECT_MAX  = 60_000;

// ── Session registry ──────────────────────────────────────────────────────
// Each entry: { name, type: 'tmux'|'tty', ptyProcess: null }

let activePty   = null; // currently attached PTY
let activeSession = null;
let reconnectDelay = RECONNECT_BASE;
let ws = null;

// ── Discover available sessions ───────────────────────────────────────────

function discoverSessions() {
  const sessions = [];

  // tmux sessions
  const configured = (process.env.TMUX_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (configured.length) {
    sessions.push(...configured.map(s => ({ name: s, type: 'tmux' })));
  } else {
    try {
      const { execSync } = require('child_process');
      const out = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf8' });
      out.trim().split('\n').filter(Boolean).forEach(s => sessions.push({ name: s, type: 'tmux' }));
    } catch {
      // tmux not running
    }
  }

  // TTY consoles
  const ttys = (process.env.TTY_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  ttys.forEach(t => sessions.push({ name: t, type: 'tty' }));

  return sessions;
}

// ── PTY management ────────────────────────────────────────────────────────

function detachCurrent() {
  if (activePty) {
    try { activePty.kill(); } catch {}
    activePty = null;
    activeSession = null;
  }
}

function attachSession(sessionName, cols, rows) {
  detachCurrent();

  const sessions = discoverSessions();
  const entry = sessions.find(s => s.name === sessionName);
  if (!entry) {
    console.log(`[WARN] Session not found: ${sessionName}`);
    return;
  }

  let command, args;
  if (entry.type === 'tmux') {
    command = 'tmux';
    args = ['attach-session', '-t', sessionName];
  } else {
    // TTY via conspy (requires root or tty group)
    const ttyNum = sessionName.replace(/[^0-9]/g, '');
    command = 'conspy';
    args = ['-W', String(cols || 220), '-H', String(rows || 50), ttyNum];
  }

  console.log(`[INFO] Attaching to ${entry.type} session: ${sessionName}`);

  // Strip tmux/terminal vars that cause tmux to exit immediately
  const ptyEnv = { ...process.env };
  delete ptyEnv.TMUX;
  delete ptyEnv.TMUX_PANE;
  ptyEnv.TERM = 'xterm-256color';

  activePty = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: cols || 220,
    rows: rows || 50,
    env: ptyEnv,
  });

  activeSession = sessionName;

  activePty.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data: btoa(data) }));
    }
  });

  activePty.onExit(({ exitCode }) => {
    console.log(`[INFO] PTY exited for session: ${sessionName} (code ${exitCode})`);
    // Notify browser so it shows a message instead of silent freeze
    if (ws?.readyState === WebSocket.OPEN) {
      const msg = `\r\n\x1b[33m[Session '${sessionName}' ended (exit ${exitCode}). Close this tab.]\x1b[0m\r\n`;
      ws.send(JSON.stringify({ type: 'output', data: Buffer.from(msg).toString('base64') }));
      ws.send(JSON.stringify({ type: 'session_list', sessions: discoverSessions().map(s => s.name) }));
    }
    activePty = null;
    activeSession = null;
  });
}

// ── WebSocket connection ───────────────────────────────────────────────────

function connect() {
  const url = `${RELAY_URL}?role=agent`;

  ws = new WebSocket(url, {
    key:  fs.readFileSync(AGENT_KEY),
    cert: fs.readFileSync(AGENT_CERT),
    // CA_CERT is used by the relay to verify client certs - not needed here.
    // Server cert is verified against system trusted CAs (Let's Encrypt etc.)
    rejectUnauthorized: true,
  });

  ws.on('open', () => {
    reconnectDelay = RECONNECT_BASE;
    console.log(`[INFO] Connected to relay as '${AGENT_NAME}'`);

    const sessions = discoverSessions().map(s => s.name);
    ws.send(JSON.stringify({ type: 'session_list', sessions }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'attach') {
      attachSession(msg.session, msg.cols, msg.rows);

    } else if (msg.type === 'input') {
      if (activePty) {
        // Decode UTF-8 bytes from base64 back to string
        activePty.write(Buffer.from(msg.data, 'base64').toString('utf8'));
      }

    } else if (msg.type === 'resize') {
      if (activePty && msg.cols > 0 && msg.rows > 0) {
        activePty.resize(msg.cols, msg.rows);
      }

    } else if (msg.type === 'detach') {
      detachCurrent();
    }
  });

  ws.on('close', (code, reason) => {
    detachCurrent();
    console.log(`[INFO] Disconnected (${code}). Reconnecting in ${reconnectDelay}ms...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  });

  ws.on('error', (err) => {
    console.error(`[ERROR] WebSocket: ${err.message}`);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function btoa(str) { return Buffer.from(str).toString('base64'); }
function atob(b64) { return Buffer.from(b64, 'base64').toString('binary'); }

// ── Start ──────────────────────────────────────────────────────────────────

console.log(`[INFO] Agent '${AGENT_NAME}' starting...`);
connect();
