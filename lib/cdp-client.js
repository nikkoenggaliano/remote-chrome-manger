const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');

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

  const connectOptions = target.webSocketDebuggerUrl
    ? { target: target.webSocketDebuggerUrl }
    : { host, port, target: targetId };

  const client = await CDP(connectOptions);
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

async function closeTab(host, port, id) {
  dropSession(host, port, id);
  try {
    const response = await fetch(`http://${host}:${port}/json/close/${id}`, { method: 'GET' });
    return await response.text();
  } catch (err) {
    console.error(`Error closing tab ${id} for ${host}:${port}:`, err.message);
    return null;
  }
}

async function captureScreenshot(host, port, targetId) {
  try {
    return await withSession(host, port, targetId, async (client) => {
      const { data } = await client.Page.captureScreenshot({ format: 'jpeg', quality: SCREENSHOT_QUALITY });
      return data;
    });
  } catch (err) {
    console.error(`Error capturing screenshot for ${host}:${port} tab ${targetId}:`, err.message);
    return null;
  }
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

    client = await CDP({ host, port, target: target.id });
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
      await closeTab(host, port, temporaryTabId);
    }
  }
}

module.exports = {
  getTabs,
  newTab,
  closeTab,
  captureScreenshot,
  navigateTab,
  bringToFront,
  sendInput,
  importCookies,
  assertDebugEndpointReachable,
};
