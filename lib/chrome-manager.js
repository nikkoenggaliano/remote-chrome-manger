const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { resolveChromeBinary } = require('./browser-finder');

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
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
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

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function getConfiguredLaunchMode(instance) {
  if (!instance || instance.type !== 'local') return 'external';

  const normalized = String(instance.launch_mode || '').trim().toLowerCase();
  if (['gui', 'xvfb', 'chrome_headless'].includes(normalized)) {
    return normalized;
  }

  return Boolean(instance.use_xvfb) ? 'xvfb' : 'chrome_headless';
}

function buildLaunchState(instance, options = {}) {
  const platform = options.platform || process.platform;
  const source = options.source || 'config';
  const reason = options.reason || null;
  const type = instance?.type || 'local';
  const launchMode = getConfiguredLaunchMode(instance);
  const xvfbSupported = !['darwin', 'win32'].includes(platform);

  if (type !== 'local') {
    return {
      launch_mode: 'external',
      launch_mode_label: 'External',
      launch_backend: 'external',
      launch_backend_label: 'External',
      headless_stack_enabled: false,
      xvfb_process_enabled: false,
      chrome_headless_enabled: false,
      xvfb_enabled: false,
      headless_enabled: false,
      headless_stack_requested: false,
      launch_state_source: source,
      launch_reason: reason || 'external_instance',
    };
  }

  if (launchMode === 'gui') {
    return {
      launch_mode: 'gui',
      launch_mode_label: 'GUI',
      launch_backend: 'gui',
      launch_backend_label: 'GUI',
      headless_stack_enabled: false,
      xvfb_process_enabled: false,
      chrome_headless_enabled: false,
      xvfb_enabled: false,
      headless_enabled: false,
      headless_stack_requested: false,
      launch_state_source: source,
      launch_reason: reason || 'gui_mode',
    };
  }

  if (launchMode === 'xvfb') {
    return {
      launch_mode: 'xvfb',
      launch_mode_label: 'Headless via Xvfb',
      launch_backend: 'xvfb',
      launch_backend_label: 'Xvfb',
      headless_stack_enabled: true,
      xvfb_process_enabled: xvfbSupported,
      chrome_headless_enabled: false,
      xvfb_enabled: true,
      headless_enabled: true,
      headless_stack_requested: true,
      launch_state_source: source,
      launch_reason: reason || (xvfbSupported ? 'use_xvfb_backend' : 'xvfb_unsupported_platform'),
    };
  }

  return {
    launch_mode: 'chrome_headless',
    launch_mode_label: 'Native Chrome Headless',
    launch_backend: 'chrome_headless',
    launch_backend_label: 'Chrome Headless',
    headless_stack_enabled: true,
    xvfb_process_enabled: false,
    chrome_headless_enabled: true,
    xvfb_enabled: false,
    headless_enabled: true,
    headless_stack_requested: true,
    launch_state_source: source,
    launch_reason: reason || 'native_chrome_headless',
  };
}

function getInstanceLaunchState(instance) {
  if (!instance) return null;
  const runtime = instances.get(instance.id);
  if (runtime?.launchState) {
    return { ...runtime.launchState };
  }
  return buildLaunchState(instance, { source: 'config' });
}

