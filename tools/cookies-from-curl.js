#!/usr/bin/env node
/*
 * Turns a DevTools "Copy as cURL" paste into the cookie JSON that
 * POST /instances/:id/cookies/import accepts.
 *
 * Chrome's own browser is the only place some sessions live, and it refuses
 * remote debugging on the default profile since Chrome 136, so the practical
 * way out of a signed-in everyday browser is the request it already made:
 * DevTools knows the full Cookie header, httpOnly entries included.
 *
 *   node tools/cookies-from-curl.js < pasted.txt > cookies.json
 *   pbpaste | node tools/cookies-from-curl.js | curl ... --data-binary @-
 *
 * Chrome emits the cookies either as -b '<pairs>' or -H 'cookie: <pairs>'
 * depending on version, and quotes with ' on macOS/Linux and " on Windows.
 */
'use strict';

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// A quoted run in the paste, honouring the shell escapes Chrome produces:
// '\'' inside single quotes, \" inside double quotes.
function quotedAfter(text, index) {
  const quote = text[index];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  for (let i = index + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'" && ch === "'") {
      if (text.startsWith("\\''", i + 1)) { out += "'"; i += 3; continue; }
      return { value: out, end: i };
    }
    if (quote === '"' && ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 1; continue; }
    if (quote === '"' && ch === '"') return { value: out, end: i };
    out += ch;
  }
  return null;
}

function findCookieHeader(text) {
  // -b / --cookie '<pairs>'
  const bFlag = /(?:^|\s)(?:-b|--cookie)\s+(['"])/g;
  let m;
  while ((m = bFlag.exec(text))) {
    const q = quotedAfter(text, m.index + m[0].length - 1);
    if (q && q.value.includes('=')) return q.value;
  }
  // -H 'cookie: <pairs>'  (case varies: HTTP/2 copies are lowercase)
  const hFlag = /(?:^|\s)(?:-H|--header)\s+(['"])/g;
  while ((m = hFlag.exec(text))) {
    const q = quotedAfter(text, m.index + m[0].length - 1);
    if (!q) continue;
    const header = q.value;
    const colon = header.indexOf(':');
    if (colon > 0 && header.slice(0, colon).trim().toLowerCase() === 'cookie') {
      return header.slice(colon + 1).trim();
    }
  }
  return null;
}

function findUrl(text) {
  const quoted = text.match(/(['"])(https?:\/\/[^'"]+)\1/);
  if (quoted) return quoted[2];
  const bare = text.match(/(?:^|\s)(https?:\/\/\S+)/);
  return bare ? bare[1].replace(/['"]+$/, '') : null;
}

function splitPairs(header) {
  const out = [];
  for (const part of String(header).split(';')) {
    const chunk = part.trim();
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: chunk.slice(0, eq).trim(), value: chunk.slice(eq + 1) });
  }
  return out;
}

function build(pairs, origin, host, { hostOnly }) {
  const seen = new Set();
  const cookies = [];
  for (const { name, value } of pairs) {
    if (seen.has(name)) continue; // the header may repeat a name; the first wins
    seen.add(name);

    const cookie = { name, value, path: '/', secure: origin.startsWith('https:') };
    // __Host- cookies are only ever valid host-only, so never widen them.
    if (hostOnly || name.startsWith('__Host-')) cookie.domain = host;
    else cookie.domain = `.${host.replace(/^\./, '')}`;
    cookie.url = `${origin}/`;
    cookies.push(cookie);
  }
  return cookies;
}

(async () => {
  const args = process.argv.slice(2);
  const hostOnly = args.includes('--host-only');
  const raw = await readStdin();
  if (!raw.trim()) {
    console.error('Nothing on stdin. Paste the DevTools "Copy as cURL" output into this command.');
    process.exit(2);
  }

  const header = findCookieHeader(raw);
  if (!header) {
    console.error('No Cookie header found. Copy a request that was sent while signed in (DevTools > Network > right-click > Copy > Copy as cURL).');
    process.exit(3);
  }

  const url = findUrl(raw);
  if (!url) {
    console.error('No request URL found in the paste, so the cookie domain cannot be derived.');
    process.exit(4);
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { console.error(`Unusable request URL: ${url}`); process.exit(4); }

  const cookies = build(splitPairs(header), parsedUrl.origin, parsedUrl.hostname, { hostOnly });
  if (!cookies.length) {
    console.error('The Cookie header held no name=value pairs.');
    process.exit(5);
  }

  process.stderr.write(`${cookies.length} cookie(s) from ${parsedUrl.hostname}\n`);
  process.stdout.write(`${JSON.stringify({ cookies }, null, 2)}\n`);
})().catch((error) => { console.error(error.message); process.exit(1); });
