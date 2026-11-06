#!/usr/bin/env node
/**
 * Web Proxy — a zero-dependency HTTP/HTTPS forward proxy with a small browser page.
 *
 *   node server.js
 *
 * Then:
 *   - open http://localhost:8080 for the dashboard / quick fetch
 *   - use it as a proxy:  curl -x http://localhost:8080 https://example.com
 *
 * Configuration is via environment variables (see README.md and .env.example).
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';

/** Headers that must never be forwarded by an HTTP proxy (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/* ------------------------------------------------------------------ config */

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Create the proxy server without starting it.
 * Options override the matching environment variables, which is handy for tests.
 */
export function createProxyServer(options = {}) {
  const config = {
    port: options.port ?? envInt('PORT', 8080),
    host: options.host ?? process.env.HOST ?? '0.0.0.0',
    proxyUser: options.proxyUser ?? process.env.PROXY_USER ?? '',
    proxyPass: options.proxyPass ?? process.env.PROXY_PASS ?? '',
    blockPrivateTargets: options.blockPrivateTargets ?? envFlag('BLOCK_PRIVATE_TARGETS', true),
    maxFetchBytes: options.maxFetchBytes ?? envInt('MAX_FETCH_BYTES', 5 * 1024 * 1024),
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? envInt('UPSTREAM_TIMEOUT_MS', 30_000),
    fetchTimeoutMs: options.fetchTimeoutMs ?? envInt('FETCH_TIMEOUT_MS', 20_000),
    logRequests: options.logRequests ?? envFlag('LOG_REQUESTS', true),
    userAgent:
      options.userAgent ??
      'Mozilla/5.0 (compatible; WebProxy/1.0; +https://github.com/olee018-boop/Freebuff)',
  };

  const state = { startedAt: Date.now(), forwarded: 0, tunnels: 0, blocked: 0 };
  const authRequired = config.proxyUser !== '';

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, state).catch((err) => {
      if (!res.headersSent) sendText(res, 500, `Internal proxy error: ${err.message}`);
      else res.destroy();
    });
  });

  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, head, config, state).catch(() => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  // Exposed for the CLI banner, /__health and the test suite.
  server.proxyConfig = config;
  server.proxyState = state;
  server.authRequired = authRequired;

  return server;
}

/* ------------------------------------------------------------- dispatcher */

