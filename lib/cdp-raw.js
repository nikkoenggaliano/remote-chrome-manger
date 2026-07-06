// Minimal Chrome DevTools Protocol client over a raw WebSocket.
//
// Why this exists: chrome-remote-interface@0.33.3 (its target connection path)
// crashes modern Chromium (150+) on connect — the whole browser dies with a
// silent SIGTRAP the moment a screenshot/input session is opened. A raw
// WebSocket carrying byte-identical CDP commands works perfectly (verified end
// to end producing real PNG/JPEG frames). This client implements just the slice
// of the cri API that lib/cdp-client.js depends on: send(), close(),
// on('disconnect'|'error'), and the Page / Runtime / Network domain helpers.
const WebSocket = require('ws');

class RawCDP {
  constructor(ws) {
    this._ws = ws;
    this._nextId = 0;
    this._pending = new Map();
    this._listeners = { disconnect: [], error: [] };
    this._closed = false;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id === undefined) return; // protocol event — not needed here
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'CDP error');
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result || {});
      }
    });
    ws.on('close', () => this._teardown('disconnect'));
    ws.on('error', (err) => this._teardown('error', err));
  }

  _teardown(event, err) {
    if (this._closed) return;
    this._closed = true;
    const failure = err || new Error('CDP connection closed');
    for (const { reject } of this._pending.values()) reject(failure);
    this._pending.clear();
    for (const fn of this._listeners[event] || []) {
      try { fn(err); } catch { /* ignore listener errors */ }
    }
  }

  // Send a CDP command and resolve with its `result` object (or reject on error
  // / disconnect). Mirrors chrome-remote-interface's `client.send(method, params)`.
  send(method, params = {}) {
    if (this._closed || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection not open (cannot send ${method})`));
    }
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
  }

  close() {
    try { this._ws.close(); } catch { /* ignore */ }
    return Promise.resolve();
  }

  // Domain helpers — only the methods lib/cdp-client.js uses.
  get Page() {
    return {
      enable: () => this.send('Page.enable'),
      captureScreenshot: (params) => this.send('Page.captureScreenshot', params),
      navigate: (params) => this.send('Page.navigate', params),
      bringToFront: () => this.send('Page.bringToFront'),
    };
  }

  get Runtime() {
    return { enable: () => this.send('Runtime.enable') };
  }

  get Network() {
    return {
      enable: () => this.send('Network.enable'),
      setCookie: (params) => this.send('Network.setCookie', params),
    };
  }
}

// Open a CDP session to a target's WebSocket debugger URL; resolve once the
// socket is open, reject on error/timeout.
function connectTarget(wsUrl, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      finish(reject, new Error(`Timed out connecting to CDP target ${wsUrl}`));
    }, timeoutMs);
    ws.once('open', () => finish(resolve, new RawCDP(ws)));
    ws.once('error', (err) => finish(reject, err));
  });
}

module.exports = { connectTarget, RawCDP };
