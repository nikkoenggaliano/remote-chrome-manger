const fs = require('fs');
const db = require('./db');
const { commandExists, resolveChromeBinary } = require('./browser-finder');

function checkPath(pathStr) {
    return fs.existsSync(pathStr);
}

function runChecks() {
  const config = db.prepare('SELECT * FROM config').all().reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  const results = {
    chrome: { status: 'ok', msg: 'Found' },
    xvfb: { status: 'ok', msg: 'Found' },
    socat: { status: 'ok', msg: 'Found' }
  };

  let allOk = true;

  const resolvedChrome = resolveChromeBinary(config.chrome_bin);
  if (!resolvedChrome) {
    if ((config.chrome_bin || '').startsWith('/')) {
      results.chrome = { status: 'error', msg: `Not found at ${config.chrome_bin}` };
    } else {
      results.chrome = { status: 'error', msg: `Chrome binary not found. Configured value: ${config.chrome_bin || '(empty)'}` };
    }
    allOk = false;
  } else if (config.chrome_bin && resolvedChrome.value !== config.chrome_bin) {
    results.chrome = {
      status: 'ok',
      msg: `Configured "${config.chrome_bin}" unavailable, using "${resolvedChrome.value}"`,
    };
  } else {
    results.chrome = { status: 'ok', msg: `Found (${resolvedChrome.value})` };
  }

  // Check Xvfb (Warning only, as it might not be needed for all setups or on Mac)
  const xvfbBin = config.xvfb_bin || 'Xvfb';
  if (!commandExists(xvfbBin)) {
    results.xvfb = { status: 'warning', msg: `${xvfbBin} command not found (Headless display will fail)` };
  }

  // Check Socat (Warning only)
  if (!commandExists('socat')) {
    results.socat = { status: 'warning', msg: 'socat command not found (Port forwarding will fail)' };
  }

  return { ok: allOk, results };
}

module.exports = { runChecks };
