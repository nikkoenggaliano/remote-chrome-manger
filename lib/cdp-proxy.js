// A reverse proxy in front of an instance's raw DevTools endpoint.
//
// Why: the only way to point Puppeteer or Playwright at a managed browser used
// to be to reach its CDP port directly, and that port has **no authentication
// of any kind** — anyone who can route to it owns the browser. Publishing it
// meant either exposing that, or hand-rolling a socat tunnel per instance.
// Proxying it through the REST surface puts the API key in front of it and
// collapses the whole fleet onto one reachable port.
//
// Two things make this more than a dumb pipe:
//
//   * Chrome validates the Host header to defeat DNS rebinding, and answers 500
//     for anything that is not an IP address or localhost (verified). The
//     client's own Host must therefore be replaced, not forwarded.
//   * /json and /json/version hand back absolute ws:// URLs pointing at the
//     instance's own port. A client that followed those would bypass the proxy
//     and hit the unauthenticated port, so every URL in the payload is
//     rewritten to come back through here.
const { WebSocketServer, WebSocket } = require('ws');
const fetch = require('node-fetch');

// Frames carry screenshots, so the cap has to be generous.
const MAX_PAYLOAD = 256 * 1024 * 1024;

// A proxy with no backpressure is just a buffer with extra steps: a client that
// stops reading while Chrome keeps answering made the server's RSS climb by
// 356 MB in two seconds with nothing to stop it, which is one stalled CDP
// client away from taking the whole fleet down. Above the high-water mark the
// socket feeding the buffer is paused until it drains; a client that never
// drains at all is dropped rather than allowed to keep growing.
const SEND_HIGH_WATER = 16 * 1024 * 1024;
const SEND_LOW_WATER = 4 * 1024 * 1024;
const SEND_HARD_LIMIT = 128 * 1024 * 1024;

// How long a peer gets to answer the closing handshake before the socket is
// cut. Without this, a peer that never replies holds the connection open.
const CLOSE_GRACE_MS = 3000;

// Not every close code may be put on the wire. 1005 ("no status received") and
// 1006 ("abnormal closure") are produced *by* the library to describe what
// happened and throw if you try to send them, and those are exactly the codes
// the two commonest disconnects yield: a client calling close() with no
// argument, and a connection dropping. Forwarding them verbatim made close()
// throw, the throw was swallowed, and the upstream socket to Chrome was left
// established: about one leaked descriptor per session.
function sanitizeCloseCode(code) {
  if (Number.isInteger(code)) {
    if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)) {
      return code;
    }
    if (code === 1005) return 1000; // peer closed cleanly, just without a code
  }
  return 1011;
}

// The close reason is capped at 123 bytes by the protocol; an over-long one
// throws just like a bad code would.
function sanitizeCloseReason(reason) {
  const text = reason === undefined || reason === null ? '' : String(reason);
  if (!text) return '';
  let out = Buffer.from(text, 'utf8');
  if (out.length <= 123) return text;
  out = out.subarray(0, 123);
  // Never split a multi-byte character in half.
  return out.toString('utf8').replace(/\uFFFD+$/, '');
}

const PROXY_PATH = /^\/rest\/instances\/([^/]+)\/cdp(\/.*)?$/;

function parseProxyPath(pathname) {
  const match = PROXY_PATH.exec(pathname);
  if (!match) return null;
  return { instanceId: decodeURIComponent(match[1]), upstreamPath: match[2] || '/' };
}

function proxyBase(instanceId) {
  return `/rest/instances/${encodeURIComponent(instanceId)}/cdp`;
}

// Chrome's HTTP endpoint only trusts an IP or localhost in Host.
function upstreamAuthority(instance) {
  const host = !instance.host || instance.host === '0.0.0.0' ? '127.0.0.1' : instance.host;
  return `${host}:${instance.port}`;
}