async function handleRequest(req, res, config, state) {
  const startedAt = Date.now();
  const rawUrl = req.url || '/';

  if (config.logRequests) {
    res.on('finish', () => {
      console.log(
        `[proxy] ${req.method} ${rawUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
      );
    });
  }

  const isAbsoluteForm = /^https?:\/\//i.test(rawUrl);

  if (!isAbsoluteForm) {
    handleLocal(req, res, rawUrl, config, state);
    return;
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    sendText(res, 400, 'Bad Request: invalid absolute URL.');
    return;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendText(res, 400, 'Bad Request: only http and https URLs are supported.');
    return;
  }

  if (!isAuthorized(req, config)) {
    challenge(res);
    return;
  }

  if (await isBlockedHost(target.hostname, config)) {
    state.blocked += 1;
    sendText(
      res,
      403,
      `Forbidden: ${target.hostname} is a private, loopback or link-local address.\n` +
        'Set BLOCK_PRIVATE_TARGETS=0 to allow internal targets.',
    );
    return;
  }

  state.forwarded += 1;
  forwardHttp(req, res, target, config);
}

/* -------------------------------------------------------------- local UI */

function handleLocal(req, res, rawUrl, config, state) {
  let requestUrl;
  try {
    requestUrl = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad Request.');
    return;
  }

  if (requestUrl.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    sendHtml(res, 200, landingPage(req, config, state));
    return;
  }

  if (requestUrl.pathname === '/__health') {
    sendJson(res, 200, {
      ok: true,
      name: 'web-proxy',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
      authRequired: config.proxyUser !== '',
      blockPrivateTargets: config.blockPrivateTargets,
      forwarded: state.forwarded,
      tunnels: state.tunnels,
      blocked: state.blocked,
    });
    return;
  }

  if (requestUrl.pathname === '/fetch') {
    handleFetch(req, res, requestUrl.searchParams.get('url'), config, state).catch((err) => {
      if (!res.headersSent) sendText(res, 502, `Fetch failed: ${err.message}`);
      else res.destroy();
    });
    return;
  }

  sendText(res, 404, 'Not found. This is a proxy: send absolute URLs, or open / for the dashboard.');
}

/* ------------------------------------------------------- HTTP forwarding */

function forwardHttp(req, res, target, config) {
  const headers = filterHeaders(req.headers);
  headers.host = target.host;

  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: stripBrackets(target.hostname),
      port: target.port || undefined,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, filterHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    },
  );

  upstream.setTimeout(config.upstreamTimeoutMs, () => {
    upstream.destroy(new Error('upstream timed out'));
  });

  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendText(res, 502, `Bad Gateway: ${err.message}`);
  });

  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}

/* ------------------------------------------------------- HTTPS tunnelling */

async function handleConnect(req, socket, head, config, state) {
  socket.on('error', () => {});

  if (!isAuthorized(req, config)) {
    socket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="Web Proxy", charset="UTF-8"\r\n' +
        'Content-Length: 0\r\n' +
        'Connection: close\r\n\r\n',
    );
    return;
  }

  const authority = parseAuthority(req.url || '');
  if (!authority) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }

  if (await isBlockedHost(authority.host, config)) {
    state.blocked += 1;
    const reason = 'Forbidden: private/loopback targets are blocked (BLOCK_PRIVATE_TARGETS=0).';
    socket.end(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n' +
        `Content-Length: ${Buffer.byteLength(reason)}\r\nConnection: close\r\n\r\n` +
        reason,
    );
    return;
  }

  if (socket.destroyed) return;

  let established = false;
  const upstream = net.connect({ host: authority.host, port: authority.port }, () => {
    established = true;
    state.tunnels += 1;
    socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: WebProxy\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    if (!established && !socket.destroyed) {
      socket.end(
        'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ' +
          Buffer.byteLength(`Bad Gateway: ${err.message}`) +
          '\r\nConnection: close\r\n\r\n' +
          `Bad Gateway: ${err.message}`,
      );
    } else {
      socket.destroy();
    }
  });

  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

/* --------------------------------------------------- browser quick fetch */

async function handleFetch(req, res, rawUrl, config, state) {
  if (!isAuthorized(req, config)) {
    challenge(res);
    return;
  }

  if (!rawUrl) {
    sendText(res, 400, 'Missing "url" query parameter, e.g. /fetch?url=https://example.com');
    return;
  }

  let target;
  try {
    target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    sendText(res, 400, 'Invalid URL.');
    return;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendText(res, 400, 'Only http and https URLs can be fetched.');
    return;
  }

  if (await isBlockedHost(target.hostname, config)) {
    state.blocked += 1;
    sendText(
      res,
      403,
      `Forbidden: ${target.hostname} is a private, loopback or link-local address.`,
    );
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': config.userAgent,
        accept: req.headers.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
  } catch (err) {
    sendText(res, 502, `Could not fetch ${target.href}\n${err.message}`);
    return;
  }

  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > config.maxFetchBytes) {
    sendText(res, 413, `Response too large (${declaredLength} bytes).`);
    return;
  }

  const chunks = [];
  let total = 0;
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        total += chunk.length;
        if (total > config.maxFetchBytes) {
          await upstream.body.cancel().catch(() => {});
          sendText(res, 413, `Response exceeded the ${config.maxFetchBytes} byte limit.`);
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (err) {
    sendText(res, 502, `Failed to read the upstream response: ${err.message}`);
    return;
  }

  let body = Buffer.concat(chunks);
  let contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const html = injectBaseHref(body.toString('utf8'), target);
    body = Buffer.from(html, 'utf8');
    contentType = 'text/html; charset=utf-8';
  }

  res.writeHead(upstream.status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-proxy-target': target.href,
    'referrer-policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ----------------------------------------------------------- proxy auth */

function isAuthorized(req, config) {
  if (!config.proxyUser) return true;

  const header = req.headers['proxy-authorization'];
  if (typeof header !== 'string') return false;

  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header.trim());
  if (!match) return false;

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return (
    constantTimeEqual(user, config.proxyUser) && constantTimeEqual(pass, config.proxyPass)
  );
}

function constantTimeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

function challenge(res) {
  res.writeHead(407, {
    'proxy-authenticate': 'Basic realm="Web Proxy", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': 34,
    'cache-control': 'no-store',
  });
  res.end('407 Proxy Authentication Required\n');
}

/* -------------------------------------------------------------- security */

/** Block loopback / private / link-local targets unless explicitly allowed. */
async function isBlockedHost(hostname, config) {
  if (!config.blockPrivateTargets) return false;

  const host = stripBrackets(String(hostname || '')).toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;

  if (net.isIP(host)) return isPrivateAddress(host);

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true });
  } catch {
    // Let the connection attempt produce the real error (DNS failure, etc.).
    return false;
  }
  return records.some((record) => isPrivateAddress(record.address));
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIPv4(address);

  const ip = address.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // unique local fc00::/7
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

/* -------------------------------------------------------------- helpers */

function filterHeaders(source) {
  const output = {};
  const connectionTokens = new Set(
    String(source.connection || '')
      .toLowerCase()
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean),
  );

  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || connectionTokens.has(key)) continue;
    if (key === 'proxy-authorization' || key === 'proxy-connection') continue;
    output[key] = value;
  }
  return output;
}

function parseAuthority(value) {
  const withPort = /^(?:\[([0-9a-fA-F:.]+)\]|([^:]+)):(\d{1,5})$/.exec(value.trim());
  if (withPort) {
    const port = Number(withPort[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: withPort[1] || withPort[2], port };
  }

  const withoutPort = /^(?:\[([0-9a-fA-F:.]+)\]|([^:]+))$/.exec(value.trim());
  if (withoutPort) return { host: withoutPort[1] || withoutPort[2], port: 443 };

  return null;
}

function stripBrackets(host) {
  return String(host).replace(/^\[/, '').replace(/\]$/, '');
}

function sendText(res, status, message) {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Give fetched HTML a <base> so relative links/assets resolve against the origin. */
function injectBaseHref(html, target) {
  const base = `<base href="${escapeHtml(target.href)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (tag) => `${tag}${base}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${base}</head>`);
  }
  return `${base}${html}`;
}

/* ------------------------------------------------------------- landing UI */

function landingPage(req, config, state) {
  const host = req.headers.host || `localhost:${config.port}`;
  const proxyOrigin = `http://${host}`;
  const authLabel = config.proxyUser
    ? '<span class="chip on">authentication required</span>'
    : '<span class="chip">no authentication</span>';
  const targetLabel = config.blockPrivateTargets
    ? '<span class="chip on">private targets blocked</span>'
    : '<span class="chip warn">private targets allowed</span>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web Proxy</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0f19; --card: #121a2b; --border: #22314c;
    --text: #e7eefc; --muted: #93a4c3; --accent: #5b9cff; --ok: #3ddc97; --warn: #ffb84d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--text);
    background: radial-gradient(1100px 520px at 15% -10%, #16233d 0%, var(--bg) 60%) fixed;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; padding: 44px 20px 72px; }
  header { display: flex; gap: 18px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 30px; letter-spacing: .2px; }
  h1 span { color: var(--accent); }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    font-size: 12px; border: 1px solid var(--border); color: var(--muted);
    border-radius: 999px; padding: 4px 10px; background: rgba(255,255,255,.02);
  }
  .chip.on { color: var(--ok); border-color: rgba(61,220,151,.35); }
  .chip.warn { color: var(--warn); border-color: rgba(255,184,77,.35); }
  .lead { color: var(--muted); margin: 10px 0 28px; }
  .card {
    background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.01)), var(--card);
    border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 18px;
  }
  .card h2 { margin: 0 0 12px; font-size: 17px; }
  .card p { margin: 0 0 12px; color: var(--muted); }
  form { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=url] {
    flex: 1 1 320px; min-width: 0; padding: 11px 13px; border-radius: 10px;
    border: 1px solid var(--border); background: #0a1120; color: var(--text); font-size: 15px;
  }
  input[type=url]:focus { outline: 2px solid rgba(91,156,255,.45); outline-offset: 1px; }
  button {
    padding: 11px 18px; border-radius: 10px; border: 1px solid transparent;
    background: var(--accent); color: #04101f; font-weight: 650; font-size: 15px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: #0a1120; border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; font-size: 13.5px; }
  pre {
    background: #0a1120; border: 1px solid var(--border); border-radius: 10px;
    padding: 14px; overflow: auto; margin: 10px 0 0; font-size: 13.5px; color: #cfe0ff;
  }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .muted { color: var(--muted); font-size: 13.5px; }
  ul { margin: 8px 0 0; padding-left: 20px; color: var(--muted); }
  li { margin: 4px 0; }
  footer { color: #6f809f; font-size: 13px; margin-top: 28px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Web <span>Proxy</span></h1>
    <div class="chips">
      ${authLabel}
      ${targetLabel}
      <span class="chip">v${VERSION}</span>
    </div>
  </header>
  <p class="lead">An HTTP/HTTPS forward proxy. It is running now — configure your tools to point at <code>${escapeHtml(proxyOrigin)}</code>.</p>

  <section class="card">
    <h2>Open a page through the proxy</h2>
    <p>Fetched server-side and rendered here. Good for reading pages; it is not an anonymity service.</p>
    <form action="/fetch" method="get">
      <input type="url" name="url" placeholder="https://example.com" aria-label="URL to fetch" required>
      <button type="submit">Fetch</button>
    </form>
  </section>

  <section class="card">
    <h2>Use it as a proxy</h2>
    <div class="row">
      <div>
        <p class="muted">Command line (HTTPS proxy URL)</p>
        <pre>curl -x ${escapeHtml(proxyOrigin)} https://example.com</pre>
      </div>
      <div>
        <p class="muted">Environment variables</p>
        <pre>export HTTPS_PROXY=${escapeHtml(proxyOrigin)}
export HTTP_PROXY=${escapeHtml(proxyOrigin)}
curl https://api.ipify.org</pre>
      </div>
    </div>
    <ul>
      <li>HTTP requests are forwarded; HTTPS is tunnelled with <code>CONNECT</code> (end-to-end TLS).</li>
      <li>In a Codespace the public URL is <code>https://…-${config.port}.app.github.dev</code>; curl accepts it as an HTTPS proxy. For browsers, forward the port locally (<code>gh codespace ports forward ${config.port}:${config.port}</code>) and use <code>http://localhost:${config.port}</code>.</li>
      <li>Health check: <a href="/__health">/__health</a></li>
    </ul>
  </section>

  <section class="card">
    <h2>Status</h2>
    <div class="row">
      <div><p class="muted">Forwarded requests</p><strong>${state.forwarded}</strong></div>
      <div><p class="muted">HTTPS tunnels</p><strong>${state.tunnels}</strong></div>
      <div><p class="muted">Blocked targets</p><strong>${state.blocked}</strong></div>
      <div><p class="muted">Uptime</p><strong>${Math.round((Date.now() - state.startedAt) / 1000)}s</strong></div>
    </div>
  </section>

  <footer>Set <code>PROXY_USER</code> and <code>PROXY_PASS</code> before exposing this port publicly.</footer>
</main>
</body>
</html>`;
}

/* --------------------------------------------------------------- CLI boot */

function loadDotEnv() {
  try {
    if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
      process.loadEnvFile('.env');
    }
  } catch (err) {
    console.warn(`[proxy] Could not load .env: ${err.message}`);
  }
}

function startCli() {
  loadDotEnv();
  const server = createProxyServer();
  const { host, port, proxyUser, blockPrivateTargets } = server.proxyConfig;

  server.on('error', (err) => {
    console.error(`[proxy] Failed to start: ${err.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`\n  Web Proxy ${VERSION}`);
    console.log(`  Listening on http://${host}:${port} (local: http://localhost:${port})`);
    console.log(`  Auth: ${proxyUser ? 'on' : 'off'}   Private targets: ${blockPrivateTargets ? 'blocked' : 'allowed'}`);
    console.log(`  Try:  curl -x http://localhost:${port} https://example.com\n`);
  });

  const shutdown = (signal) => {
    console.log(`\n[proxy] ${signal} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) startCli();
