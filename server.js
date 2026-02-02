const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const basicAuth = require('express-basic-auth');
const db = require('./lib/db');
const chromeManager = require('./lib/chrome-manager');
const cdpClient = require('./lib/cdp-client');
const { runChecks } = require('./lib/dep-check');

// --- Server Log Capture ---
const serverLogs = [];
const MAX_LOGS = 200;
const originalLog = console.log;
const originalError = console.error;

function captureLog(type, args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const timestamp = new Date().toISOString();
    serverLogs.push(`[${timestamp}] [${type}] ${msg}`);
    if (serverLogs.length > MAX_LOGS) serverLogs.shift();
}

console.log = (...args) => { captureLog('INFO', args); originalLog.apply(console, args); };
console.error = (...args) => { captureLog('ERROR', args); originalError.apply(console, args); };

// --- Auth Check ---
const USERNAME = process.env.NIKKO_CHROME_USERNAME;
const PASSWORD = process.env.NIKKO_CHROME_PASSWORD;

if (!USERNAME || !PASSWORD) {
    // Bypass capture for this critical error so it appears in standard stderr clearly
    originalError('\x1b[31m%s\x1b[0m', 'ERROR: Authentication credentials missing!');
    originalError('Please set NIKKO_CHROME_USERNAME and NIKKO_CHROME_PASSWORD environment variables.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Auth Middleware
app.use(basicAuth({
    users: { [USERNAME]: PASSWORD },
    challenge: true,
    realm: 'Chrome Fleet Control'
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Check dependencies
console.log('Checking dependencies...');
const check = runChecks();
Object.entries(check.results).forEach(([tool, res]) => {
    const icon = res.status === 'ok' ? '✅' : (res.status === 'warning' ? '⚠️' : '❌');
    console.log(`${icon} ${tool}: ${res.msg}`);
});

if (!check.ok) {
    console.error('CRITICAL: Missing dependencies. Please check output above.');
    process.exit(1);
}

// Reset Statuses on Boot (Assume all local procs died with previous server)
console.log('Resetting instance statuses...');
chromeManager.resetStatuses();

// Periodic Sync (Every 10s)
setInterval(async () => {
    await chromeManager.syncStatuses();
    broadcastUpdate();
}, 10000);

// Helper: Get Network Interfaces
function getNetworkInterfaces() {
    const nets = os.networkInterfaces();
    const results = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                results.push({ name, address: net.address });
            }
        }
    }
    return results;
}

function getDiskUsage() {
    try {
        // Run df -k on current directory to get usage of the relevant partition
        const output = execSync('df -k .').toString();
        const lines = output.trim().split('\n');
        // Expected format: Filesystem 1K-blocks Used Available Use% Mounted on
        // Line 1 is header, Line 2 is data
        if (lines.length < 2) return null;
        
        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length < 6) return null;

        // parts[1] = Total 1K-blocks
        // parts[2] = Used 1K-blocks
        // parts[3] = Available 1K-blocks
        // parts[4] = Use%
        
        return {
            total: parseInt(parts[1]) * 1024,
            used: parseInt(parts[2]) * 1024,
            free: parseInt(parts[3]) * 1024,
            percent: parts[4]
        };
    } catch (e) {
        console.error('Error getting disk usage:', e.message);
        return null;
    }
}

function broadcastUpdate() {
  const instances = chromeManager.getInstances().map(inst => {
     return { ...inst, interfaces: getNetworkInterfaces() };
  });
  io.emit('instances_updated', instances);
}

// --- Routes ---

function getMemoryStats() {
    const total = os.totalmem();
    let free = os.freemem();

    if (os.platform() === 'darwin') {
        try {
            // On macOS, os.freemem() is very low because it doesn't include inactive memory.
            // We use vm_stat to get a better picture.
            const vmStat = execSync('vm_stat').toString();
            const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
            const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 4096;

            const freePagesMatch = vmStat.match(/Pages free:\s+(\d+)/);
            const inactivePagesMatch = vmStat.match(/Pages inactive:\s+(\d+)/);

            if (freePagesMatch && inactivePagesMatch) {
                const freePages = parseInt(freePagesMatch[1]);
                const inactivePages = parseInt(inactivePagesMatch[1]);
                // Available memory = free + inactive
                free = (freePages + inactivePages) * pageSize;
            }
        } catch (e) {
            // Fallback to os.freemem()
        }
    }
    return { total, free };
}

// System Stats & Logs
app.get('/api/server/stats', (req, res) => {
    const mem = getMemoryStats();
    res.json({
        platform: os.platform(),
        release: os.release(),
        uptime: os.uptime(),
        loadavg: os.loadavg(),
        totalmem: mem.total,
        freemem: mem.free,
        cpus: os.cpus().length,
        cpu_model: os.cpus()[0].model,
        interfaces: getNetworkInterfaces(),
        disk: getDiskUsage()
    });
});

app.get('/api/server/logs', (req, res) => {
    res.json(serverLogs);
});

// Config
app.get('/api/config', (req, res) => {
    const config = db.prepare('SELECT * FROM config').all();
    const configMap = config.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});
    res.json(configMap);
});