// Rewrite every debugger URL in a /json payload so clients keep coming back
// through the proxy instead of dialling the instance port directly.
function rewritePayload(text, instance, publicOrigin) {
  const authority = upstreamAuthority(instance);
  const base = proxyBase(instance.id);
  const wsScheme = publicOrigin.startsWith('https:') ? 'wss' : 'ws';
  const publicAuthority = publicOrigin.replace(/^https?:\/\//, '');

  return text
    // "ws://127.0.0.1:9222/devtools/..." -> "ws://<us>/rest/instances/1/cdp/devtools/..."
    .split(`ws://${authority}/devtools/`)
    .join(`${wsScheme}://${publicAuthority}${base}/devtools/`)
    // devtoolsFrontendUrl embeds the endpoint as a bare "ws=host:port/devtools/..."
    .split(`ws=${authority}/devtools/`)
    .join(`ws=${publicAuthority}${base}/devtools/`)
    // Plain http references to the same endpoint (e.g. in /json/protocol links).
    .split(`http://${authority}/`)
    .join(`${publicOrigin}${base}/`);
}

function publicOriginFor(req) {
  // Honour a reverse proxy in front of us, but fall back to what the client
  // actually dialled so the rewritten URLs are reachable from where it sits.
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    || req.headers.host
    || 'localhost';
  return `${proto}://${host}`;
}

// --- HTTP side -------------------------------------------------------------

function createCdpHttpProxy({ resolveInstance }) {
  return async function cdpHttpProxy(req, res) {
    const instance = resolveInstance(req.params.id);
    const authority = upstreamAuthority(instance);

    // Taken from the raw URL rather than reassembled from route params: the
    // path has to reach Chrome byte for byte, including any encoding and the
    // query string that /json/new carries its URL in.
    const queryAt = req.originalUrl.indexOf('?');
    const pathname = queryAt === -1 ? req.originalUrl : req.originalUrl.slice(0, queryAt);
    const search = queryAt === -1 ? '' : req.originalUrl.slice(queryAt);
    const route = parseProxyPath(pathname);
    const target = `http://${authority}${route ? route.upstreamPath : '/'}${search}`;

    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: {
          // Replaced, never forwarded: see the note at the top of this file.
          Host: authority,
          accept: req.get('accept') || '*/*',
          ...(req.get('content-type') ? { 'content-type': req.get('content-type') } : {}),
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.rawBody,
        redirect: 'manual',
      });
    } catch (error) {
      res.status(502).json({ error: `Cannot reach the CDP endpoint of "${instance.name}" at ${authority}: ${error.message}` });
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const body = await upstream.text();

    if (contentType.includes('application/json') || body.trimStart().startsWith('[') || body.trimStart().startsWith('{')) {
      res.status(upstream.status)
        .type(contentType || 'application/json')
        .send(rewritePayload(body, instance, publicOriginFor(req)));
      return;
    }
    res.status(upstream.status).type(contentType || 'text/plain').send(body);
  };
}

// --- WebSocket side --------------------------------------------------------

