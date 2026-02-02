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

function findFreeDisplay() {
  for (let d = 90; d <= 199; d++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${d}`)) {
      return `:${d}`;
    }
  }
  throw new Error('No free X display found');
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

// Sync DB status with actual port status
async function syncStatuses() {
    const allInstances = db.prepare("SELECT * FROM instances").all();
    for (const inst of allInstances) {
        // If type is external, we might assume it's up, or check connectivity.
        // If type is local, and we are managing it, 'running' implies port open.
        
        // We only verify 'running' instances to see if they died silently
        if (inst.status === 'running') {
             const isAlive = await checkPort(inst.port, inst.host);
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
        // Wait for Xvfb to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
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

  const logFile = path.join(fullProfileDir, 'chrome.log');
  const logStream = fs.openSync(logFile, 'a');

  const chromeProc = spawn(chromeBin, chromeArgs, { 
    env,
    stdio: ['ignore', logStream, logStream]
  });
  
  let socatProc = null;
  if (use_socat && forward_port) {
    socatProc = spawn('socat', [`TCP-LISTEN:${forward_port},reuseaddr,fork`, `TCP:127.0.0.1:${port}`]);
  }

  instances.set(id, { chromeProc, xvfbProc, socatProc, display });

  db.prepare('UPDATE instances SET status = ?, display = ? WHERE id = ?').run('running', display, id);

  chromeProc.on('exit', () => {
    // Note: We don't close logStream here because fs.openSync returns a file descriptor integer, 
    // and spawn uses it. The OS closes it when the process exits? 
    // Actually better to let the child own it or close it if we passed a Stream object.
    // With integer fd, it persists? 
    // Safe way: fs.closeSync(logStream) might be premature if child is running.
    // Child process inherits the fd. We can close our reference.
    try { fs.closeSync(logStream); } catch(e) {}
    stopInstance(id);
  });
}

function stopInstance(id) {
  const procs = instances.get(id);
  if (procs) {
    if (procs.chromeProc) procs.chromeProc.kill();
    if (procs.socatProc) procs.socatProc.kill();
    if (procs.xvfbProc) procs.xvfbProc.kill();
    instances.delete(id);
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
