const { spawn, execSync, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { resolveChromeBinary } = require('./browser-finder');
const { readStoredFlags } = require('./chrome-flags');

const net = require('net');

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

const instances = new Map(); // Keep track of running processes

function nowIso() {
  return new Date().toISOString();
}

// The manager used to write its diagnostics into chrome.log alongside Chrome.
// That silently threw them away: Chrome opens its --log-file in truncate mode,
// so every line explaining *why* an instance launched the way it did was wiped
// the moment the browser started. Verified directly; a line written before the
// spawn was gone four seconds later. The manager now keeps its own file.
const MANAGER_LOG_MAX_BYTES = 1024 * 1024;

function appendLog(logFile, level, message) {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // Nothing else trims this file, so keep it from growing without bound.
    try {
      if (fs.statSync(logFile).size > MANAGER_LOG_MAX_BYTES) {
        const kept = fs.readFileSync(logFile, 'utf8').slice(-Math.floor(MANAGER_LOG_MAX_BYTES / 2));
        fs.writeFileSync(logFile, `[${nowIso()}] [Manager:INFO] (log trimmed)\n${kept}`);
      }
    } catch { /* file may not exist yet */ }
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

  if (process.env.POP_UP_REAL_BROWSER !== undefined && process.env.POP_UP_REAL_BROWSER !== '') {
    if (isTruthy(process.env.POP_UP_REAL_BROWSER)) {
      return 'gui';
    } else {
      if (instance.use_xvfb || instance.launch_mode === 'xvfb') {
          return 'xvfb';
      }
      return 'chrome_headless';
    }
  }

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
    // Xvfb only exists on Linux-like platforms. On macOS/Windows there is no
    // virtual framebuffer to drive, so transparently fall back to native Chrome
    // headless instead of failing. Linux keeps real Xvfb (and still errors at
    // spawn time if the Xvfb binary is actually missing).
    if (!xvfbSupported) {
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
        launch_reason: reason || `xvfb_unsupported_on_${platform}_fell_back_to_chrome_headless`,
      };
    }
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
      launch_reason: reason || 'use_xvfb_backend',
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
    healthFailures.clear();
    instancePids.clear();
    db.prepare("UPDATE instances SET status = 'stopped', display = NULL, started_at = NULL").run();
}

// How long a single liveness probe may take. The old 500 ms was short enough
// that an event-loop stall (see the async `ps`/`lsof` helpers below) or one
// dropped packet to a LAN instance host could expire the timer while the port
// was in fact wide open — and the watchdog killed the browser over it.
const PORT_PROBE_TIMEOUT_MS = Math.max(
  500,
  parseInt(process.env.CHROME_MANAGER_PROBE_TIMEOUT_MS || '', 10) || 2500
);

// Consecutive failed probes before the watchdog is allowed to declare an
// instance dead. Probes run every 10 s, so the default gives a ~30 s grace
// window instead of acting on a single unlucky sample.
const HEALTH_FAILURE_LIMIT = Math.max(
  1,
  parseInt(process.env.CHROME_MANAGER_HEALTH_FAILURES || '', 10) || 3
);

// id -> consecutive failed probes, reset on any successful probe.
const healthFailures = new Map();

// Check if port is open
function checkPort(port, host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        // Destroy on error too — the old handler resolved without releasing the
        // socket, leaking a descriptor per failed probe.
        socket.on('error', () => finish(false));
        socket.connect(port, host);
    });
}

// Second opinion before the watchdog condemns an instance: a TCP connect can
// fail for reasons that have nothing to do with the browser being gone, but a
// successful /json/version means the browser is demonstrably serving CDP.
function checkDebugEndpoint(port, host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ host, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 500;
      res.resume();
      finish(ok);
    });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

// An instance counts as alive if either probe succeeds.
async function probeInstanceAlive(instance) {
  const host = getCheckHost(instance.host);
  if (await checkPort(instance.port, host)) return true;
  return checkDebugEndpoint(instance.port, host);
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

// `execSync` blocks the whole event loop, and these helpers sit on hot paths:
// memory accounting runs for every instance on every 10 s sync tick *and* on
// every tab open/close. A stalled loop makes armed socket timers fire late, so
// a liveness probe could time out against a perfectly healthy port and the
// watchdog would then kill the browser — closing a tab was enough to trigger
// it. Everything on those paths now shells out asynchronously.
function execFileAsync(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(String(stdout || ''));
    });
  });
}

