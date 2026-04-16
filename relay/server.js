require('dotenv').config();
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT || '7901');
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const PING_INTERVAL = 30_000;

if (!RELAY_TOKEN) {
  console.error('[ERROR] RELAY_TOKEN not set');
  process.exit(1);
}

// agent entry: { ws, name, sessions: string[], client: ws|null }
const agents = new Map();

// client entry: { ws, agent: string|null, session: string|null }
const clients = new Set();

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('remote-tmux relay');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://localhost`).searchParams;
  const role = params.get('role');
  const token = params.get('token');

  if (token !== RELAY_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (role === 'agent') {
    handleAgent(ws, params);
  } else if (role === 'client') {
    handleClient(ws);
  } else {
    ws.close(4000, 'Unknown role');
  }
});

// ─── Agent handling ───────────────────────────────────────────────────────────

function handleAgent(ws, params) {
  const name = params.get('name');
  if (!name) { ws.close(4002, 'name required'); return; }

  if (agents.has(name)) {
    console.log(`[INFO] Agent ${name} reconnected, closing old connection`);
    const old = agents.get(name);
    old.ws.close(4010, 'Replaced by new connection');
  }

  const agent = { ws, name, sessions: [], client: null };
  agents.set(name, agent);
  console.log(`[INFO] Agent registered: ${name}`);
  broadcastAgentList();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'output') {
      if (agent.client && agent.client.readyState === WebSocket.OPEN) {
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
      if (agent.client && agent.client.readyState === WebSocket.OPEN) {
        agent.client.send(JSON.stringify({ type: 'agent_disconnected', agent: name }));
      }
      broadcastAgentList();
    }
  });

  // heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

// ─── Client handling ──────────────────────────────────────────────────────────

function handleClient(ws) {
  const client = { ws, agent: null, session: null };
  clients.add(client);

  // send current agent list immediately
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
      // detach previous client from that agent if any
      if (agentEntry.client && agentEntry.client !== ws) {
        agentEntry.client.send(JSON.stringify({ type: 'disconnected', reason: 'replaced' }));
      }
      client.agent = msg.agent;
      client.session = msg.session;
      agentEntry.client = ws;
      agentEntry.ws.send(JSON.stringify({ type: 'attach', session: msg.session }));
      ws.send(JSON.stringify({ type: 'connected', agent: msg.agent, session: msg.session }));
      console.log(`[INFO] Client connected to ${msg.agent}/${msg.session}`);

    } else if (msg.type === 'input') {
      const agentEntry = client.agent ? agents.get(client.agent) : null;
      if (agentEntry && agentEntry.ws.readyState === WebSocket.OPEN) {
        agentEntry.ws.send(JSON.stringify({ type: 'input', data: msg.data }));
      }

    } else if (msg.type === 'resize') {
      const agentEntry = client.agent ? agents.get(client.agent) : null;
      if (agentEntry && agentEntry.ws.readyState === WebSocket.OPEN) {
        agentEntry.ws.send(JSON.stringify({ type: 'resize', cols: msg.cols, rows: msg.rows }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    // detach this client from its agent
    if (client.agent) {
      const agentEntry = agents.get(client.agent);
      if (agentEntry && agentEntry.client === ws) {
        agentEntry.client = null;
        agentEntry.ws.send(JSON.stringify({ type: 'detach' }));
      }
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function agentList() {
  return [...agents.values()].map(a => ({ name: a.name, sessions: a.sessions, busy: !!a.client }));
}

function broadcastAgentList() {
  const msg = JSON.stringify({ type: 'agents', list: agentList() });
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

// ─── Heartbeat (detect dead agent connections) ────────────────────────────────

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

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[INFO] Relay server listening on port ${PORT}`);
});
