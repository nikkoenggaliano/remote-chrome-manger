#!/usr/bin/env node
/*
 * Copies a web session that lives in localStorage/sessionStorage (not cookies)
 * from a signed-in everyday browser into a fleet instance.
 *
 * Cookie import only moves cookies, and a great many apps keep nothing in them:
 * a Next.js/React dashboard typically stores a JWT under a localStorage key and
 * attaches it as "Authorization: Bearer <token>" per request. For those, the
 * cookie jar can be perfectly restored and the app still shows a login screen.
 *
 * In the signed-in browser, on the app's own tab, DevTools console:
 *     copy(JSON.stringify(localStorage))
 * then  pbpaste > session.json  and:
 *     node tools/push-session.js --instance 1567 --file session.json \
 *          --url https://myads.telkomsel.com/beranda
 *
 * Storage is partitioned per origin, so the tab must already be on the target
 * origin before anything is written. This script navigates there first and
 * refuses to write if the origin still does not match, because a silent write
 * to the wrong origin looks exactly like a working import until you reload.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function usage(code) {
  process.stderr.write(`Usage: node tools/push-session.js --instance <id> --file <session.json> [options]

  --instance <id>     Fleet instance id (required)
  --file <path>       JSON object of key/value pairs, or {localStorage, sessionStorage} (required)
  --url <url>         Page to land on afterwards; its origin is the write target (required unless --origin)
  --origin <origin>   Write target origin when it differs from --url
  --session-storage   Treat a flat JSON file as sessionStorage instead of localStorage
  --cookie-from <c>:<k>  Mirror storage key <k> into cookie <c> (repeatable). Some apps
                      keep the same token in both and read whichever is handy.
  --clear             Wipe the origin's existing storage before writing
  --base <url>        Dashboard base URL (default http://127.0.0.1:4000)
  --no-reload         Write only; do not navigate afterwards
`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:4000', reload: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(2);
      i += 1;
      return v;
    };
    if (a === '--instance') out.instance = next();
    else if (a === '--file') out.file = next();
    else if (a === '--url') out.url = next();
    else if (a === '--origin') out.origin = next();
    else if (a === '--base') out.base = next().replace(/\/+$/, '');
    else if (a === '--session-storage') out.sessionStorage = true;
    else if (a === '--cookie-from') {
      const spec = next();
      const sep = spec.indexOf(':');
      if (sep <= 0 || sep === spec.length - 1) usage(2);
      (out.cookieFrom = out.cookieFrom || []).push({ cookie: spec.slice(0, sep), key: spec.slice(sep + 1) });
    }
    else if (a === '--clear') out.clear = true;
    else if (a === '--no-reload') out.reload = false;
    else if (a === '-h' || a === '--help') usage(0);
    else usage(2);
  }
  if (!out.instance || !out.file) usage(2);
  if (!out.url && !out.origin) usage(2);
  return out;
}

// The dashboard and /api are behind the same basic auth the UI uses, and the
// credentials already live in .env, so reading them beats asking for them twice.
function readAuth() {
  const envPath = path.resolve(__dirname, '..', '.env');
  let user = process.env.CHROME_FLEET_USERNAME;
  let pass = process.env.CHROME_FLEET_PASSWORD;
  if ((!user || !pass) && fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (m[1] === 'CHROME_FLEET_USERNAME' && !user) user = value;
      if (m[1] === 'CHROME_FLEET_PASSWORD' && !pass) pass = value;
    }
  }
  if (!user || !pass) {
    throw new Error('Dashboard credentials not found. Set CHROME_FLEET_USERNAME and CHROME_FLEET_PASSWORD, or keep them in .env');
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function api(opts, method, pathname, body) {
  const res = await fetch(`${opts.base}/api${pathname}`, {
    method,
    headers: {
      Authorization: opts.auth,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${parsed?.error || text.slice(0, 200)}`);
  }
  return parsed;
}

function loadPayload(file, asSessionStorage) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && (raw.localStorage || raw.sessionStorage)) {
    return { local: raw.localStorage || {}, session: raw.sessionStorage || {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected a JSON object of key/value pairs, or {"localStorage":{…}}');
  }
  // Browser storage holds strings only; a number or object in the dump would
  // otherwise land as "[object Object]" and break the app in a puzzling way.
  const flat = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return asSessionStorage ? { local: {}, session: flat } : { local: flat, session: {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function firstPageTab(opts) {
  const tabs = await api(opts, 'GET', `/instances/${opts.instance}/tabs`);
  const pages = (Array.isArray(tabs) ? tabs : []).filter((t) => t.type === 'page');
  if (!pages.length) throw new Error(`Instance ${opts.instance} has no open page tab`);
  return pages[0];
}

async function evaluate(opts, tabId, expression) {
  const r = await api(opts, 'POST', `/instances/${opts.instance}/tabs/${tabId}/evaluate`, { expression });
  return r?.value;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  opts.auth = readAuth();

  const targetOrigin = new URL(opts.origin || opts.url).origin;
  const payload = loadPayload(opts.file, opts.sessionStorage);
  const counts = { local: Object.keys(payload.local).length, session: Object.keys(payload.session).length };
  if (!counts.local && !counts.session) throw new Error('The dump holds no keys');

  const tab = await firstPageTab(opts);
  console.log(`instance ${opts.instance}, tab ${tab.id}`);
  console.log(`now at  : ${tab.url || '(blank)'}`);

  let current = await evaluate(opts, tab.id, 'location.origin');
  if (current !== targetOrigin) {
    console.log(`navigate: ${targetOrigin}/ (storage is per origin, so this has to happen first)`);
    await api(opts, 'POST', `/instances/${opts.instance}/tabs/${tab.id}/navigate`, { url: `${targetOrigin}/` });
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      try {
        current = await evaluate(opts, tab.id, 'location.origin');
        if (current === targetOrigin) break;
      } catch { /* the tab is mid-navigation; try again */ }
    }
  }
  if (current !== targetOrigin) {
    throw new Error(`Tab is on ${current}, not ${targetOrigin}. Nothing was written.`);
  }

  const expression = `(() => {
    const data = ${JSON.stringify(payload)};
    const clear = ${opts.clear ? 'true' : 'false'};
    if (clear) { localStorage.clear(); sessionStorage.clear(); }
    for (const [k, v] of Object.entries(data.local)) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(data.session)) sessionStorage.setItem(k, v);
    return JSON.stringify({ origin: location.origin, local: localStorage.length, session: sessionStorage.length });
  })()`;
  const written = JSON.parse(await evaluate(opts, tab.id, expression));

  console.log(`wrote   : ${counts.local} localStorage + ${counts.session} sessionStorage key(s) into ${written.origin}`);
  console.log(`storage : localStorage now holds ${written.local} key(s), sessionStorage ${written.session}`);

  // The app that wrote this storage may also have copied the value into a
  // cookie, and a stale cookie next to a fresh token is worse than neither:
  // the request looks authenticated and still gets rejected. Mirror it raw,
  // exactly as the page's own document.cookie assignment would.
  for (const { cookie, key } of opts.cookieFrom || []) {
    const value = payload.local[key] ?? payload.session[key];
    if (value === undefined) {
      console.log(`cookie  : ${cookie} skipped, the dump has no "${key}" key`);
      continue;
    }
    const setExpr = `(() => {
      document.cookie = ${JSON.stringify(`${cookie}=`)} + ${JSON.stringify(String(value))} + "; path=/";
      const hit = document.cookie.split("; ").find((c) => c.startsWith(${JSON.stringify(`${cookie}=`)}));
      return JSON.stringify({ ok: !!hit, len: hit ? hit.length - ${cookie.length + 1} : 0 });
    })()`;
    const r = JSON.parse(await evaluate(opts, tab.id, setExpr));
    console.log(`cookie  : ${cookie} <- ${key} (${r.ok ? `set, ${r.len} chars` : 'FAILED to set'})`);
  }

  if (opts.reload && opts.url) {
    console.log(`open    : ${opts.url}`);
    await api(opts, 'POST', `/instances/${opts.instance}/tabs/${tab.id}/navigate`, { url: opts.url });
    await sleep(2500);
    const landed = await evaluate(opts, tab.id, 'JSON.stringify({url:location.href,title:document.title})')
      .catch(() => null);
    if (landed) console.log(`landed  : ${JSON.parse(landed).url}`);
  }
})().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
