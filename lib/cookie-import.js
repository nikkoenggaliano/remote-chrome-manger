const { URL } = require('url');

function normalizeSameSite(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unspecified') return null;
  if (normalized === 'no_restriction' || normalized === 'none') return 'None';
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'strict') return 'Strict';
  return null;
}

function normalizeExpires(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function buildUrlFromCookie(domain, pathValue, secure) {
  if (!domain) return null;
  const host = String(domain).replace(/^\./, '').trim();
  if (!host) return null;
  const protocol = secure ? 'https:' : 'http:';
  const normalizedPath = pathValue && String(pathValue).startsWith('/') ? String(pathValue) : '/';
  return `${protocol}//${host}${normalizedPath}`;
}

function normalizeCookieObject(rawCookie, sourceName = 'cookie.json') {
  if (!rawCookie || typeof rawCookie !== 'object' || Array.isArray(rawCookie)) {
    throw new Error(`Invalid cookie entry in ${sourceName}`);
  }

  const name = rawCookie.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`Cookie name is missing in ${sourceName}`);
  }

  const secure = Boolean(rawCookie.secure);
  const pathValue = typeof rawCookie.path === 'string' && rawCookie.path.trim() ? rawCookie.path.trim() : '/';
  const urlValue = typeof rawCookie.url === 'string' && rawCookie.url.trim() ? rawCookie.url.trim() : null;
  const domainValue = typeof rawCookie.domain === 'string' && rawCookie.domain.trim() ? rawCookie.domain.trim() : null;

  const normalized = {
    name,
    value: rawCookie.value === undefined || rawCookie.value === null ? '' : String(rawCookie.value),
    path: pathValue,
    secure,
    httpOnly: Boolean(rawCookie.httpOnly ?? rawCookie.http_only ?? rawCookie.httponly),
  };

  const sameSite = normalizeSameSite(rawCookie.sameSite ?? rawCookie.same_site);
  if (sameSite) {
    normalized.sameSite = sameSite;
  }

  const expires = normalizeExpires(rawCookie.expires ?? rawCookie.expirationDate ?? rawCookie.expiry);
  if (expires) {
    normalized.expires = expires;
  }

  if (urlValue) {
    normalized.url = urlValue;
    if (!domainValue) {
      try {
        normalized.domain = new URL(urlValue).hostname;
      } catch (error) {
        throw new Error(`Invalid cookie url in ${sourceName}: ${urlValue}`);
      }
    }
  }

  if (domainValue) {
    normalized.domain = domainValue;
  }

  if (!normalized.url && !normalized.domain) {
    throw new Error(`Cookie "${name}" in ${sourceName} is missing domain/url`);
  }

  if (!normalized.url && normalized.domain) {
    normalized.url = buildUrlFromCookie(normalized.domain, normalized.path, normalized.secure);
  }

  return normalized;
}

function splitNetscapeLine(line) {
  if (line.includes('\t')) {
    const parts = line.split('\t');
    if (parts.length >= 7) {
      return [...parts.slice(0, 6), parts.slice(6).join('\t')];
    }
  }

  const match = line.match(/^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(-?\d+)\s+(\S+)\s+([\s\S]*)$/i);
  return match ? match.slice(1) : null;
}

function parseNetscapeCookieFile(text, sourceName) {
  const cookies = [];
  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;

    const httpOnly = line.startsWith('#HttpOnly_');
    const normalizedLine = httpOnly ? line.replace(/^#HttpOnly_/, '') : line;
    const parts = splitNetscapeLine(normalizedLine);
    if (!parts) {
      throw new Error(`Unsupported Netscape cookie row in ${sourceName}: ${rawLine}`);
    }

    const [domainRaw, , pathRaw, secureRaw, expiresRaw, nameRaw, valueRaw] = parts;
    const cookie = normalizeCookieObject({
      name: nameRaw,
      value: valueRaw,
      domain: domainRaw,
      path: pathRaw,
      secure: secureRaw.toUpperCase() === 'TRUE',
      httpOnly,
      expires: expiresRaw,
    }, sourceName);

    cookies.push(cookie);
  }

  return cookies;
}

function parseJsonCookieFile(text, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourceName}`);
  }

  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.cookies)
      ? parsed.cookies
      : Array.isArray(parsed.data?.cookies)
        ? parsed.data.cookies
        : null;

  if (!items) {
    throw new Error(`Unsupported JSON cookie structure in ${sourceName}`);
  }

  return items.map((cookie) => normalizeCookieObject(cookie, sourceName));
}

function parseCookieFile(text, sourceName = 'cookies.txt') {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error(`Cookie file ${sourceName} is empty`);
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { format: 'json', cookies: parseJsonCookieFile(trimmed, sourceName) };
    } catch (jsonError) {
      try {
        return { format: 'netscape', cookies: parseNetscapeCookieFile(trimmed, sourceName) };
      } catch (netscapeError) {
        throw jsonError;
      }
    }
  }

  return { format: 'netscape', cookies: parseNetscapeCookieFile(trimmed, sourceName) };
}

function getCookieKey(cookie) {
  return [
    cookie.name || '',
    cookie.domain || '',
    cookie.path || '',
    cookie.url || '',
  ].join('\u0000');
}

function parseCookieFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('At least one cookie file is required');
  }

  const mergedMap = new Map();
  const parsedFiles = [];
  const errors = [];

  for (const file of files) {
    const name = typeof file?.name === 'string' && file.name.trim() ? file.name.trim() : 'cookies.txt';
    const content = typeof file?.content === 'string' ? file.content : '';

    try {
      const parsed = parseCookieFile(content, name);
      for (const cookie of parsed.cookies) {
        mergedMap.set(getCookieKey(cookie), cookie);
      }
      parsedFiles.push({
        name,
        format: parsed.format,
        cookie_count: parsed.cookies.length,
      });
    } catch (error) {
      errors.push({
        name,
        error: error.message,
      });
    }
  }

  const cookies = Array.from(mergedMap.values());
  if (cookies.length === 0) {
    const message = errors[0]?.error || 'No cookies could be parsed';
    throw new Error(message);
  }

  return {
    cookies,
    files: parsedFiles,
    errors,
  };
}

module.exports = {
  parseCookieFiles,
};
