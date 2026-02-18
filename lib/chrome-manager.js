const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const net = require('net');

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

const instances = new Map(); // Keep track of running processes

function nowIso() {
  return new Date().toISOString();
}

function appendLog(logFile, level, message) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] [Manager:${level}] ${message}\n`);
  } catch (err) {
    console.error(`[Manager] Failed writing log (${logFile}): ${err.message}`);
  }
}

function findFreeDisplay() {
  for (let d = 90; d <= 199; d++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${d}`)) {
      return `:${d}`;
    }
  }
  throw new Error('No free X display found');
}

function getCheckHost(host) {
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  return host;
}

// Reset all statuses to 'stopped' on startup
function resetStatuses() {
    db.prepare("UPDATE instances SET status = 'stopped'").run();
}

// Check if port is open
function checkPort(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            resolve(false);
        });
        socket.connect(port, host);
    });
}

function checkPortSync(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

async function waitForPortOpen(port, host = '127.0.0.1', timeoutMs = 12000, pollMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const alive = await checkPort(port, host);
    if (alive) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
}

function getListeningPids(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!out) return [];
    return out.split('\n').map(line => parseInt(line, 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignored
    }
  }
}

// Sync DB status with actual port status
async function syncStatuses() {
    const allInstances = db.prepare("SELECT * FROM instances").all();
    for (const inst of allInstances) {
        // If type is external, we might assume it's up, or check connectivity.
        // If type is local, and we are managing it, 'running' implies port open.
        
        // We only verify 'running' instances to see if they died silently
        if (inst.status === 'running') {
             const isAlive = await checkPort(inst.port, getCheckHost(inst.host));
             if (!isAlive) {
                 // It died or port closed
                 console.log(`[Manager] Instance ${inst.name} port ${inst.port} is closed. Marking as stopped.`);
                 stopInstance(inst.id); // Cleanup memory map if exists
                 db.prepare("UPDATE instances SET status = 'stopped' WHERE id = ?").run(inst.id);
             }
        }
    }
}

