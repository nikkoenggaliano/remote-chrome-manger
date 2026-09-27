const { connectTarget } = require('./cdp-raw');
const fetch = require('node-fetch');

// Build the CDP page WebSocket URL for a target, preferring the browser-supplied
// webSocketDebuggerUrl and falling back to the conventional path.
function targetWsUrl(host, port, target, targetId) {
  return (target && target.webSocketDebuggerUrl)
    || `ws://${host}:${port}/devtools/page/${targetId != null ? targetId : (target && target.id)}`;
}

const SCREENSHOT_QUALITY = (() => {
  const raw = parseInt(process.env.SCREENSHOT_QUALITY || '', 10);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 100) return raw;
  return 60;
})();

// Idle CDP sessions are closed after this many ms with no use.
const SESSION_IDLE_MS = 60000;

// --- Persistent CDP session cache ---------------------------------------
// Opening a CDP WebSocket is relatively expensive (HTTP upgrade + protocol
// handshake + domain enable). Doing that on every screenshot / click / keypress
// makes interactive control feel sluggish. We keep one warm connection per
// (host, port, targetId) and reuse it, evicting connections that go idle.
const sessions = new Map();

function sessionKey(host, port, targetId) {
  return `${host}:${port}:${targetId}`;
}

async function createSession(host, port, targetId) {
  // Resolve the target's WebSocket URL ourselves instead of letting
  // chrome-remote-interface re-list and match by id. If the tab was closed or
  // its target was swapped (e.g. a cross-process navigation), the id is simply
  // gone — surface that as a clear, catchable error rather than the cryptic
  // "Cannot read properties of undefined (reading 'webSocketDebuggerUrl')".
  let targets;
  try {
    targets = await getTabs(host, port);
  } catch (err) {
    throw new Error(`Unable to list targets on ${host}:${port}: ${err.message}`);
  }

  const target = Array.isArray(targets) ? targets.find((t) => t.id === targetId) : null;
  if (!target) {
    const err = new Error(`Tab ${targetId} is no longer available on ${host}:${port}`);
    err.code = 'TARGET_GONE';
    throw err;
  }

  const client = await connectTarget(targetWsUrl(host, port, target, targetId));
  try {
    await client.Page.enable();
    await client.Runtime.enable();
  } catch (err) {
    try { await client.close(); } catch {}
    throw err;
  }
  return client;
}

async function getSession(host, port, targetId) {
  const key = sessionKey(host, port, targetId);
  let entry = sessions.get(key);

  if (entry) {
    entry.lastUsed = Date.now();
    return entry.connecting ? entry.connecting : entry.client;
  }

  entry = { client: null, connecting: null, lastUsed: Date.now(), key };
  entry.connecting = createSession(host, port, targetId)
    .then((client) => {
      entry.client = client;
      entry.connecting = null;

      const drop = () => {
        if (sessions.get(key) === entry) sessions.delete(key);
      };
      client.on('disconnect', drop);
      client.on('error', drop);

      return client;
    })
    .catch((err) => {
      if (sessions.get(key) === entry) sessions.delete(key);
      throw err;
    });

  sessions.set(key, entry);
  return entry.connecting;
}

function dropSession(host, port, targetId) {
  const key = sessionKey(host, port, targetId);
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  const close = (client) => { if (client) { client.close().catch(() => {}); } };
  if (entry.client) close(entry.client);
  else if (entry.connecting) entry.connecting.then(close).catch(() => {});
}

// Evict idle sessions periodically.
const evictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.lastUsed > SESSION_IDLE_MS) {
      sessions.delete(key);
      if (entry.client) entry.client.close().catch(() => {});
    }
  }
  // Frames are only useful for a few tens of milliseconds; anything older is
  // just holding onto a buffer for a tab nobody is watching any more.
  for (const [key, frame] of frameCache.entries()) {
    if (!frame.inflight && now - frame.ts > 5000) frameCache.delete(key);
  }
}, 30000);
if (evictionTimer.unref) evictionTimer.unref();

