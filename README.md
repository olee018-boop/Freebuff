# Web Proxy

A zero-dependency **HTTP/HTTPS forward proxy** in Node.js, with a small browser dashboard and
a "fetch a page" preview. It is built to run on a server — including a **GitHub Codespace**.

```
Browser / curl / app  ──►  this proxy  ──►  target site
```

## Features

- **HTTP forwarding** — plain `http://` requests with all methods, headers and bodies.
- **HTTPS tunnelling** — `CONNECT` support, so TLS stays end-to-end; works with `curl`, browsers, `git`, package managers, etc.
- **Browser dashboard** at `/` — status, quick-fetch a URL, copy-paste commands.
- **Optional Basic proxy auth** via `PROXY_USER` / `PROXY_PASS`.
- **SSRF protection on by default** — refuses targets on loopback / private / link-local / cloud-metadata addresses (`BLOCK_PRIVATE_TARGETS=0` to disable).
- **Health endpoint** at `/__health` for uptime checks.
- **Zero dependencies** and no build step; Node 18+.
- **Codespaces-ready** — `.devcontainer` forwards port `8080` and starts the server on boot.

---

## Quick start in a GitHub Codespace

1. Push this repo (already done) and open it on GitHub.
2. Click **Code → Codespaces → Create codespace on `main`**.
   The dev container installs nothing (zero dependencies) and `scripts/dev-start.sh` starts the proxy
   automatically. Check it:

   ```bash
   curl -s localhost:8080/__health
   ```

   If it is not running: `npm start` (or `npm run dev` for auto-restart).
3. Open the **Ports** tab in VS Code (bottom panel) — port **8080** is forwarded automatically.
   Hover it, copy the **Forwarded Address** (looks like
   `https://<codespace-name>-8080.app.github.dev`).