// One `ps` snapshot for the whole fleet instead of one per instance.
async function psSnapshot() {
  const out = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  const childrenByPpid = new Map();
  const rssKbByPid = new Map();
  for (const line of out.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const rssKb = parseInt(parts[2], 10);
    if (!Number.isFinite(pid)) continue;
    rssKbByPid.set(pid, Number.isFinite(rssKb) ? rssKb : 0);
    if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
    childrenByPpid.get(ppid).push(pid);
  }
  return { childrenByPpid, rssKbByPid };
}

// One `lsof` call listing every listening socket, parsed into port -> pids.
// `-F pn` emits a `p<pid>` line per process followed by its `n<addr>` lines.
async function listeningPidsByPort() {
  const out = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
  const byPort = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = parseInt(line.slice(1), 10);
    } else if (line.startsWith('n') && Number.isFinite(pid)) {
      const port = parseInt(String(line.slice(1)).split(':').pop(), 10);
      if (!Number.isFinite(port)) continue;
      if (!byPort.has(port)) byPort.set(port, new Set());
      byPort.get(port).add(pid);
    }
  }
  return byPort;
}

function sumTreeRssBytes(rootPids, snapshot) {
  const roots = [...rootPids].filter(Number.isFinite);
  if (!roots.length) return null;
  const seen = new Set();
  const queue = [...roots];
  let totalKb = 0;
  let counted = false;
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (snapshot.rssKbByPid.has(pid)) {
      totalKb += snapshot.rssKbByPid.get(pid);
      counted = true;
    }
    const kids = snapshot.childrenByPpid.get(pid);
    if (kids) queue.push(...kids);
  }
  return counted ? totalKb * 1024 : null;
}

// instance id -> root pids of its browser process tree.
//
// Resolving those pids with `lsof` costs ~63 ms and, worse, scales with the
// number of listening sockets on the whole machine rather than with the number
// of instances. The pids do not change while a browser runs, so they are
// resolved once and reused; the cache self-heals because a pid that has left
// the process table is simply re-resolved.
const instancePids = new Map();

function rememberInstancePids(id, pids) {
  const list = [...pids].filter(Number.isFinite);
  if (list.length) instancePids.set(id, list);
}

function forgetInstancePids(id) {
  instancePids.delete(id);
}