function attachCdpWebSocketProxy(server, { resolveInstance, authorize, onLog }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const log = onLog || (() => {});

  const STATUS_TEXT = {
    400: '400 Bad Request',
    401: '401 Unauthorized',
    404: '404 Not Found',
    409: '409 Conflict',
    502: '502 Bad Gateway',
  };

  // An upgrade that is refused has to answer with a plain HTTP response on the
  // raw socket; the status should say the same thing the HTTP proxy would.
  const refuse = (socket, status, message) => {
    const line = STATUS_TEXT[status] || '500 Internal Server Error';
    socket.write(`HTTP/1.1 ${line}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error: message })}`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return; // not ours to judge
    }

    const route = parseProxyPath(url.pathname);
    if (!route) return; // socket.io and anything else keep their own upgrades

    const decision = authorize(req, url, route.instanceId);
    if (!decision.ok) {
      refuse(socket, decision.status || 401, decision.error);
      return;
    }

    let instance;
    try {
      instance = resolveInstance(route.instanceId);
    } catch (error) {
      // Carries the same status the HTTP side would use, so "not found" and
      // "not running" stay distinguishable over a WebSocket upgrade too.
      refuse(socket, error.status || 404, error.message);
      return;
    }

    const authority = upstreamAuthority(instance);

    // `key` is ours, not Chrome's. Forwarding it upstream made Chrome refuse
    // the page endpoint outright.
    const forwarded = new URLSearchParams(url.search);
    forwarded.delete('key');
    const query = forwarded.toString();
    const targetUrl = `ws://${authority}${route.upstreamPath}${query ? `?${query}` : ''}`;

    // Answer the client's handshake first, then dial upstream.
    //
    // The ordering is forced by socket.io: engine.io adds its own 'upgrade'
    // listener and, for any path it does not recognise, destroys the socket
    // after 1 s unless something has already written to it. Connecting
    // upstream first meant a browser that took longer than that to complete
    // its handshake had the client socket pulled out from under it, surfacing
    // as "socket hang up" at almost exactly 1005 ms. Verified against an
    // upstream stalled to 1600 ms, which is well within reach of an external
    // instance across a slow link or a Chrome under load.
    //
    // Writing the 101 up front costs nothing and removes the deadline. The
    // price is that an upstream failure can no longer be reported as an HTTP
    // status, so it is reported as a close frame carrying the reason instead,
    // which a CDP client surfaces as a disconnect rather than a hang.
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(targetUrl, {
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD,
        // Same Host rule as the HTTP side; Chrome checks it on the upgrade too.
        headers: { Host: authority },
        handshakeTimeout: 30000,
      });

      // Commands sent before the upstream socket is ready have to be held, or
      // the first command of a session is silently dropped.
      let pending = [];
      let opened = false;

      // Shut one side down and make sure the descriptor is actually released,
      // whatever the peer does.
      const shut = (ws, code, reason) => {
        // A paused socket never finishes its closing handshake.
        try { if (ws._socket && ws._socket.isPaused()) ws._socket.resume(); } catch { /* ignore */ }
        try {
          if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
          else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        } catch {
          try { ws.terminate(); } catch { /* already gone */ }
        }
        const timer = setTimeout(() => {
          try { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); } catch { /* already gone */ }
        }, CLOSE_GRACE_MS);
        if (timer.unref) timer.unref();
      };

      let closing = false;
      const closeBoth = (code, reason) => {
        if (closing) return;
        closing = true;
        pending = [];
        const safeCode = sanitizeCloseCode(code);
        const safeReason = sanitizeCloseReason(reason);
        shut(client, safeCode, safeReason);
        shut(upstream, safeCode, safeReason);
      };

      upstream.on('open', () => {
        opened = true;
        for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
        pending = [];
        log('INFO', `open: instance ${instance.id} ${route.upstreamPath}`);
      });

      // Stop reading from `source` while `sink` is backed up, and start again
      // once it has drained. Returns false when the sink is hopeless.
      const regulate = (sink, source, label) => {
        const buffered = sink.bufferedAmount;
        if (buffered > SEND_HARD_LIMIT) {
          log('WARN', `dropping ${label} of instance ${instance.id}: ${Math.round(buffered / 1048576)} MB queued and not draining`);
          closeBoth(1011, `${label} is not reading; connection dropped to protect the server`);
          return false;
        }
        const sock = source._socket;
        if (!sock) return true;
        if (buffered > SEND_HIGH_WATER && !sock.isPaused()) sock.pause();
        else if (buffered <= SEND_LOW_WATER && sock.isPaused()) sock.resume();
        return true;
      };

      upstream.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        // The flush callback is the moment the buffer shrank, so it is also the
        // right moment to let the browser start talking again.
        client.send(data, { binary: isBinary }, () => regulate(client, upstream, 'client'));
        regulate(client, upstream, 'client');
      });
      client.on('message', (data, isBinary) => {
        if (!opened || upstream.readyState !== WebSocket.OPEN) { pending.push([data, isBinary]); return; }
        upstream.send(data, { binary: isBinary }, () => regulate(upstream, client, 'browser'));
        regulate(upstream, client, 'browser');
      });

      upstream.on('close', (code, reason) => closeBoth(code, reason?.toString?.() || ''));
      client.on('close', (code, reason) => closeBoth(code, reason?.toString?.() || ''));
      upstream.on('error', (err) => {
        log('WARN', `CDP proxy upstream error (instance ${instance.id}): ${err.message}`);
        // Said out loud in the close reason so the client sees why, instead of
        // a bare disconnect it has to guess about.
        closeBoth(1011, `upstream: ${err.message}`);
      });
      client.on('error', () => closeBoth(1011, 'client error'));
    });
  });

  return wss;
}

module.exports = {
  createCdpHttpProxy,
  attachCdpWebSocketProxy,
  parseProxyPath,
  rewritePayload,
  sanitizeCloseCode,
  sanitizeCloseReason,
  upstreamAuthority,
  proxyBase,
};
