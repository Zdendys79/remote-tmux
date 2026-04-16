require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = parseInt(process.env.PORT || '7901');
const CA_CERT    = process.env.CA_CERT;
const SERVER_KEY = process.env.SERVER_KEY;
const SERVER_CRT = process.env.SERVER_CRT;
// Optional: shared token for browser clients (no mTLS in browser)
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;

const PING_INTERVAL = 30_000;

for (const v of ['CA_CERT', 'SERVER_KEY', 'SERVER_CRT']) {
  if (!process.env[v]) { console.error(`[ERROR] ${v} not set`); process.exit(1); }
}
if (!CLIENT_TOKEN) { console.error('[ERROR] CLIENT_TOKEN not set'); process.exit(1); }

// ── HTTPS server with mTLS ─────────────────────────────────────────────────

const httpsServer = https.createServer({
  key:  fs.readFileSync(SERVER_KEY),
  cert: fs.readFileSync(SERVER_CRT),
  ca:   fs.readFileSync(CA_CERT),
  // Agents must present a valid client certificate signed by our CA.
  // Browsers connect without a client cert - handled by role check below.
  requestCert: true,
  rejectUnauthorized: false, // we do manual check per role
});

httpsServer.on('request', (req, res) => {
  res.writeHead(200);
  res.end('remote-tmux relay');
});

// ── WebSocket server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpsServer });

// agent entry: { ws, name, sessions, client }
const agents = new Map();
// client entries
const clients = new Set();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `https://localhost`).searchParams;
  const role   = params.get('role');

  if (role === 'agent') {
    // Agents MUST present a valid client certificate signed by our CA
    const cert = req.socket.getPeerCertificate(true);
    if (!req.socket.authorized || !cert?.subject?.CN) {
      ws.close(4001, 'Valid client certificate required');
      console.log('[WARN] Agent rejected: no valid certificate');
      return;
    }
    const agentName = cert.subject.CN;
    handleAgent(ws, agentName);

  } else if (role === 'client') {
    // Browsers use a shared token instead of mTLS
    const token = params.get('token');
    if (token !== CLIENT_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    handleClient(ws);

  } else {
    ws.close(4000, 'Unknown role');
  }
});

// ── Agent handling ─────────────────────────────────────────────────────────

function handleAgent(ws, name) {
  if (agents.has(name)) {
    console.log(`[INFO] Agent ${name} reconnected, closing old connection`);
    agents.get(name).ws.close(4010, 'Replaced by new connection');
  }

  const agent = { ws, name, sessions: [], client: null };
  agents.set(name, agent);
  console.log(`[INFO] Agent connected: ${name}`);
  broadcastAgentList();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'output') {
      if (agent.client?.readyState === WebSocket.OPEN) {
        agent.client.send(JSON.stringify({ type: 'output', data: msg.data }));
      }
    } else if (msg.type === 'session_list') {
      agent.sessions = msg.sessions || [];
      console.log(`[INFO] Agent ${name} sessions: ${agent.sessions.join(', ')}`);
      broadcastAgentList();
    }
  });

  ws.on('close', () => {
    if (agents.get(name) === agent) {
      agents.delete(name);
      console.log(`[INFO] Agent disconnected: ${name}`);
      if (agent.client?.readyState === WebSocket.OPEN) {
        agent.client.send(JSON.stringify({ type: 'agent_disconnected', agent: name }));
      }
      broadcastAgentList();
    }
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

// ── Client handling ────────────────────────────────────────────────────────

function handleClient(ws) {
  const client = { ws, agent: null, session: null };
  clients.add(client);

  ws.send(JSON.stringify({ type: 'agents', list: agentList() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'list') {
      ws.send(JSON.stringify({ type: 'agents', list: agentList() }));

    } else if (msg.type === 'connect') {
      const agentEntry = agents.get(msg.agent);
      if (!agentEntry) {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' }));
        return;
      }
      if (agentEntry.client && agentEntry.client !== ws) {
        agentEntry.client.send(JSON.stringify({ type: 'disconnected', reason: 'replaced' }));
      }
      client.agent   = msg.agent;
      client.session = msg.session;
      agentEntry.client = ws;
      agentEntry.ws.send(JSON.stringify({ type: 'attach', session: msg.session }));
      ws.send(JSON.stringify({ type: 'connected', agent: msg.agent, session: msg.session }));
      console.log(`[INFO] Client connected to ${msg.agent}/${msg.session}`);

    } else if (msg.type === 'input') {
      const agentEntry = client.agent ? agents.get(client.agent) : null;
      if (agentEntry?.ws.readyState === WebSocket.OPEN) {
        agentEntry.ws.send(JSON.stringify({ type: 'input', data: msg.data }));
      }

    } else if (msg.type === 'resize') {
      const agentEntry = client.agent ? agents.get(client.agent) : null;
      if (agentEntry?.ws.readyState === WebSocket.OPEN) {
        agentEntry.ws.send(JSON.stringify({ type: 'resize', cols: msg.cols, rows: msg.rows }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    if (client.agent) {
      const agentEntry = agents.get(client.agent);
      if (agentEntry?.client === ws) {
        agentEntry.client = null;
        agentEntry.ws.send(JSON.stringify({ type: 'detach' }));
      }
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function agentList() {
  return [...agents.values()].map(a => ({
    name: a.name,
    sessions: a.sessions,
    busy: !!a.client,
  }));
}

function broadcastAgentList() {
  const msg = JSON.stringify({ type: 'agents', list: agentList() });
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

const pingTimer = setInterval(() => {
  for (const agent of agents.values()) {
    if (!agent.ws.isAlive) {
      console.log(`[INFO] Agent ${agent.name} timed out`);
      agent.ws.terminate();
      continue;
    }
    agent.ws.isAlive = false;
    agent.ws.ping();
  }
}, PING_INTERVAL);

wss.on('close', () => clearInterval(pingTimer));

// ── Start ──────────────────────────────────────────────────────────────────

httpsServer.listen(PORT, () => {
  console.log(`[INFO] Relay server (mTLS) listening on port ${PORT}`);
});
