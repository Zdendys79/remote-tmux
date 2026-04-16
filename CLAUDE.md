# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Inherits from:** `/home/remotes/CLAUDE.md`

## Project

Web-based relay that exposes tmux sessions from machines behind NAT to a browser at `https://tmux.zdendys79.website`. Agents on remote machines initiate outbound WebSocket connections to a relay on base7; browsers connect to the same relay and get a full xterm.js terminal.

## Architecture

```
Browser (xterm.js)
  ↕ WSS
Apache reverse proxy (tmux.zdendys79.website → localhost:3456)
  ↕ WSS
Relay server — Node.js, port 3456   (/home/remotes/remote-tmux/relay/server.js)
  ↕ WSS (outbound from agents)
Agent — Node.js + node-pty          (deployed on each remote machine)
  ↕ PTY
tmux session on the remote machine
```

The relay maintains two connection pools: **agents** (remote machines, register by name) and **clients** (browsers). It routes stdin/stdout between a matched pair.

## Message Protocol (JSON over WebSocket)

Agent → Relay: `register`, `output` (base64), `session_list`  
Relay → Agent: `attach`, `input` (base64), `resize`  
Client → Relay: `list`, `connect`, `input` (base64), `resize`  
Relay → Client: `agents`, `output` (base64), `connected`

Full message shapes are in `ARCHITECTURE.md`.

## File Layout

```
relay/
  server.js        # Relay server — two WebSocket pools, routing logic
  package.json
  .env.example     # RELAY_TOKEN, PORT
agent/
  agent.js         # Connects to relay, wraps tmux via node-pty, auto-reconnects
  package.json
  install.sh       # Sets up agent on a remote machine
  .env.example     # RELAY_URL, RELAY_TOKEN, AGENT_NAME
frontend/
  index.html       # Single page, session list + xterm.js terminal
  terminal.js
  style.css

/var/www/html/remote-tmux/   # Apache document root (copy/symlink frontend here)
```

## Key Details

- **Auth:** shared `RELAY_TOKEN` env var checked on WebSocket handshake (agent side); no frontend auth yet
- **TLS:** handled by Apache with wildcard cert `*.zdendys79.website`
- **Process manager:** PM2 for the relay server on base7
- **PTY library:** `node-pty` — requires native build (`npm install` needs build tools)
- **Agent resilience:** must auto-reconnect with backoff when relay is unreachable

## Running the Relay (base7)

```bash
cd /home/remotes/remote-tmux/relay
npm install
cp .env.example .env   # fill in RELAY_TOKEN
node server.js         # or: pm2 start server.js --name remote-tmux-relay
```

## Deploying an Agent (remote machine)

```bash
bash install.sh        # clones/copies agent, sets up .env, registers with PM2
```

## Current Status

Planning phase — no code written yet. See `STATUS.md` for the implementation checklist.