// Run a CDP command on a warm session, transparently rebuilding the session
// once if the connection went stale (tab navigated, target swapped, etc.).
async function withSession(host, port, targetId, fn) {
  let client = await getSession(host, port, targetId);
  try {
    return await fn(client);
  } catch (err) {
    dropSession(host, port, targetId);
    client = await getSession(host, port, targetId);
    return fn(client);
  }
}

async function assertDebugEndpointReachable(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const message = error.type === 'system' || error.code
      ? `CDP endpoint http://${host}:${port} is not reachable: ${error.message}`
      : `CDP endpoint http://${host}:${port} returned an invalid response: ${error.message}`;
    throw new Error(message);
  }
}

async function getTabs(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/json`);
    return await response.json();
  } catch (err) {
    console.error(`Error fetching tabs for ${host}:${port}:`, err.message);
    return [];
  }
}

async function newTab(host, port, url = 'about:blank') {
  try {
    const response = await fetch(`http://${host}:${port}/json/new?${url}`, { method: 'PUT' });
    return await response.json();
  } catch (err) {
    console.error(`Error creating new tab for ${host}:${port}:`, err.message);
    return null;
  }
}

// Page targets are the only ones that own a browser tab/window. /json also
// lists iframes, workers, extension background pages and (on desktop Chrome)
// chrome://*.top-chrome browser_ui surfaces — none of those keep the browser
// alive, so they must not be counted when deciding whether a close is "the
// last tab".
function listPageTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter((t) => t
    && (t.type === 'page' || t.type === undefined)
    && !String(t.url || '').startsWith('devtools://'));
}

// Closing a tab must never be able to take the whole instance down, but Chrome
// disagrees: any launch mode that owns a real window tears the browser down
// when its last page target goes away. Verified on Linux + real Chrome —
//
//   gui / xvfb        close last tab -> process dies, CDP port dies
//   chrome_headless   close last tab -> browser survives with 0 tabs
//   headless-shell    close last tab -> browser survives with 0 tabs
//
// which is why the old unconditional close only lost the instance for *some*
// instances and looked intermittent. When the browser then vanishes, the
// manager's health check sees a dead port and flips the row to 'stopped'.
// So: if the target being closed is the last page, open a replacement blank
// tab *first* (create-then-close — the reverse order races the shutdown that
// is already under way). The replacement is reported back so the UI can focus
// it instead of dropping to an empty control view.
async function closeTab(host, port, id, options = {}) {
  const { keepBrowserAlive = true, replacementUrl = 'about:blank' } = options;
  let replacement = null;

  if (keepBrowserAlive) {
    const pages = listPageTargets(await getTabs(host, port));
    const isLastPage = pages.length === 1 && pages[0].id === id;
    if (isLastPage) {
      replacement = await newTab(host, port, replacementUrl);
      if (!replacement || !replacement.id) {
        // Going ahead would terminate the browser — the exact failure this
        // guard exists to prevent. Refuse instead, and say why.
        const err = new Error(
          `Refusing to close the last tab on ${host}:${port}: a replacement tab could not be created, `
          + 'and closing it would shut the browser instance down. Open another tab first, '
          + 'or stop the instance explicitly.'
        );
        err.code = 'LAST_TAB_GUARD';
        throw err;
      }
    }
  }

  dropSession(host, port, id);
  for (const key of frameCache.keys()) {
    if (key.startsWith(`${host}:${port}:${id}:`)) frameCache.delete(key);
  }
  try {
    const response = await fetch(`http://${host}:${port}/json/close/${id}`, { method: 'GET' });
    return { result: await response.text(), replacement };
  } catch (err) {
    console.error(`Error closing tab ${id} for ${host}:${port}:`, err.message);
    return { result: null, replacement };
  }
}

// `optimizeForSpeed` trades a little compression for a much cheaper encode,
// which is what the live view wants, but it only exists in newer Chrome, and
// CDP rejects unknown parameters outright rather than ignoring them. Probe once
// per endpoint and remember the answer instead of paying for a failed command
// on every frame.
const speedOptimizedScreenshots = new Map();

