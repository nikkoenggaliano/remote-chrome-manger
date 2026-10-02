// Parsing and vetting for the extra Chrome switches an instance may carry.
//
// The subtle part is quoting. Instances are launched with spawn() and no shell,
// so argv reaches Chrome exactly as written. People copy flags straight out of
// a terminal, where the shell would have removed the quotes:
//
//   --proxy-server="http://127.0.0.1:1"
//
// Passed through verbatim, Chrome receives the quotes as part of the value and
// the proxy silently never applies. So quotes are honoured for grouping and
// then stripped, the way a shell would.

// Switches the manager depends on. Letting an instance override these does not
// fail loudly, it fails weirdly: CDP becomes unreachable, the profile moves, or
// the logs land somewhere nothing reads. Rejected with a reason instead.
const RESERVED = new Map([
  ['--remote-debugging-port', 'the manager assigns this from the instance port'],
  ['--remote-debugging-pipe', 'moves CDP off the port the manager controls, so the instance never comes up'],
  ['--remote-debugging-address', 'the manager binds this itself'],
  ['--remote-allow-origins', 'the manager sets this so the dashboard can connect'],
  ['--user-data-dir', 'set the profile directory on the instance instead'],
  ['--log-file', 'the manager keeps chrome.log next to the profile'],
  ['--headless', 'choose the launch mode on the instance instead'],
]);

function reservedReason(flagName) {
  if (RESERVED.has(flagName)) return RESERVED.get(flagName);
  // --headless=new and friends.
  for (const [reserved, reason] of RESERVED) {
    if (flagName.startsWith(`${reserved}=`)) return reason;
  }
  return null;
}

// A comment runs to the end of its line, so it has to go before whitespace
// splitting; stripping a lone "#" token would leave the rest of the sentence
// behind to be parsed as switches.
function stripComments(text) {
  return String(text)
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');
}

// Split on whitespace, but keep quoted runs together, then drop the quotes.
// Handles both the one-per-line and the all-on-one-line styles people paste.
function tokenize(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens.filter((t) => t.length);
}

/**
 * Normalise whatever the caller sent into a clean list of switches.
 * Accepts an array of strings or one blob of text (newlines or spaces).
 * Throws on anything that would quietly break the instance.
 */
function parseChromeFlags(input) {
  if (input === undefined || input === null || input === '') return [];

  let tokens;
  if (Array.isArray(input)) {
    // Each entry may itself still be a quoted "--flag=value" pair.
    tokens = input.flatMap((entry) => tokenize(stripComments(entry)));
  } else if (typeof input === 'string') {
    tokens = tokenize(stripComments(input));
  } else {
    throw new Error('chrome_flags must be an array of switches or a string');
  }

  const seen = new Set();
  const flags = [];
  for (const token of tokens) {
    if (!token.startsWith('--')) {
      throw new Error(`Chrome switches must start with "--": got ${JSON.stringify(token)}`);
    }
    const name = token.split('=', 1)[0];
    const reason = reservedReason(name);
    if (reason) {
      throw new Error(`${name} is managed by the server and cannot be overridden: ${reason}`);
    }
    // A repeated switch is almost always a mistake, and which one wins is not
    // obvious, so keep the first and drop the rest rather than guess.
    if (seen.has(name)) continue;
    seen.add(name);
    flags.push(token);
  }
  return flags;
}

// Stored as JSON so the value survives round-tripping unambiguously, but older
// rows may hold a bare string; read both.
function readStoredFlags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const text = String(value).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter((f) => typeof f === 'string');
    } catch { /* fall through to text parsing */ }
  }
  try { return parseChromeFlags(text); } catch { return []; }
}

function serializeFlags(flags) {
  return flags && flags.length ? JSON.stringify(flags) : null;
}

module.exports = { parseChromeFlags, readStoredFlags, serializeFlags, tokenize, stripComments, RESERVED };
