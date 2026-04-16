# Status

**Last updated:** 2026-04-16
**Phase:** Planning / initial setup

## Done

- [x] Project directory created (`~/remote-tmux/`)
- [x] Architecture designed (relay + agent + frontend)
- [x] Protocol draft (JSON over WebSocket)

## Todo

- [ ] Relay server (`relay/server.js`)
- [ ] Agent script (`agent/agent.js`)
- [ ] Web frontend (`frontend/index.html` + xterm.js)
- [ ] Apache vhost for `tmux.zdendys79.website`
- [ ] PM2 config for relay server
- [ ] Agent install script for remote machines
- [ ] Test: base7 → base7 (loopback)
- [ ] Test: Botka (private IP) → base7

## Known Issues

None yet.

## Decisions

| Decision | Reason |
|----------|--------|
| Node.js for relay + agent | node-pty is the best PTY library available |
| WebSocket over raw TCP | Works through firewalls, easy to proxy via Apache |
| Outbound-only agents | Handles NAT/private IPs transparently |
| Shared token auth | Simple, sufficient for private use |