// Requests for the same tab that arrive within this window share one capture.
// Chrome serialises captures per target (measured: two tabs cost 113 ms back to
// back and 97 ms in parallel), so two viewers of one tab used to pay twice for
// an identical frame. Kept well under a frame period so a lone viewer never
// sees a stale image.
// `parseInt(x) || default` silently rejects a deliberate 0, which is exactly
// the value someone would set to turn sharing off.
const FRAME_SHARE_MS = (() => {
  const raw = parseInt(process.env.SCREENSHOT_SHARE_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 40;
})();
const frameCache = new Map();

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0.25, n));
}

async function runCapture(host, port, targetId, scale) {
  const endpoint = `${host}:${port}`;
  return withSession(host, port, targetId, async (client) => {
    const base = { format: 'jpeg', quality: SCREENSHOT_QUALITY };

    // Downscaling is the one parameter that actually moves the needle: the cost
    // is reading back pixels, not compressing them (measured at 1920x993,
    // quality 40/60/80 all land around 80 ms, while scale 0.5 drops to 50 ms
    // and shrinks the frame from 18 KB to 6 KB). `scale` only exists inside
    // `clip`, and clip coordinates are document-relative, so the visible region
    // has to be spelled out from the current scroll offset.
    if (scale < 1) {
      const metrics = await client.Page.getLayoutMetrics();
      const vp = metrics.cssVisualViewport || metrics.visualViewport;
      if (vp) {
        base.clip = {
          x: vp.pageX || 0,
          y: vp.pageY || 0,
          width: vp.clientWidth,
          height: vp.clientHeight,
          scale,
        };
      }
    }

    if (speedOptimizedScreenshots.get(endpoint) !== false) {
      try {
        const { data } = await client.Page.captureScreenshot({ ...base, optimizeForSpeed: true });
        speedOptimizedScreenshots.set(endpoint, true);
        return data;
      } catch (err) {
        speedOptimizedScreenshots.set(endpoint, false);
      }
    }
    const { data } = await client.Page.captureScreenshot(base);
    return data;
  });
}

async function captureScreenshot(host, port, targetId, options = {}) {
  const scale = clampScale(options.scale ?? 1);
  const key = `${host}:${port}:${targetId}:${scale}`;
  const entry = frameCache.get(key);
  const now = Date.now();

  if (entry) {
    // Join a capture already in flight rather than asking Chrome for a second
    // one it would only queue behind the first.
    if (entry.inflight) return entry.inflight;
    if (entry.data && now - entry.ts < FRAME_SHARE_MS) return entry.data;
  }

  const inflight = runCapture(host, port, targetId, scale)
    .then((data) => {
      frameCache.set(key, { inflight: null, data, ts: Date.now() });
      return data;
    })
    .catch((err) => {
      frameCache.delete(key);
      console.error(`Error capturing screenshot for ${host}:${port} tab ${targetId}:`, err.message);
      return null;
    });

  frameCache.set(key, { inflight, data: entry?.data ?? null, ts: entry?.ts ?? 0 });
  return inflight;
}

// Run an expression in the page and hand back its value. `returnByValue` makes
// CDP serialise the result for us, so callers get plain JSON instead of remote
// object handles they would have to release.
async function evaluateInTab(host, port, targetId, expression, options = {}) {
  const { awaitPromise = true, timeoutMs = 15000 } = options;
  return withSession(host, port, targetId, async (client) => {
    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: timeoutMs,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const message = detail.exception?.description || detail.text || 'Evaluation failed';
      const err = new Error(message);
      err.code = 'EVALUATION_FAILED';
      throw err;
    }
    return result.result?.value;
  });
}

// The DOM as the browser currently holds it — after scripts have run and the
// framework has rendered — which is the whole point of dumping from a live tab
// rather than re-fetching the URL. documentElement.outerHTML drops the doctype,
// so it is rebuilt here to keep the dump reusable as a standalone file.
const PAGE_DUMP_EXPRESSION = `(() => {
  const d = document;
  let doctype = '';
  if (d.doctype) {
    const t = d.doctype;
    doctype = '<!DOCTYPE ' + t.name
      + (t.publicId ? ' PUBLIC "' + t.publicId + '"' : '')
      + (!t.publicId && t.systemId ? ' SYSTEM' : '')
      + (t.systemId ? ' "' + t.systemId + '"' : '')
      + '>\\n';
  }
  return {
    url: location.href,
    title: d.title,
    ready_state: d.readyState,
    html: doctype + (d.documentElement ? d.documentElement.outerHTML : ''),
    text: d.body ? d.body.innerText : '',
  };
})()`;