// Resident memory for a whole set of instances. Returns Map<instanceId, bytes|null>.
async function getInstancesMemoryBytes(instanceList) {
  const local = (instanceList || []).filter(
    (i) => i && i.status === 'running' && (!i.type || i.type === 'local')
  );
  const result = new Map();
  if (!local.length) return result;

  const snapshot = await psSnapshot();
  const isAlive = (pid) => snapshot.rssKbByPid.has(pid);

  // Only shell out to lsof for instances whose pids we do not know, or whose
  // remembered pids have died. In the steady state that is none of them.
  const needsLookup = local.filter((instance) => {
    const cached = instancePids.get(instance.id);
    return !cached || !cached.some(isAlive);
  });

  if (needsLookup.length) {
    const byPort = await listeningPidsByPort();
    for (const instance of needsLookup) {
      const pids = byPort.get(instance.port);
      if (pids && pids.size) rememberInstancePids(instance.id, pids);
      else forgetInstancePids(instance.id);
    }
  }

  for (const instance of local) {
    const pids = instancePids.get(instance.id);
    result.set(instance.id, pids && pids.length ? sumTreeRssBytes(pids, snapshot) : null);
  }
  return result;
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

// Sync DB status with actual port status.
//
// This is a watchdog, and a watchdog that acts on one bad sample is worse than
// none: the previous version condemned an instance the moment a single 500 ms
// TCP probe missed, then called the full stopInstance() — SIGTERM plus a
// by-port kill sweep. A momentary stall or one dropped packet to a LAN
// instance host was therefore enough to kill a perfectly healthy browser and
// leave the row reading 'stopped'. Now a probe must fail HEALTH_FAILURE_LIMIT
// times in a row (and fail both the TCP and the CDP-HTTP check each time)
// before anything is torn down, and the teardown never sweeps the port.
async function syncStatuses() {
    const allInstances = db.prepare("SELECT * FROM instances").all();

    // Probe concurrently: a slow/unreachable host must not delay the instances
    // behind it in the loop and push their own probes towards the timeout.
    const running = allInstances.filter((inst) => inst.status === 'running');
    for (const inst of allInstances) {
        if (inst.status !== 'running') healthFailures.delete(inst.id);
    }

    await Promise.all(running.map(async (inst) => {
        if (await probeInstanceAlive(inst)) {
            healthFailures.delete(inst.id);
            return;
        }

        const failures = (healthFailures.get(inst.id) || 0) + 1;
        healthFailures.set(inst.id, failures);

        if (failures < HEALTH_FAILURE_LIMIT) {
            const message = `Instance ${inst.name} port ${inst.port} did not answer (${failures}/${HEALTH_FAILURE_LIMIT}). Not touching it yet.`;
            console.log(`[Manager] ${message}`);
            appendLog(getLogPath(inst.id), 'WARN', message);
            return;
        }

        const message = `Instance ${inst.name} port ${inst.port} unreachable for ${failures} consecutive checks. Marking as stopped.`;
        console.log(`[Manager] ${message}`);
        appendLog(getLogPath(inst.id), 'WARN', message);
        stopInstance(inst.id, { reason: 'health_check_failed', skipPortKill: true });
    }));
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

  const logFile = path.join(fullProfileDir, 'manager.log');
  const chromeLogFile = path.join(fullProfileDir, 'chrome.log');
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

  healthFailures.delete(id);
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
    `--log-file=${chromeLogFile}`,
  ];

  // Intranet targets frequently serve TLS certs from a private CA (e.g.
  // "Internal-SECLAB-NIKKO") that isn't in the container trust store, so Chrome
  // aborts the handshake with ERR_CERT_AUTHORITY_INVALID and the managed tab
  // stalls on the "Your connection is not private" interstitial instead of
  // rendering the page. When CHROME_MANAGER_IGNORE_CERT_ERRORS is truthy we tell
  // Chrome to skip certificate validation for the whole instance (covers both
  // the screenshot path and interactive navigation). Off by default so normal
  // public browsing still validates certificates.
  if (isTruthy(process.env.CHROME_MANAGER_IGNORE_CERT_ERRORS)) {
    chromeArgs.push('--ignore-certificate-errors');
    appendLog(logFile, 'INFO', 'TLS certificate validation disabled (CHROME_MANAGER_IGNORE_CERT_ERRORS)');
  }

  // `--v=1` was on for every instance. Measured, it wrote 436 KB/s under active
  // browsing, roughly 1.5 GB per hour per instance, with nothing rotating it.
  // Plain --enable-logging still records warnings and errors and wrote 2 KB
  // over the same four seconds.
  if (isTruthy(process.env.CHROME_MANAGER_VERBOSE_CHROME_LOG)) {
    chromeArgs.push('--v=1');
    appendLog(logFile, 'WARN', 'Verbose Chrome logging enabled (--v=1). Expect chrome.log to grow by roughly 1.5 GB per hour of active browsing.');
  }

  const useHeadless = launchState.chrome_headless_enabled;

  // Graphics flags: let Chrome pick, unless told otherwise.
  //
  // These used to force the SwiftShader stack on every instance to "make WebGL
  // work headlessly". Measured, that turned out to buy nothing and cost a lot,
  // because modern Chrome already falls back to SwiftShader for WebGL on its
  // own when there is no GPU:
  //
  //   Linux x86_64, no GPU     forced flags 120.6 ms/frame, no flags 73.6 ms
  //                            WebGL works either way, SwiftShader either way
  //   macOS (Apple GPU)        forced flags  87.9 ms/frame, no flags 40.7 ms
  //                            and without them WebGL runs on the real GPU
  //
  // So forcing them halved the live view's frame rate and, on a machine with a
  // GPU, downgraded WebGL to software as well. Both old behaviours stay
  // reachable for anyone who needs a deterministic renderer.
  const webglMode = String(process.env.CHROME_MANAGER_ENABLE_WEBGL ?? '').trim();
  if (webglMode === '0') {
    // No GPU stack at all: lightest, but WebGL is unavailable.
    chromeArgs.push('--disable-gpu');
    appendLog(logFile, 'INFO', 'GPU disabled by CHROME_MANAGER_ENABLE_WEBGL=0 (WebGL unavailable)');
  } else if (isTruthy(webglMode)) {
    chromeArgs.push('--enable-webgl');
    chromeArgs.push('--ignore-gpu-blocklist');
    chromeArgs.push('--enable-gpu-rasterization');
    if (useHeadless) {
      chromeArgs.push('--use-angle=swiftshader');
      chromeArgs.push('--use-gl=angle');
      chromeArgs.push('--enable-unsafe-swiftshader');
    } else if (process.platform === 'darwin') {
      chromeArgs.push('--use-angle=metal');
    }
    appendLog(logFile, 'INFO', 'Forced software WebGL stack (CHROME_MANAGER_ENABLE_WEBGL=1). Expect roughly half the capture rate.');
  } else {
    appendLog(logFile, 'INFO', 'Graphics flags left to Chrome (WebGL still available; fastest capture)');
  }

  if (useHeadless) {
    chromeArgs.push('--headless=new');
    chromeArgs.push('--hide-scrollbars');
    chromeArgs.push('--mute-audio');
    appendLog(logFile, 'INFO', `Headless mode enabled by resolved launch mode (${launchState.launch_reason})`);
  }

  // Chrome's stdout/stderr belong with Chrome's own log, not the manager's.
  // Per-instance switches last, so they sit after everything the manager set.
  // Anything that would collide with the manager's own flags is refused when
  // the instance is saved, not silently dropped here.
  const extraFlags = readStoredFlags(instance.chrome_flags);
  if (extraFlags.length) {
    chromeArgs.push(...extraFlags);
    appendLog(logFile, 'INFO', `Extra Chrome switches (${extraFlags.length}): ${extraFlags.join(' ')}`);
  }

  const logStream = fs.openSync(chromeLogFile, 'a');

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
  // We just launched it, so its pid is known without asking lsof. (On the macOS
  // `open` path this is the launcher, which exits; the cache notices the dead
  // pid on the next refresh and falls back to a lookup.)
  if (chromeProc.pid) rememberInstancePids(id, [chromeProc.pid]);

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
  db.prepare('UPDATE instances SET status = ?, display = ?, started_at = ? WHERE id = ?').run('running', display, nowIso(), id);
}