4. Use it from your machine:

   ```bash
   curl -x https://<codespace-name>-8080.app.github.dev https://api.ipify.org
   ```

   > Port visibility is **private** by default. To reach it from outside the browser session, either
   > make the port public (right-click 8080 → *Port Visibility* → *Public*) **and set a password**
   > (see [Authentication](#authentication)), or forward it to your computer (next section).

### Use it in a browser (recommended)

Browsers don't accept `https://` proxy URLs, so forward the port to your laptop and point the
browser at plain `http://localhost:8080`:

```bash
gh codespace ports forward 8080:8080 -c <codespace-name>
```

Then in your browser / OS network settings choose **Manual proxy configuration**:

| Setting | Value |
| --- | --- |
| HTTP proxy | `localhost` port `8080` |
| HTTPS proxy | `localhost` port `8080` |
| SOCKS | leave empty |

On Windows: *Settings → Network & Internet → Proxy → Manual proxy setup*.
On macOS: *System Settings → Network → Details → Proxies*.
On Linux/GNOME: *Settings → Network → Network Proxy → Manual*.
Firefox: *Settings → Network Settings → Manual proxy configuration*.

You can also launch a separate browser profile through the proxy without touching system settings:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --proxy-server="http://localhost:8080" --user-data-dir=/tmp/proxy-profile

# Linux
google-chrome --proxy-server="http://localhost:8080" --user-data-dir=/tmp/proxy-profile

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --proxy-server="http://localhost:8080" --user-data-dir="$env:TEMP\proxy-profile"
```

## Run it locally / on any server

```bash
npm start          # node server.js
# or
PORT=9000 npm start
```

Then open <http://localhost:8080> for the dashboard.

On a VPS, keep it alive with systemd, `tmux`, `screen`, `nohup node server.js &`, or a process
manager such as PM2. Open the chosen port in your firewall. **Set a password before exposing it.**

## Use it as a proxy

```bash
# one-off
curl -x http://localhost:8080 https://example.com
curl -x http://localhost:8080 http://example.com

# with authentication
curl -x http://localhost:8080 -U proxyuser:s3cret https://example.com

# environment variables (curl, git, npm, pip, apt, docker, …)
export HTTP_PROXY=http://localhost:8080
export HTTPS_PROXY=http://localhost:8080
curl https://example.com
```

In a Codespace the forwarded URL uses TLS, so pass it as an **HTTPS proxy** (curl ≥ 7.52):

```bash
curl -x https://<codespace-name>-8080.app.github.dev https://example.com
```

Quick check that traffic really leaves through the proxy:

```bash
curl -x http://localhost:8080 https://api.ipify.org; echo
```

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | Dashboard (status, quick fetch, instructions) |
| `/__health` | JSON health/uptime/stats |
| `/fetch?url=…` | Fetch a URL server-side and render it (HTML gets a `<base>` so assets resolve) |
| anything else | Treated as a proxy request (absolute URL required) / 404 |

`/fetch` is a convenience preview, not a full rewriting proxy: scripts that make cross-origin
requests, logins, and relative redirects on some sites may not work. Use the forward proxy for
real browsing.

## Configuration

All configuration is environment variables (a `.env` file is loaded automatically on Node 20.6+).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address (keep `0.0.0.0` for Codespaces) |
| `PROXY_USER` | *(empty)* | Username for Basic proxy auth; empty = no auth |
| `PROXY_PASS` | *(empty)* | Password for Basic proxy auth |
| `BLOCK_PRIVATE_TARGETS` | `1` | `1` blocks loopback/private/link-local/metadata targets |
| `LOG_REQUESTS` | `1` | Log each request to stdout |
| `MAX_FETCH_BYTES` | `5242880` | Max body size for `/fetch` |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Idle timeout for forwarded HTTP requests |
| `FETCH_TIMEOUT_MS` | `20000` | Timeout for `/fetch` |

### Authentication

```bash
PROXY_USER=proxyuser PROXY_PASS='a-long-random-password' npm start
```

or copy `.env.example` to `.env` and fill it in. Clients then send
`Proxy-Authorization: Basic …` (curl: `-U proxyuser:password`). Requests without valid
credentials get `407 Proxy Authentication Required`.

> Credentials are sent in an HTTP header. If the proxy is on the public internet, put it behind
> TLS (e.g. the Codespaces `https://…app.github.dev` URL, or a reverse proxy such as Caddy/nginx
> with a certificate) so the password is not sent in clear text.

## Security notes

* A publicly reachable proxy without a password is an **open proxy** — it will be found and abused.
  Set `PROXY_USER`/`PROXY_PASS` and keep the Codespaces port **private** unless you need it public.
* Private-address blocking prevents the proxy being used to reach the Codespace's own services or
  cloud metadata endpoints. It is a good default; disable it only on trusted networks.
* Requests are logged to stdout (`LOG_REQUESTS=0` to disable). Logs may contain visited URLs.
* GitHub Codespaces have an idle timeout (30 minutes by default) and monthly hour limits; the proxy
  stops when the codespace stops. You can raise the timeout in your
  [Codespaces settings](https://github.com/settings/codespaces).
* Limitations: plain-text WebSocket upgrades (`ws://` through the HTTP proxy) are not forwarded;
  `wss://` works because it is tunnelled with `CONNECT`. No caching, no response rewriting, and no
  anonymity guarantees.

## Tests

```bash
npm test
```

The integration tests start a local origin server and exercise HTTP forwarding, POST bodies,
`CONNECT` tunnelling, Basic auth (including `CONNECT` rejection), SSRF blocking, `/fetch` HTML
base-tag injection, the dashboard, and `/__health`.

## Project layout

```
server.js                  proxy, dashboard and CLI (no dependencies)
test/proxy.test.js         integration tests (node:test)
scripts/dev-start.sh       background start used by the dev container
.devcontainer/             Codespaces config: forwards 8080, starts the server
.env.example               configuration template
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `502 Bad Gateway` | Target unreachable / DNS failed / certificate problem |
| `403 Forbidden: private…` | Target resolved to a private IP; set `BLOCK_PRIVATE_TARGETS=0` if intended |
| `407 Proxy Authentication Required` | Set credentials or unset `PROXY_USER`/`PROXY_PASS` |
| Forwarded URL asks for GitHub sign-in | Port is private; make it public or use `gh codespace ports forward` |
| Connection refused from your machine | Server not listening on `0.0.0.0`, port not forwarded, or codespace stopped |
| Browser refuses `https://…app.github.dev` as a proxy URL | Expected — browsers need `http://host:port`; forward the port locally |
| Codespace sleeps and proxy dies | Raise the idle timeout; restart with `npm start` |
