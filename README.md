# remote-tmux

Web-based relay that exposes tmux sessions from machines behind NAT to a browser.
Similar to Chrome Remote Desktop, but for tmux — no VPN, no open ports on remote machines.

```
[Machine behind NAT]          [Relay server]          [Browser]
  agent (node-pty)  ──WSS──►  relay (Node.js)  ◄──WSS──  xterm.js
```

Agents initiate **outbound** connections → works behind any NAT or firewall.

---

## Features

- Full xterm.js terminal in the browser
- Multiple agents (machines), multiple tmux sessions per agent
- Two-panel layout on wide screens, single panel on mobile/portrait
- Drag-and-drop tabs between panels
- Text input bar for diacritics and mobile IME
- mTLS authentication for agents (client certificates)
- Token authentication for browser clients

---

## Requirements

| Component | Where |
|-----------|-------|
| Relay server | A VPS or server with a public domain name |
| TLS certificate | For the relay domain (Let's Encrypt recommended) |
| Node.js 18+ | Relay server + each agent machine |
| tmux | Each agent machine |
| conspy | Each agent machine (only for TTY console access) |

## Dependencies

**Relay** (`relay/package.json`):

| Package | Version | Purpose |
|---------|---------|---------|
| [ws](https://github.com/websockets/ws) | ^8.18 | WebSocket server |
| [dotenv](https://github.com/motdotla/dotenv) | ^16.4 | Load `.env` config |

**Agent** (`agent/package.json`):

| Package | Version | Purpose |
|---------|---------|---------|
| [ws](https://github.com/websockets/ws) | ^8.18 | WebSocket client |
| [node-pty](https://github.com/microsoft/node-pty) | ^1.0 | Spawn and attach to PTY (tmux, TTY) |
| [dotenv](https://github.com/motdotla/dotenv) | ^16.4 | Load `.env` config |

**Frontend** (no build step, loaded from CDN):

| Library | Version | Purpose |
|---------|---------|---------|
| [xterm.js](https://xtermjs.org/) | 5.3.0 | Terminal emulator in browser |
| [xterm-addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | 0.8.0 | Auto-resize terminal to container |

> `node-pty` requires native compilation — `npm install` needs build tools (`python3`, `make`, `g++`).
> On Ubuntu/Debian: `sudo apt-get install build-essential python3`

---

## Relay Server Setup

### 1. Clone the repository

```bash
git clone https://github.com/Zdendys79/remote-tmux.git
cd remote-tmux
```

### 2. TLS Certificate

The relay uses two ports:
- **Port for browsers** (default 7901) — plain HTTP, sits behind a reverse proxy that terminates TLS
- **Port for agents** (default 7902) — HTTPS with mTLS, needs a real TLS certificate

**Option A: Let's Encrypt wildcard or domain cert (recommended)**

```bash
# Already have a cert? Set paths in relay/.env (see step 4)
# Get a new cert with certbot:
certbot certonly --standalone -d tmux.yourdomain.com
# Certificate: /etc/letsencrypt/live/tmux.yourdomain.com/fullchain.pem
# Key:         /etc/letsencrypt/live/tmux.yourdomain.com/privkey.pem
```

**Option B: Self-signed certificate**

Use this if you don't have a domain, or for testing:

```bash
mkdir -p certs
# Generate self-signed cert valid for 10 years
openssl req -x509 -newkey rsa:4096 -keyout certs/relay.key -out certs/relay.crt \
  -days 3650 -nodes -subj "/CN=relay.local"
```

> **Note:** With a self-signed cert, agents must set `NODE_EXTRA_CA_CERTS` pointing to
> `relay.crt` so they can verify the relay server. Add to the agent's systemd service:
> `Environment=NODE_EXTRA_CA_CERTS=/etc/remote-tmux/relay.crt`
> and copy `relay.crt` to `/etc/remote-tmux/` on each agent machine alongside its client cert.

### 3. Create the custom CA for agent certificates

```bash
scripts/setup-ca.sh
# Creates: certs/ca.key (private, never share), certs/ca.crt (public)
```

### 4. Configure relay

```bash
cd relay
cp .env.example .env
```

Edit `.env`:

```env
PORT_BROWSER=7901          # browser WS port (behind reverse proxy)
PORT_AGENT=7902            # agent mTLS port (public)

# TLS for port 7902 — use Let's Encrypt or self-signed paths from step 2
SERVER_KEY=/etc/letsencrypt/live/tmux.yourdomain.com/privkey.pem
SERVER_CRT=/etc/letsencrypt/live/tmux.yourdomain.com/fullchain.pem

CA_CERT=/path/to/remote-tmux/certs/ca.crt   # custom CA for verifying agent certs

CLIENT_TOKEN=change_me_to_a_random_secret   # browser login token
```

Generate a random token:
```bash
openssl rand -hex 32
```

### 5. Install dependencies and start

```bash
npm install
# with PM2:
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

### 6. Apache reverse proxy (for browser access)

Copy the example vhost and adjust domain + paths:

```bash
cp tmux.zdendys79-website.conf /etc/apache2/sites-available/tmux.yourdomain.conf
# Edit ServerName and paths, then:
a2enmod proxy proxy_http proxy_wstunnel rewrite ssl
a2ensite tmux.yourdomain
systemctl reload apache2
```

The vhost proxies WebSocket connections (`/ws`) to `localhost:7901` and serves the frontend
from `DocumentRoot`.

Copy frontend files to document root:

```bash
cp -r frontend/* /var/www/html/remote-tmux/
cp agent/agent.js agent/package.json /var/www/html/remote-tmux/agent/
cp agent/setup.sh /var/www/html/remote-tmux/setup
```

---

## Issue an Agent Certificate

For each machine that will connect as an agent:

```bash
scripts/issue-cert.sh my-machine-name
# Creates: certs/my-machine-name.key, certs/my-machine-name.crt
# Copy both files + certs/ca.crt to the agent machine
```

---

## Agent Setup (remote machine)

```bash
curl https://tmux.yourdomain.com/setup | sudo bash
```

The script will:
1. Install Node.js 22 if missing
2. Ask for agent name (must match the CN of the certificate)
3. Ask where the 3 certificate files are (`name.key`, `name.crt`, `ca.crt`)
4. Install the agent to `/opt/remote-tmux-agent/`
5. Create a systemd service running as the current user (so tmux sessions are visible)

---

## Security Model

| Layer | Method |
|-------|--------|
| Agent → Relay | mTLS: each agent has a unique client certificate signed by the custom CA |
| Browser → Relay | Shared token stored in localStorage |
| Relay → Browser | TLS via Apache (Let's Encrypt) |
| Relay → Agent port | TLS with the relay's server certificate |

The agent name shown in the UI is the CN from its certificate — it cannot be spoofed.

---

## Troubleshooting

**Agent fails with `unable to get local issuer certificate`**

The agent's `agent.js` must not pass a `ca:` option to the WebSocket constructor.
If using a self-signed relay certificate, set `NODE_EXTRA_CA_CERTS` in the systemd service:

```ini
Environment=NODE_EXTRA_CA_CERTS=/etc/remote-tmux/relay.crt
```

**TTY session fails with `execvp(3) failed.: No such file or directory`**

`conspy` is not installed. Fix:
```bash
sudo apt-get install conspy
sudo usermod -aG tty YOUR_USER
sudo systemctl restart remote-tmux-agent
```
The install script handles this automatically on new installations.

**Agent connects but shows no sessions**

The agent must run as the user whose tmux sessions you want to access.
The install script detects `SUDO_USER` automatically. If the service runs as root,
tmux won't find sessions belonging to other users (different socket at `/tmp/tmux-UID/default`).

**Diacritics / special characters broken**

Ensure the relay and agent are on a current Node.js version (18+).
The agent encodes PTY output as UTF-8 base64 (`Buffer.from(str)`).

---

## File Layout

```
relay/
  server.js          # Relay — two WS pools (agents + browsers)
  .env.example
  ecosystem.config.js
agent/
  agent.js           # Agent — connects to relay, wraps tmux via node-pty
  setup.sh           # Install script (curl | sudo bash)
  .env.example
frontend/
  index.html
  terminal.js
  style.css
scripts/
  setup-ca.sh        # One-time: create custom CA
  issue-cert.sh      # Per-agent: issue client certificate
```
