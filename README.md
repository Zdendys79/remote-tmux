# Remote Tmux

Web-based relay for accessing tmux sessions from any machine — including those behind NAT/private IP.

## Idea

Similar to Chrome Remote Desktop, but for tmux. All sessions accessible at `tmux.zdendys79.website`.

## How It Works

```
[Machine A - private IP]
  agent → WebSocket (outbound) → relay on base7 ← browser

[Machine B - private IP]
  agent → WebSocket (outbound) → relay on base7 ← browser
```

Agents initiate outbound connections → works even behind NAT/firewall.

## Components

| Component | Location | Description |
|-----------|----------|-------------|
| Relay server | base7 (`/home/remotes/remote-tmux/relay/`) | Node.js WebSocket server, routes data between agents and browsers |
| Agent | each remote machine | Small script, connects to relay, streams tmux I/O |
| Web frontend | base7 (`/var/www/html/remote-tmux/`) | xterm.js terminal in browser, session list |

## Tech Stack

- **Backend:** Node.js, `ws` (WebSocket), `node-pty`
- **Frontend:** xterm.js, vanilla JS
- **Process manager:** PM2
- **Web server:** Apache reverse proxy → tmux.zdendys79.website

## URL

`https://tmux.zdendys79.website`

## Status

See [STATUS.md](STATUS.md)