app.post('/api/config', (req, res) => {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'Missing key or value' });
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
    res.json({ success: true });
});

app.delete('/api/config/:key', (req, res) => {
    db.prepare('DELETE FROM config WHERE key = ?').run(req.params.key);
    res.json({ success: true });
});

// Instances
app.get('/api/instances', (req, res) => {
    const instances = chromeManager.getInstances().map(inst => {
        return { ...inst, interfaces: getNetworkInterfaces() };
    });
    res.json(instances);
});

app.post('/api/instances', (req, res) => {
  const { name, type, host, port, forward_port, use_xvfb, use_socat, profile_dir, notes } = req.body;
  
  // Check for duplicates
  const existing = db.prepare('SELECT * FROM instances WHERE name = ? OR port = ? OR (forward_port = ? AND forward_port IS NOT NULL)').get(name, port, forward_port);
  
  if (existing) {
      let field = 'Field';
      if (existing.name === name) field = 'Name';
      else if (existing.port === parseInt(port)) field = 'Debug Port';
      else if (existing.forward_port === parseInt(forward_port)) field = 'Forward Port';
      return res.status(400).json({ error: `${field} is already in use.` });
  }

  try {
    const info = db.prepare(`
      INSERT INTO instances (name, type, host, port, forward_port, use_xvfb, use_socat, profile_dir, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, host, port, forward_port, use_xvfb ? 1 : 0, use_socat ? 1 : 0, profile_dir, notes);
    res.json({ id: info.lastInsertRowid });
    broadcastUpdate();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update Instance (Partial)
app.put('/api/instances/:id', (req, res) => {
    const { id } = req.params;
    const updates = req.body; // Expect { port: 123, ... }
    
    // Stop if running (safety)
    const current = db.prepare('SELECT status FROM instances WHERE id = ?').get(id);
    if (current && current.status === 'running') {
        return res.status(400).json({ error: 'Cannot edit running instance. Stop it first.' });
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    
    try {
        db.prepare(`UPDATE instances SET ${fields} WHERE id = ?`).run(...values, id);
        res.json({ success: true });
        broadcastUpdate();
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/instances/:id', (req, res) => {
  const { id } = req.params;
  chromeManager.stopInstance(id);
  db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  res.json({ success: true });
  broadcastUpdate();
});

app.post('/api/instances/:id/start', async (req, res) => {
  try {
    await chromeManager.spawnInstance(req.params.id);
    res.json({ success: true });
    broadcastUpdate();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/instances/:id/stop', (req, res) => {
  chromeManager.stopInstance(req.params.id);
  res.json({ success: true });
  broadcastUpdate();
});

app.get('/api/instances/:id/logs', (req, res) => {
    const logPath = chromeManager.getLogPath(req.params.id);
    if (!logPath || !fs.existsSync(logPath)) {
        return res.json({ logs: 'No log file found.' });
    }
    // Read last 10KB
    const stats = fs.statSync(logPath);
    const size = stats.size;
    const start = Math.max(0, size - 10000);
    const stream = fs.createReadStream(logPath, { start, encoding: 'utf8' });
    let data = '';
    stream.on('data', chunk => data += chunk);
    stream.on('end', () => res.json({ logs: data }));
});

// CDP Proxy Routes
app.get('/api/instances/:id/tabs', async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).send('Not found');
  const tabs = await cdpClient.getTabs(instance.host, instance.port);
  res.json(tabs);
});

app.post('/api/instances/:id/tabs/new', async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  const { url } = req.body;
  const tab = await cdpClient.newTab(instance.host, instance.port, url);
  res.json(tab);
});

app.post('/api/instances/:id/tabs/:tabId/navigate', async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  const { url } = req.body;
  await cdpClient.navigateTab(instance.host, instance.port, req.params.tabId, url);
  res.json({ success: true });
});

app.delete('/api/instances/:id/tabs/:tabId', async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  await cdpClient.closeTab(instance.host, instance.port, req.params.tabId);
  res.json({ success: true });
});

app.get('/api/instances/:id/tabs/:tabId/screenshot', async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
  const data = await cdpClient.captureScreenshot(instance.host, instance.port, req.params.tabId);
  if (data) {
    res.type('image/jpeg').send(Buffer.from(data, 'base64'));
  } else {
    res.status(500).send('Failed to capture screenshot');
  }
});

app.post('/api/instances/:id/tabs/:tabId/input', async (req, res) => {
    const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id);
    const { type, params } = req.body;
    try {
        if (type === 'mouse') {
            await cdpClient.sendInput(instance.host, instance.port, req.params.tabId, 'Input.dispatchMouseEvent', params);
        } else if (type === 'key') {
             await cdpClient.sendInput(instance.host, instance.port, req.params.tabId, 'Input.dispatchKeyEvent', params);
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

io.on('connection', (socket) => {
  broadcastUpdate();
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
