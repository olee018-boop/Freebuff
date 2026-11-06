import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxyServer } from '../server.js';

const origin = http.createServer((req, res) => {
  if (req.url === '/echo') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, host: req.headers.host }));
    });
    return;
  }

  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Origin</title></head><body><h1>origin page</h1></body></html>',
    );
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('hello from origin');
});

let originPort;
let proxyPort;
let server;

function listen(instance) {
  return new Promise((resolve) => instance.listen(0, '127.0.0.1', () => resolve(instance.address().port)));
}

function close(instance) {
  return new Promise((resolve) => {
    instance.closeAllConnections?.();
    instance.close(() => resolve());
  });
}

function startProxy(options = {}) {
  return createProxyServer({
    logRequests: false,
    blockPrivateTargets: false,
    proxyUser: '',
    proxyPass: '',
    ...options,
  });
}

/** Send an absolute-form request to the proxy, exactly like a proxy client does. */
function proxyRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readUntilHeaders(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const index = buffer.indexOf('\r\n\r\n');
      if (index !== -1) {
        socket.off('data', onData);
        resolve(buffer.slice(0, index));
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

before(async () => {
  originPort = await listen(origin);
  server = startProxy();
  proxyPort = await listen(server);
});

after(async () => {
  await close(server);
  await close(origin);
});

test('forwards plain HTTP requests (absolute-form)', async () => {
  const res = await proxyRequest(proxyPort, `http://127.0.0.1:${originPort}/echo`);

  assert.equal(res.status, 200);
  assert.equal(res.headers['x-origin'], 'yes');
  assert.deepEqual(JSON.parse(res.body), {
    method: 'GET',
    url: '/echo',
    body: '',
    host: `127.0.0.1:${originPort}`,
  });
});

test('forwards request bodies and methods', async () => {
  const res = await proxyRequest(proxyPort, `http://127.0.0.1:${originPort}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'content-length': 11 },
    body: 'hello=proxy',
  });

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).method, 'POST');
  assert.equal(JSON.parse(res.body).body, 'hello=proxy');
});

test('tunnels HTTPS-style traffic with CONNECT', async () => {
  const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
  await once(socket, 'connect');
  socket.on('error', () => {});

  socket.write(
    `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`,
  );
  const head = await readUntilHeaders(socket);
  assert.match(head, /^HTTP\/1\.1 200 Connection Established/);

  socket.setEncoding('utf8');
  let response = '';
  socket.on('data', (chunk) => (response += chunk));
  const closed = once(socket, 'close');

  socket.write(
    `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`,
  );
  await closed;

  assert.match(response, /200 OK/);
  assert.match(response, /hello from origin/);
});

test('serves the dashboard and health endpoint', async () => {
  const page = await proxyRequest(proxyPort, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /Web <span>Proxy<\/span>/);

  const health = await proxyRequest(proxyPort, '/__health');
  assert.equal(health.status, 200);
  const payload = JSON.parse(health.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.name, 'web-proxy');
});

test('quick fetch renders HTML with a base tag', async () => {
  const target = encodeURIComponent(`http://127.0.0.1:${originPort}/page`);
  const res = await proxyRequest(proxyPort, `/fetch?url=${target}`);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /<base href="http:\/\/127\.0\.0\.1:\d+\/page">/);
  assert.match(res.body, /origin page/);
});

test('requires Proxy-Authorization when credentials are configured', async (t) => {
  const authServer = startProxy({ proxyUser: 'proxyuser', proxyPass: 's3cret' });
  const authPort = await listen(authServer);
  t.after(() => close(authServer));

  const absoluteUrl = `http://127.0.0.1:${originPort}/echo`;

  const anonymous = await proxyRequest(authPort, absoluteUrl);
  assert.equal(anonymous.status, 407);
  assert.match(anonymous.headers['proxy-authenticate'], /^Basic/);

  const wrong = await proxyRequest(authPort, absoluteUrl, {
    headers: {
      'proxy-authorization': `Basic ${Buffer.from('proxyuser:nope').toString('base64')}`,
    },
  });
  assert.equal(wrong.status, 407);

  const allowed = await proxyRequest(authPort, absoluteUrl, {
    headers: {
      'proxy-authorization': `Basic ${Buffer.from('proxyuser:s3cret').toString('base64')}`,
    },
  });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).url, '/echo');
});

test('rejects CONNECT without credentials when auth is enabled', async (t) => {
  const authServer = startProxy({ proxyUser: 'proxyuser', proxyPass: 's3cret' });
  const authPort = await listen(authServer);
  t.after(() => close(authServer));

  const socket = net.connect({ host: '127.0.0.1', port: authPort });
  await once(socket, 'connect');
  socket.on('error', () => {});
  socket.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);

  const head = await readUntilHeaders(socket);
  socket.destroy();

  assert.match(head, /^HTTP\/1\.1 407 Proxy Authentication Required/);
});

test('blocks private targets when BLOCK_PRIVATE_TARGETS is on', async (t) => {
  const guarded = startProxy({ blockPrivateTargets: true });
  const guardedPort = await listen(guarded);
  t.after(() => close(guarded));

  const res = await proxyRequest(guardedPort, `http://127.0.0.1:${originPort}/echo`);
  assert.equal(res.status, 403);

  const fetchRes = await proxyRequest(
    guardedPort,
    `/fetch?url=${encodeURIComponent(`http://localhost:${originPort}/page`)}`,
  );
  assert.equal(fetchRes.status, 403);
});