async function spawnInstance(id) {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
  if (!instance) throw new Error('Instance not found');

  if (instance.status === 'running') {
    return; // Already running
  }

  const chromeBin = getConfig('chrome_bin');
  const profilesDir = getConfig('profiles_dir');
  const xvfbBin = getConfig('xvfb_bin') || 'Xvfb';

  if (!chromeBin) throw new Error('Chrome binary path not configured');

  const { name, port, forward_port, use_xvfb, use_socat, profile_dir } = instance;
  
  // Use specific profile dir if set, otherwise use default structure under profilesDir
  const fullProfileDir = profile_dir 
    ? path.resolve(profile_dir) 
    : path.resolve(profilesDir, name);

  if (!fs.existsSync(fullProfileDir)) {
    fs.mkdirSync(fullProfileDir, { recursive: true });
  }

  const logFile = path.join(fullProfileDir, 'chrome.log');
  const checkHost = getCheckHost(instance.host);
  appendLog(logFile, 'INFO', `Starting instance "${name}" (id=${id}, port=${port}, host=${instance.host}, checkHost=${checkHost}, platform=${process.platform})`);

  const env = { ...process.env };
  let display = null;
  let xvfbProc = null;

  if (use_xvfb) {
    if (process.platform === 'darwin') {
      console.log('[Manager] MacOS detected. Skipping Xvfb as per configuration.');
    } else {
      try {
        execSync(`command -v ${xvfbBin}`);
        display = findFreeDisplay();
        env.DISPLAY = display;
        xvfbProc = spawn(xvfbBin, [display, '-screen', '0', '1920x1080x24', '-ac', '+extension', 'GLX', '+render', '-noreset']);
        appendLog(logFile, 'INFO', `Xvfb started on display ${display} (pid=${xvfbProc.pid || 'n/a'})`);
        // Wait for Xvfb to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        appendLog(logFile, 'WARN', `Xvfb unavailable (${xvfbBin}): ${err.message}. Falling back to default display/headless.`);
        console.warn(`Xvfb (${xvfbBin}) not found or failed to start, falling back to default display or headless`);
      }
    }
  }

  const chromeArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--password-store=basic',
    `--user-data-dir=${fullProfileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*',
  ];

  const logStream = fs.openSync(logFile, 'a');

  const chromeProc = spawn(chromeBin, chromeArgs, { 
    env,
    stdio: ['ignore', logStream, logStream]
  });

  appendLog(logFile, 'INFO', `Spawned Chrome launcher pid=${chromeProc.pid || 'n/a'} bin="${chromeBin}"`);
  
  let socatProc = null;
  if (use_socat && forward_port) {
    socatProc = spawn('socat', [`TCP-LISTEN:${forward_port},reuseaddr,fork`, `TCP:127.0.0.1:${port}`], {
      stdio: ['ignore', logStream, logStream]
    });
    appendLog(logFile, 'INFO', `Spawned socat pid=${socatProc.pid || 'n/a'} forward=${forward_port} -> ${port}`);
  }

  const runtime = { chromeProc, xvfbProc, socatProc, display, logFile, logFd: logStream };
  instances.set(id, runtime);

  let chromeEarlyExit = null;
  chromeProc.on('error', (err) => {
    appendLog(logFile, 'ERROR', `Chrome process error: ${err.message}`);
  });
  chromeProc.on('close', (code, signal) => {
    appendLog(logFile, 'INFO', `Chrome process close event: code=${code} signal=${signal || 'null'}`);
  });
  chromeProc.on('exit', async (code, signal) => {
    appendLog(logFile, 'WARN', `Chrome process exit event: code=${code} signal=${signal || 'null'}`);
    chromeEarlyExit = { code, signal };
    const alive = await checkPort(port, checkHost);
    if (alive) {
      appendLog(logFile, 'INFO', `Port ${checkHost}:${port} still alive after launcher exit. Keeping status running.`);
      const current = instances.get(id);
      if (current) current.chromeProc = null;
      return;
    }

    appendLog(logFile, 'WARN', `Port ${checkHost}:${port} is closed after exit. Stopping instance.`);
    stopInstance(id, { reason: 'chrome_exit', skipChromeKill: true });
  });

  const portReady = await waitForPortOpen(port, checkHost, 12000, 250);
  if (!portReady) {
    const exitInfo = chromeEarlyExit ? `early_exit code=${chromeEarlyExit.code} signal=${chromeEarlyExit.signal || 'null'}` : 'no_exit_event';
    appendLog(logFile, 'ERROR', `Chrome failed to open debug port ${checkHost}:${port} within timeout (${exitInfo})`);
    stopInstance(id, { reason: 'startup_timeout' });
    throw new Error(`Chrome failed to start on ${checkHost}:${port}. See ${logFile}`);
  }

  appendLog(logFile, 'INFO', `Debug port is ready at ${checkHost}:${port}`);
  db.prepare('UPDATE instances SET status = ?, display = ? WHERE id = ?').run('running', display, id);
}

function stopInstance(id, options = {}) {
  const { reason = 'manual_stop', skipChromeKill = false } = options;
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
  const port = instance ? instance.port : null;

  const procs = instances.get(id);
  const logFile = procs?.logFile || getLogPath(id);
  appendLog(logFile, 'INFO', `Stopping instance id=${id} reason=${reason}`);

  if (procs) {
    if (!skipChromeKill && procs.chromeProc) {
      try { procs.chromeProc.kill('SIGTERM'); } catch {}
    }
    if (procs.socatProc) {
      try { procs.socatProc.kill('SIGTERM'); } catch {}
    }
    if (procs.xvfbProc) {
      try { procs.xvfbProc.kill('SIGTERM'); } catch {}
    }
    if (procs.logFd !== undefined && procs.logFd !== null) {
      try { fs.closeSync(procs.logFd); } catch {}
    }
    instances.delete(id);
  }

  // Fallback cleanup for macOS handoff or orphaned listeners.
  if (port && checkPortSync(port)) {
    const pids = getListeningPids(port);
    if (pids.length) {
      appendLog(logFile, 'WARN', `Fallback kill by port ${port}. PIDs: ${pids.join(', ')}`);
      killPids(pids);
    }
  }

  db.prepare('UPDATE instances SET status = ? WHERE id = ?').run('stopped', id);
}

function getInstances() {
  return db.prepare('SELECT * FROM instances').all();
}

function getLogPath(id) {
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!instance) return null;
    
    const profilesDir = getConfig('profiles_dir');
    const fullProfileDir = instance.profile_dir 
        ? path.resolve(instance.profile_dir) 
        : path.resolve(profilesDir, instance.name);
        
    return path.join(fullProfileDir, 'chrome.log');
}

module.exports = {
  spawnInstance,
  stopInstance,
  getInstances,
  getLogPath,
  resetStatuses,
  syncStatuses
};
