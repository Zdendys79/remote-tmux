require('dotenv').config();
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');

const PORT_BROWSER = parseInt(process.env.PORT_BROWSER || '7901'); // plain HTTP, behind Apache
const PORT_AGENT   = parseInt(process.env.PORT_AGENT   || '7902'); // HTTPS+mTLS, direct
const CA_CERT      = process.env.CA_CERT;
const SERVER_KEY   = process.env.SERVER_KEY;
const SERVER_CRT   = process.env.SERVER_CRT;
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;

for (const v of ['CA_CERT', 'SERVER_KEY', 'SERVER_CRT', 'CLIENT_TOKEN']) {
  if (!process.env[v]) { console.error(`[ERROR] ${v} not set`); process.exit(1); }
}

const PING_INTERVAL = 30_000;

// agent entry: { ws, name, sessions, client }
const agents  = new Map();
const clients = new Set();

// ── Browser server (plain HTTP, port 7901) ─────────────────────────────────

const browserServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('remote-tmux relay');
});

const wssBrowser = new WebSocketServer({ server: browserServer });

wssBrowser.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token  = params.get('token');

  console.log(`[INFO] Browser WS connected, agents: ${agents.size}`);

  if (token !== CLIENT_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  handleClient(ws);
});

browserServer.listen(PORT_BROWSER, '127.0.0.1', () => {
  console.log(`[INFO] Browser WS listening on 127.0.0.1:${PORT_BROWSER}`);
});

// ── Agent server (HTTPS+mTLS, port 7902) ──────────────────────────────────

const agentServer = https.createServer({
  key:  fs.readFileSync(SERVER_KEY),
  cert: fs.readFileSync(SERVER_CRT),
  ca:   fs.readFileSync(CA_CERT),
  requestCert:        true,
  rejectUnauthorized: true, // agents MUST present valid cert
});

agentServer.on('request', (req, res) => {
  res.writeHead(200);
  res.end('remote-tmux agent endpoint');
});

const wssAgent = new WebSocketServer({ server: agentServer });

wssAgent.on('connection', (ws, req) => {
  const cert = req.socket.getPeerCertificate();
  const name = cert?.subject?.CN;
  if (!name) { ws.close(4001, 'Valid client certificate required'); return; }
  handleAgent(ws, name);
});

agentServer.listen(PORT_AGENT, () => {
  console.log(`[INFO] Agent WSS (mTLS) listening on 0.0.0.0:${PORT_AGENT}`);
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
    name: a.name, sessions: a.sessions, busy: !!a.client,
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