// Reset all statuses to 'stopped' on startup
function resetStatuses() {
    db.prepare("UPDATE instances SET status = 'stopped', display = NULL").run();
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
                 db.prepare("UPDATE instances SET status = 'stopped', display = NULL WHERE id = ?").run(inst.id);
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
  if (instance.status === 'starting') {
    throw new Error('Instance is already starting. Please wait.');
  }
  if (instances.has(id)) {
    throw new Error('Instance process is already being managed.');
  }

  const configuredChromeBin = getConfig('chrome_bin');
  const resolvedChrome = resolveChromeBinary(configuredChromeBin);
  const profilesDir = getConfig('profiles_dir');
  const xvfbBin = getConfig('xvfb_bin') || 'Xvfb';

  if (!resolvedChrome) {
    throw new Error(`Chrome binary path not configured or unavailable (${configuredChromeBin || 'empty'})`);
  }
  const chromeBin = resolvedChrome.value;

  const { name, port, forward_port, use_socat, profile_dir } = instance;
  
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
  if (configuredChromeBin && configuredChromeBin !== chromeBin) {
    appendLog(logFile, 'INFO', `Chrome binary fallback in use. configured="${configuredChromeBin}" resolved="${chromeBin}"`);
  }
  if (isTruthy(process.env.CHROME_MANAGER_FORCE_HEADLESS) || (process.platform === 'darwin' && isTruthy(process.env.CHROME_MANAGER_DARWIN_HEADLESS))) {
    appendLog(logFile, 'INFO', 'Legacy global headless env detected; per-instance launch_mode now has priority.');
  }

  const env = { ...process.env };
  let display = null;
  let xvfbProc = null;
  let launchState = buildLaunchState(instance, { source: 'runtime' });
  const hasGuiDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);

  if (launchState.launch_mode === 'gui' && process.platform === 'linux' && !hasGuiDisplay) {
    const errorMessage = 'GUI mode requires DISPLAY or WAYLAND_DISPLAY on Linux. Choose "Headless via Xvfb" or "Native Chrome Headless" instead.';
    appendLog(logFile, 'ERROR', errorMessage);
    throw new Error(errorMessage);
  }

  if (launchState.launch_mode === 'xvfb' && !launchState.xvfb_process_enabled) {
    const errorMessage = `Launch mode "Headless via Xvfb" is not supported on platform ${process.platform}.`;
    appendLog(logFile, 'ERROR', errorMessage);
    throw new Error(errorMessage);
  }

  db.prepare('UPDATE instances SET status = ?, display = ? WHERE id = ?').run('starting', null, id);

  if (launchState.xvfb_process_enabled) {
    try {
      execSync(`command -v ${xvfbBin}`);
      display = findFreeDisplay();
      env.DISPLAY = display;
      xvfbProc = spawn(xvfbBin, [display, '-screen', '0', '1920x1080x24', '-ac', '+extension', 'GLX', '+render', '-noreset']);
      appendLog(logFile, 'INFO', `Xvfb started on display ${display} (pid=${xvfbProc.pid || 'n/a'})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      const errorMessage = `Launch mode "Headless via Xvfb" failed because ${xvfbBin} is unavailable or failed to start: ${err.message}`;
      appendLog(logFile, 'ERROR', errorMessage);
      throw new Error(errorMessage);
    }
  }

  appendLog(
    logFile,
    'INFO',
    `Launch mode resolved: mode=${launchState.launch_mode}, backend=${launchState.launch_backend}, xvfb=${launchState.xvfb_enabled ? 'on' : 'off'}, headless=${launchState.headless_enabled ? 'on' : 'off'}, reason=${launchState.launch_reason}`
  );

  const chromeArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--password-store=basic',
    `--user-data-dir=${fullProfileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*',
    '--enable-logging',
    '--v=1',
    `--log-file=${logFile}`,
  ];

  const useHeadless = launchState.chrome_headless_enabled;
  const enableWebGL = process.env.CHROME_MANAGER_ENABLE_WEBGL !== '0';
  if (enableWebGL) {
    chromeArgs.push('--enable-webgl');
    chromeArgs.push('--ignore-gpu-blocklist');
    chromeArgs.push('--enable-gpu-rasterization');
    if (useHeadless) {
      // Headless WebGL is generally more reliable on software renderer.
      chromeArgs.push('--use-angle=swiftshader');
      chromeArgs.push('--use-gl=angle');
      chromeArgs.push('--enable-unsafe-swiftshader');
    } else if (process.platform === 'darwin') {
      chromeArgs.push('--use-angle=metal');
    }
    appendLog(logFile, 'INFO', 'WebGL startup flags enabled');
  } else {
    appendLog(logFile, 'INFO', 'WebGL startup flags disabled by CHROME_MANAGER_ENABLE_WEBGL=0');
  }

  // Keep old safe behavior only when not forcing WebGL.
  if (!enableWebGL) {
    chromeArgs.push('--disable-gpu');
  }

  if (useHeadless) {
    chromeArgs.push('--headless=new');
    chromeArgs.push('--hide-scrollbars');
    chromeArgs.push('--mute-audio');
    appendLog(logFile, 'INFO', `Headless mode enabled by resolved launch mode (${launchState.launch_reason})`);
  }

  const logStream = fs.openSync(logFile, 'a');

  let launchBin = chromeBin;
  let launchArgs = chromeArgs;
  let spawnOptions = {
    env,
    stdio: ['ignore', logStream, logStream]
  };

  const darwinUseOpen = process.platform === 'darwin' && !useHeadless && process.env.CHROME_MANAGER_DARWIN_USE_OPEN !== '0';
  const launchedViaOpen = darwinUseOpen;
  if (darwinUseOpen) {
    const bundleMatch = chromeBin.match(/(.+\.app)\/Contents\/MacOS\/[^/]+$/);
    const appTarget = bundleMatch ? bundleMatch[1] : 'Google Chrome';
    launchBin = 'open';
    launchArgs = ['-na', appTarget, '--args', ...chromeArgs];
    appendLog(logFile, 'INFO', `Darwin GUI mode: launching via open for app="${appTarget}"`);
  }

  const chromeProc = spawn(launchBin, launchArgs, spawnOptions);

  appendLog(logFile, 'INFO', `Spawned Chrome launcher pid=${chromeProc.pid || 'n/a'} bin="${launchBin}"`);
  
  let socatProc = null;
  if (use_socat && forward_port) {
    if (checkPortSync(forward_port)) {
      const staleForwardPids = getListeningPids(forward_port);
      if (staleForwardPids.length) {
        appendLog(logFile, 'WARN', `Forward port ${forward_port} already in use. Killing stale PIDs: ${staleForwardPids.join(', ')}`);
        killPids(staleForwardPids);
      }
    }
    socatProc = spawn('socat', [`TCP-LISTEN:${forward_port},reuseaddr,fork`, `TCP:127.0.0.1:${port}`], {
      stdio: ['ignore', logStream, logStream]
    });
    appendLog(logFile, 'INFO', `Spawned socat pid=${socatProc.pid || 'n/a'} forward=${forward_port} -> ${port}`);
  }

  const runtime = { chromeProc, xvfbProc, socatProc, display, logFile, logFd: logStream, launchState };
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

    if (launchedViaOpen) {
      const aliveAfterLauncherExit = await checkPort(port, checkHost);
      appendLog(
        logFile,
        'INFO',
        `Launcher exit via open detected (expected on macOS). Port alive=${aliveAfterLauncherExit}. Waiting for startup probe/sync.`
      );
      return;
    }

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
    if (darwinUseOpen && chromeEarlyExit && chromeEarlyExit.code === 1) {
      throw new Error(`Chrome failed to start on ${checkHost}:${port}. macOS GUI launch is unavailable for this process domain (launchd). Run server from logged-in desktop session (LaunchAgent/Aqua), not daemon/ssh-only session. See ${logFile}`);
    }
    throw new Error(`Chrome failed to start on ${checkHost}:${port}. See ${logFile}`);
  }

  appendLog(logFile, 'INFO', `Debug port is ready at ${checkHost}:${port}`);
  db.prepare('UPDATE instances SET status = ?, display = ? WHERE id = ?').run('running', display, id);
}

function stopInstance(id, options = {}) {
  const { reason = 'manual_stop', skipChromeKill = false } = options;
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
  const port = instance ? instance.port : null;
  const forwardPort = instance ? instance.forward_port : null;

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
  if (forwardPort && checkPortSync(forwardPort)) {
    const pids = getListeningPids(forwardPort);
    if (pids.length) {
      appendLog(logFile, 'WARN', `Fallback kill by forward_port ${forwardPort}. PIDs: ${pids.join(', ')}`);
      killPids(pids);
    }
  }

  db.prepare('UPDATE instances SET status = ?, display = ? WHERE id = ?').run('stopped', null, id);
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
  buildLaunchState,
  getInstanceLaunchState,
  spawnInstance,
  stopInstance,
  getInstances,
  getLogPath,
  resetStatuses,
  syncStatuses
};
