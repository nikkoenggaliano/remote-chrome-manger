'use strict';

/*
 * One parser for every shape a browser session arrives in.
 *
 * The cookie importer only ever understood cookies, which is a problem,
 * because a great many apps keep nothing important in them: a Next.js or React
 * dashboard typically stores its JWT under a localStorage key and sends it as
 * "Authorization: Bearer <token>". Handed such a dump, the cookie parser could
 * only answer "Unsupported JSON cookie structure", which is true and useless.
 *
 * So this module sniffs the file instead of demanding a format, and hands back
 * cookies and storage separately.
 */

const { parseCookieFile } = require('./cookie-import');

// Fields a real cookie object carries. Used to tell one lone cookie object
// apart from a flat localStorage map, since both are "an object with strings".
const COOKIE_FIELDS = new Set([
  'name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'httponly', 'http_only',
  'sameSite', 'same_site', 'expires', 'expirationDate', 'expiry', 'url', 'hostOnly',
  'session', 'storeId', 'size', 'priority', 'sourceScheme', 'sourcePort',
  'partitionKey', 'partitionKeyOpaque',
]);

function looksLikeSingleCookie(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.name !== 'string') return false;
  if (value.value === undefined && value.domain === undefined && value.url === undefined) return false;
  return Object.keys(value).every((key) => COOKIE_FIELDS.has(key));
}

