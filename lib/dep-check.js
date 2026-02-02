const { execSync } = require('child_process');
const fs = require('fs');
const db = require('./db');

function checkCommand(command) {
  try {
    execSync(`command -v "${command}"`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

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

  // Check Chrome
  if (config.chrome_bin.startsWith('/')) {
      if (!checkPath(config.chrome_bin)) {
           results.chrome = { status: 'error', msg: `Not found at ${config.chrome_bin}` };
           allOk = false;
      }
  } else {
      if (!checkCommand(config.chrome_bin)) {
          results.chrome = { status: 'error', msg: `Command '${config.chrome_bin}' not found in PATH` };
          allOk = false;
      }
  }

  // Check Xvfb (Warning only, as it might not be needed for all setups or on Mac)
  const xvfbBin = config.xvfb_bin || 'Xvfb';
  if (!checkCommand(xvfbBin)) {
    results.xvfb = { status: 'warning', msg: `${xvfbBin} command not found (Headless display will fail)` };
  }

  // Check Socat (Warning only)
  if (!checkCommand('socat')) {
    results.socat = { status: 'warning', msg: 'socat command not found (Port forwarding will fail)' };
  }

  return { ok: allOk, results };
}

module.exports = { runChecks };
