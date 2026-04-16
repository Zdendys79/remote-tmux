# Architecture

## Overview

```
Browser
  |
  | HTTPS/WSS
  v
Apache (tmux.zdendys79.website)
  |
  | reverse proxy
  v
Relay Server :3456 (Node.js on base7)
  |             |
  | WSS         | WSS (outbound from agents)
  v             v
[Web clients] [Agents on remote machines]
```

## Relay Server

- Listens on port 3456
- Two types of connections:
  - **Agent** — remote machine, registers itself with a name, streams PTY data
  - **Client** — browser, lists available agents, attaches to a session
- Routes stdin/stdout between client and agent
- Heartbeat ping to detect disconnected agents

### Message Protocol (JSON over WebSocket)

**Agent → Relay:**
```json
{ "type": "register", "name": "botka", "sessions": ["main", "minecraft"] }
{ "type": "output", "data": "<base64 terminal data>" }
{ "type": "session_list", "sessions": ["main", "minecraft"] }
```

**Relay → Agent:**
```json
{ "type": "attach", "session": "main" }
{ "type": "input", "data": "<base64 keystroke>" }
{ "type": "resize", "cols": 220, "rows": 50 }
```

**Client → Relay:**
```json
{ "type": "list" }
{ "type": "connect", "agent": "botka", "session": "main" }
{ "type": "input", "data": "<base64 keystroke>" }
{ "type": "resize", "cols": 220, "rows": 50 }
```

**Relay → Client:**
```json
{ "type": "agents", "list": [{"name": "botka", "sessions": ["main"]}] }
{ "type": "output", "data": "<base64 terminal data>" }
{ "type": "connected", "agent": "botka", "session": "main" }
```

## Agent

- Single Node.js script (or Python fallback)
- Runs on each remote machine
- Spawns `tmux attach-session -t <name>` via node-pty
- Reconnects automatically on disconnect

## Web Frontend

- Single HTML page with embedded JS
- xterm.js for terminal rendering
- Left panel: list of available agents and their sessions
- Click to connect → full interactive terminal in browser

## Security

- Shared secret token between agent and relay (env var `RELAY_TOKEN`)
- Apache handles TLS (existing wildcard cert `*.zdendys79.website`)
- No auth on frontend yet (can add HTTP Basic or access code later)

## File Layout

```
/home/remotes/remote-tmux/
├── README.md
├── ARCHITECTURE.md
├── STATUS.md
├── relay/
│   ├── server.js         # Relay server
│   ├── package.json
│   └── .env.example
├── agent/
│   ├── agent.js          # Agent script
│   ├── package.json
│   ├── install.sh        # Setup script for remote machines
│   └── .env.example
└── frontend/
    ├── index.html
    ├── terminal.js
    └── style.css

/var/www/html/remote-tmux/   # Served by Apache
```