// Browser storage holds strings and nothing else. A number or an object in the
// dump would otherwise reach the page as "[object Object]" and break it in a
// way that is very hard to trace back to the import.
function toStorageString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function normalizeStorageMap(raw, sourceName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Storage section of ${sourceName} is not an object of key/value pairs`);
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key) continue;
    out[key] = toStorageString(value);
  }
  return out;
}

// [["token","eyJ..."], ...] is what Object.entries(localStorage) produces, and
// people do paste that.
function pairsToMap(list, sourceName) {
  const out = {};
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error(`Malformed key/value pair in ${sourceName}`);
    }
    out[entry[0]] = toStorageString(entry[1]);
  }
  return out;
}

function looksLikePairList(list) {
  return list.length > 0 && list.every((entry) => Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === 'string'
    && isPrimitive(entry[1]));
}

/**
 * Work out what a single uploaded file actually is.
 *
 * @returns {{kind: 'cookies'|'storage'|'mixed', format: string,
 *            cookies: object[], local: object, session: object}}
 */
function classifyFile(text, sourceName = 'upload') {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error(`${sourceName} is empty`);

  // Netscape cookies.txt is the only non-JSON shape worth supporting, and it
  // never starts with a brace or a bracket.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const parsed = parseCookieFile(trimmed, sourceName);
    return { kind: 'cookies', format: parsed.format, cookies: parsed.cookies, local: {}, session: {} };
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (error) {
    // Not JSON after all; a Netscape file whose first row begins oddly still
    // deserves a try before giving up.
    const parsed = parseCookieFile(trimmed, sourceName);
    return { kind: 'cookies', format: parsed.format, cookies: parsed.cookies, local: {}, session: {} };
  }

  if (Array.isArray(json)) {
    if (!json.length) throw new Error(`${sourceName} holds an empty list`);
    if (looksLikePairList(json)) {
      return { kind: 'storage', format: 'storage-pairs', cookies: [], local: pairsToMap(json, sourceName), session: {} };
    }
    const parsed = parseCookieFile(trimmed, sourceName);
    return { kind: 'cookies', format: parsed.format, cookies: parsed.cookies, local: {}, session: {} };
  }

  if (!json || typeof json !== 'object') {
    throw new Error(`Unsupported JSON in ${sourceName}`);
  }

  // A bundle that names its sections: the shape this project's own exports use,
  // and the shape a combined cookies + storage backup wants.
  const hasCookieSection = Array.isArray(json.cookies) || Array.isArray(json.data?.cookies);
  const hasStorageSection = json.localStorage !== undefined || json.sessionStorage !== undefined;
  if (hasCookieSection || hasStorageSection) {
    const cookieList = Array.isArray(json.cookies) ? json.cookies : (json.data?.cookies || []);
    const cookies = cookieList.length
      ? parseCookieFile(JSON.stringify(cookieList), sourceName).cookies
      : [];
    const local = json.localStorage === undefined ? {} : normalizeStorageMap(json.localStorage, sourceName);
    const session = json.sessionStorage === undefined ? {} : normalizeStorageMap(json.sessionStorage, sourceName);
    const kind = cookies.length && (Object.keys(local).length || Object.keys(session).length)
      ? 'mixed'
      : (cookies.length ? 'cookies' : 'storage');
    return { kind, format: 'bundle', cookies, local, session };
  }

  if (looksLikeSingleCookie(json)) {
    const parsed = parseCookieFile(JSON.stringify([json]), sourceName);
    return { kind: 'cookies', format: 'json', cookies: parsed.cookies, local: {}, session: {} };
  }

  // What is left is the plain localStorage dump: JSON.stringify(localStorage).
  const values = Object.values(json);
  if (values.length && values.every(isPrimitive)) {
    return { kind: 'storage', format: 'storage-map', cookies: [], local: normalizeStorageMap(json, sourceName), session: {} };
  }

  throw new Error(`Unrecognised structure in ${sourceName}. Expected cookies (array, {cookies:[…]}, or Netscape text) or a storage dump (JSON.stringify(localStorage)).`);
}

function cookieKey(cookie) {
  return `${cookie.name}\u0000${cookie.domain || ''}\u0000${cookie.path || '/'}`;
}

/**
 * Parse every uploaded file, keeping going past a bad one so the caller can
 * report which file failed instead of losing the whole upload to it.
 */
function parseSessionFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files supplied');
  }

  const cookies = [];
  const seenCookies = new Set();
  const local = {};
  const session = {};
  const report = [];
  const errors = [];

  for (const file of files) {
    const name = (file && typeof file.name === 'string' && file.name.trim()) ? file.name.trim() : 'upload';
    const content = file ? file.content : undefined;
    if (typeof content !== 'string') {
      errors.push({ name, error: 'File content must be a string' });
      continue;
    }

    let result;
    try {
      result = classifyFile(content, name);
    } catch (error) {
      errors.push({ name, error: error.message });
      continue;
    }

    let added = 0;
    for (const cookie of result.cookies) {
      const key = cookieKey(cookie);
      if (seenCookies.has(key)) continue;
      seenCookies.add(key);
      cookies.push(cookie);
      added += 1;
    }
    // Later files win for storage, which matches "upload the newer dump again".
    Object.assign(local, result.local);
    Object.assign(session, result.session);

    report.push({
      name,
      kind: result.kind,
      format: result.format,
      cookie_count: added,
      local_keys: Object.keys(result.local).length,
      session_keys: Object.keys(result.session).length,
    });
  }

  if (!report.length) {
    const detail = errors.map((e) => `${e.name}: ${e.error}`).join('; ');
    throw new Error(detail || 'None of the files could be read');
  }

  return { cookies, local, session, files: report, errors };
}

/**
 * "whygwn:token" and friends. Apps that keep the same token in both a storage
 * key and a cookie need both replaced, or the request carries a fresh token
 * next to a stale cookie and gets rejected in a way nobody can explain.
 */
function parseCookieMirrors(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\n,]+/);
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'object') {
      const cookie = String(entry.cookie || '').trim();
      const key = String(entry.key || '').trim();
      if (!cookie || !key) throw new Error('Each cookie mirror needs both "cookie" and "key"');
      out.push({ cookie, key });
      continue;
    }
    const text = String(entry).trim();
    if (!text) continue;
    const sep = text.indexOf(':');
    if (sep <= 0 || sep === text.length - 1) {
      throw new Error(`Cookie mirror "${text}" must look like cookieName:storageKey`);
    }
    out.push({ cookie: text.slice(0, sep).trim(), key: text.slice(sep + 1).trim() });
  }
  return out;
}

module.exports = {
  classifyFile,
  parseSessionFiles,
  parseCookieMirrors,
  toStorageString,
};
