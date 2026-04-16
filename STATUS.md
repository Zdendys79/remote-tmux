# Status

**Last updated:** 2026-04-16
**Phase:** Production

## Done

- [x] Relay server (`relay/server.js`) — two ports: 7901 (browser WS) + 7902 (agent mTLS)
- [x] Agent script (`agent/agent.js`) — node-pty, auto-reconnect, tmux + TTY support
- [x] Web frontend — xterm.js, two-panel PC layout, single-panel mobile/portrait
- [x] Apache vhost for `tmux.zdendys79.website`
- [x] PM2 config for relay server on base7
- [x] Agent install script (`curl https://tmux.zdendys79.website/setup | sudo bash`)
- [x] Custom CA + per-agent mTLS certificates (`scripts/setup-ca.sh`, `scripts/issue-cert.sh`)
- [x] Token auth for browser clients (localStorage)
- [x] Unicode / diacritics support (input + output)
- [x] Responsive layout: portrait / width < 1400px → single panel, wider → two panels
- [x] Tab drag-and-drop between panels
- [x] Tab merge/split on layout change
- [x] Already-open sessions marked in connect dialog
- [x] Text input bar (expandable textarea, Enter sends, Shift+Enter = newline)
- [x] Base7 agent deployed and running
- [x] JZ-work agent deployed and running

## Known Issues

None.

## Decisions

| Decision | Reason |
|----------|--------|
| Node.js for relay + agent | node-pty is the best PTY library available |
| Two ports (7901/7902) | Browser behind Apache reverse proxy; agents use direct mTLS |
| mTLS for agents | Strong auth without shared secrets; agent CN = agent name |
| Outbound-only agents | Handles NAT/private IPs transparently |
| Browser token in localStorage | Simple, sufficient for private use |
| Agent runs as real user | tmux socket is per-user (`/tmp/tmux-UID/default`) |
| `NODE_EXTRA_CA_CERTS` not needed | Removing `ca:` option from agent WS lets Node.js use system CAs |