async function getPageDump(host, port, targetId) {
  const dump = await evaluateInTab(host, port, targetId, PAGE_DUMP_EXPRESSION);
  if (!dump || typeof dump.html !== 'string') {
    throw new Error(`Could not read the document of tab ${targetId} on ${host}:${port}`);
  }
  return {
    ...dump,
    html_bytes: Buffer.byteLength(dump.html, 'utf8'),
    captured_at: new Date().toISOString(),
  };
}

// --- Element inspection --------------------------------------------------
// Chrome's own context menu is browser chrome, not page content, so it can
// never appear in a screenshot. Instead the dashboard draws its own menu and
// backs it with this: point at a coordinate, get the element there.
//
// Runs entirely off backendNodeId -> objectId, which avoids DOM.getDocument and
// the node-id bookkeeping that goes stale the moment the document changes.
const INSPECT_FUNCTION = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;

  // A path that is short enough to read and specific enough to paste into
  // querySelector: stop at the first id, otherwise disambiguate with
  // nth-of-type, and give up after a few levels rather than emit a monster.
  const buildSelector = (node) => {
    if (node.id) return '#' + CSS.escape(node.id);
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const siblings = cur.parentElement
        ? [...cur.parentElement.children].filter((s) => s.tagName === cur.tagName)
        : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const wanted = ['display', 'position', 'width', 'height', 'margin', 'padding',
    'border', 'color', 'background-color', 'font-family', 'font-size',
    'font-weight', 'line-height', 'z-index', 'opacity'];
  const styles = {};
  for (const k of wanted) styles[k] = cs.getPropertyValue(k);

  const anchor = el.closest ? el.closest('a') : null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: [...el.classList],
    selector: buildSelector(el),
    attributes: [...el.attributes].map((a) => ({ name: a.name, value: a.value })),
    text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
    outer_html: el.outerHTML.slice(0, 50000),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    link: anchor ? anchor.href : null,
    image: el.tagName === 'IMG' ? (el.currentSrc || el.src) : null,
    child_count: el.children.length,
    styles,
  };
}`;

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.45 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.55 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.55 },
};

async function inspectAt(host, port, targetId, x, y, options = {}) {
  const { highlight = true } = options;

  // "Nothing is rendered there" is a normal answer, not a broken connection.
  // Throwing it from inside the callback would make withSession tear the CDP
  // session down and rebuild it, which stutters the live view for what is just
  // a click past the edge of the page. Signal it by value instead.
  const NO_NODE = Symbol('no-node');

  const result = await withSession(host, port, targetId, async (client) => {
    await client.DOM.enable();
    if (highlight) await client.Overlay.enable();

    let location;
    try {
      location = await client.DOM.getNodeForLocation({ x, y, includeUserAgentShadowDOM: false });
    } catch (err) {
      if (/no node found/i.test(err.message || '')) return NO_NODE;
      throw err;
    }
    if (!location || !location.backendNodeId) return NO_NODE;

    const resolved = await client.DOM.resolveNode({ backendNodeId: location.backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error(`Could not resolve the element at (${x}, ${y})`);

    try {
      const call = await client.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: INSPECT_FUNCTION,
        returnByValue: true,
      });
      if (call.exceptionDetails) {
        throw new Error(call.exceptionDetails.exception?.description || 'Inspection failed');
      }
      if (highlight) {
        await client.Overlay.highlightNode({ objectId, highlightConfig: HIGHLIGHT_CONFIG });
      }
      return { point: { x, y }, ...(call.result?.value || {}) };
    } finally {
      // Holding the remote handle would pin the element in memory; the
      // highlight keeps its own reference, so releasing here is safe.
      try { await client.Runtime.releaseObject({ objectId }); } catch { /* already gone */ }
    }
  });

  if (result === NO_NODE) {
    const err = new Error(`No element at (${x}, ${y})`);
    err.code = 'NO_NODE_AT_POINT';
    throw err;
  }
  return result;
}

async function hideHighlight(host, port, targetId) {
  return withSession(host, port, targetId, async (client) => {
    await client.Overlay.enable();
    await client.Overlay.hideHighlight();
  });
}

async function reloadTab(host, port, targetId, options = {}) {
  const { ignoreCache = false } = options;
  await withSession(host, port, targetId, (client) => client.Page.reload({ ignoreCache }));
}

// delta -1 goes back, +1 forward. Returns null when there is nothing to move to
// so callers can report that instead of failing.
async function historyGo(host, port, targetId, delta) {
  return withSession(host, port, targetId, async (client) => {
    const { currentIndex, entries } = await client.Page.getNavigationHistory();
    const target = entries[currentIndex + delta];
    if (!target) return null;
    await client.Page.navigateToHistoryEntry({ entryId: target.id });
    return { url: target.url, title: target.title };
  });
}

async function exportCookies(host, port, targetId) {
  return withSession(host, port, targetId, async (client) => {
    const { cookies } = await client.Network.getAllCookies();
    return Array.isArray(cookies) ? cookies : [];
  });
}

async function printToPdf(host, port, targetId, options = {}) {
  const { landscape = false, printBackground = true, scale = 1 } = options;
  return withSession(host, port, targetId, async (client) => {
    const { data } = await client.Page.printToPDF({ landscape, printBackground, scale });
    return data;
  });
}

async function navigateTab(host, port, targetId, url) {
  try {
    await withSession(host, port, targetId, (client) => client.Page.navigate({ url }));
  } catch (err) {
    console.error(`Error navigating tab ${targetId} for ${host}:${port} to ${url}:`, err.message);
    throw err;
  }
}

async function bringToFront(host, port, targetId) {
  try {
    await withSession(host, port, targetId, (client) => client.Page.bringToFront());
  } catch (err) {
    // Best-effort; not all targets support it.
  }
}

async function sendInput(host, port, targetId, method, params) {
  try {
    await withSession(host, port, targetId, (client) => client.send(method, params));
  } catch (err) {
    console.error(`Error sending input to ${host}:${port} tab ${targetId}:`, err.message);
    throw err;
  }
}

async function importCookies(host, port, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { imported: 0, failed: 0, failures: [] };
  }

  let client;
  let temporaryTabId = null;

  try {
    await assertDebugEndpointReachable(host, port);
    const tabs = await getTabs(host, port);
    let target = tabs.find((tab) => tab.type === 'page') || tabs[0] || null;

    if (!target) {
      const createdTab = await newTab(host, port, 'about:blank');
      if (!createdTab?.id) {
        throw new Error('Failed to create a temporary tab for cookie import');
      }
      temporaryTabId = createdTab.id;
      target = createdTab;
    }

    client = await connectTarget(targetWsUrl(host, port, target, target.id));
    const { Network } = client;
    await Network.enable();

    const failures = [];
    let imported = 0;

    for (const cookie of cookies) {
      try {
        const result = await Network.setCookie(cookie);
        if (result && result.success === false) {
          throw new Error('CDP rejected the cookie');
        }
        imported += 1;
      } catch (error) {
        failures.push({
          name: cookie.name,
          domain: cookie.domain || null,
          path: cookie.path || null,
          error: error.message,
        });
      }
    }

    return {
      imported,
      failed: failures.length,
      failures,
    };
  } catch (error) {
    console.error(`Error importing cookies into ${host}:${port}:`, error.message);
    throw error;
  } finally {
    if (client) {
      await client.close();
    }
    if (temporaryTabId) {
      // This tab only exists because the browser had no page targets to begin
      // with; returning it to that state is safe and must not leave a stray
      // replacement behind.
      await closeTab(host, port, temporaryTabId, { keepBrowserAlive: false });
    }
  }
}

module.exports = {
  getTabs,
  newTab,
  closeTab,
  listPageTargets,
  evaluateInTab,
  getPageDump,
  inspectAt,
  hideHighlight,
  reloadTab,
  historyGo,
  exportCookies,
  printToPdf,
  captureScreenshot,
  navigateTab,
  bringToFront,
  sendInput,
  importCookies,
  assertDebugEndpointReachable,
};