function stopInstance(id, options = {}) {
  // skipPortKill: never SIGTERM whatever happens to hold the port. The
  // by-port sweep is a deliberate hammer for an explicit stop; on the watchdog
  // path it is the opposite of what we want, because "the probe failed" is not
  // proof the browser is dead — and killing a live browser there is precisely
  // the bug where instances went 'stopped' on their own.
  const { reason = 'manual_stop', skipChromeKill = false, skipPortKill = false } = options;
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

  healthFailures.delete(id);
  forgetInstancePids(id);

  // Fallback cleanup for macOS handoff or orphaned listeners.
  if (!skipPortKill && port && checkPortSync(port)) {
    const pids = getListeningPids(port);
    if (pids.length) {
      appendLog(logFile, 'WARN', `Fallback kill by port ${port}. PIDs: ${pids.join(', ')}`);
      killPids(pids);
    }
  }
  if (!skipPortKill && forwardPort && checkPortSync(forwardPort)) {
    const pids = getListeningPids(forwardPort);
    if (pids.length) {
      appendLog(logFile, 'WARN', `Fallback kill by forward_port ${forwardPort}. PIDs: ${pids.join(', ')}`);
      killPids(pids);
    }
  }

  db.prepare('UPDATE instances SET status = ?, display = ?, started_at = NULL WHERE id = ?').run('stopped', null, id);
}

function getInstances() {
  return db.prepare('SELECT * FROM instances').all();
}

function getProfileDir(instance) {
    const profilesDir = getConfig('profiles_dir');
    return instance.profile_dir
        ? path.resolve(instance.profile_dir)
        : path.resolve(profilesDir, instance.name);
}

// The manager's own diagnostics. This is the one worth reading when an
// instance misbehaves; chrome.log is the browser's own noise.
function getLogPath(id) {
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!instance) return null;
    return path.join(getProfileDir(instance), 'manager.log');
}

function getChromeLogPath(id) {
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!instance) return null;
    return path.join(getProfileDir(instance), 'chrome.log');
}

module.exports = {
  buildLaunchState,
  getInstanceLaunchState,
  getInstancesMemoryBytes,
  spawnInstance,
  stopInstance,
  getInstances,
  getLogPath,
  getChromeLogPath,
  resetStatuses,
  syncStatuses
};
