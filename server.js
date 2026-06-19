const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('\x1b[31m%s\x1b[0m', 'ERROR: .env file not found!');
  console.error('Please copy .env.example to .env and configure it before running the server.');
  process.exit(1);
}
require('dotenv').config({ path: envPath });

const { execSync } = require('child_process');
const basicAuth = require('express-basic-auth');
const db = require('./lib/db');
const chromeManager = require('./lib/chrome-manager');
const cdpClient = require('./lib/cdp-client');
const { parseCookieFiles } = require('./lib/cookie-import');
const { runChecks } = require('./lib/dep-check');

// --- Server Log Capture ---
const serverLogs = [];
const MAX_LOGS = 200;
const originalLog = console.log;
const originalError = console.error;

function captureLog(type, args) {
  const msg = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');
  const timestamp = new Date().toISOString();
  serverLogs.push(`[${timestamp}] [${type}] ${msg}`);
  if (serverLogs.length > MAX_LOGS) serverLogs.shift();
}

console.log = (...args) => {
  captureLog('INFO', args);
  originalLog.apply(console, args);
};
console.error = (...args) => {
  captureLog('ERROR', args);
  originalError.apply(console, args);
};

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

// --- Auth Check ---
const USERNAME = process.env.CHROME_FLEET_USERNAME;
const PASSWORD = process.env.CHROME_FLEET_PASSWORD;
const REST_API_ENABLED = isTruthy(process.env.REST_API);
const REST_API_KEY = process.env.REST_API_KEY || '';

if (!USERNAME || !PASSWORD) {
  originalError('\x1b[31m%s\x1b[0m', 'ERROR: Authentication credentials missing!');
  originalError('Please set CHROME_FLEET_USERNAME and CHROME_FLEET_PASSWORD environment variables.');
  process.exit(1);
}

if (REST_API_ENABLED && !REST_API_KEY) {
  originalError('\x1b[31m%s\x1b[0m', 'ERROR: REST_API=true requires REST_API_KEY.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10mb' }));

const legacyApi = express.Router();
const restApi = express.Router();

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function withErrorBoundary(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error(`[API] ${req.method} ${req.originalUrl} failed:`, error.stack || error.message);
      }
      res.status(status).json({ error: error.message || 'Internal Server Error' });
    }
  };
}

function restCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}

function restApiAuth(req, res, next) {
  const bearerMatch = req.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  const providedApiKey = req.get('x-api-key') || (bearerMatch ? bearerMatch[1] : '');
  if (!providedApiKey || providedApiKey !== REST_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing REST API key' });
  }
  next();
}

function getNetworkInterfaces() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ name, address: net.address });
      }
    }
  }
  return results;
}

function getDiskUsage() {
  try {
    const output = execSync('df -k .').toString();
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;

    const parts = lines[1].replace(/\s+/g, ' ').split(' ');
    if (parts.length < 6) return null;

    return {
      total: parseInt(parts[1], 10) * 1024,
      used: parseInt(parts[2], 10) * 1024,
      free: parseInt(parts[3], 10) * 1024,
      percent: parts[4],
    };
  } catch (error) {
    console.error('Error getting disk usage:', error.message);
    return null;
  }
}

function getMemoryStats() {
  const total = os.totalmem();
  let free = os.freemem();

  if (os.platform() === 'darwin') {
    try {
      const vmStat = execSync('vm_stat').toString();
      const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

      const freePagesMatch = vmStat.match(/Pages free:\s+(\d+)/);
      const inactivePagesMatch = vmStat.match(/Pages inactive:\s+(\d+)/);

      if (freePagesMatch && inactivePagesMatch) {
        const freePages = parseInt(freePagesMatch[1], 10);
        const inactivePages = parseInt(inactivePagesMatch[1], 10);
        free = (freePages + inactivePages) * pageSize;
      }
    } catch (error) {
      // Fallback to os.freemem().
    }
  }

  return { total, free };
}

function captureCpuSnapshot() {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: cpu.times.idle,
      total,
    };
  });
}

let previousCpuSnapshot = captureCpuSnapshot();

function getCpuUsagePercent() {
  const currentSnapshot = captureCpuSnapshot();
  let idleDelta = 0;
  let totalDelta = 0;

  currentSnapshot.forEach((cpu, index) => {
    const previous = previousCpuSnapshot[index];
    if (!previous) return;
    idleDelta += cpu.idle - previous.idle;
    totalDelta += cpu.total - previous.total;
  });

  previousCpuSnapshot = currentSnapshot;

  if (totalDelta <= 0) return 0;
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number(usage.toFixed(2));
}

function getServerStatsPayload() {
  const mem = getMemoryStats();
  const cpus = os.cpus();
  const usedMemory = mem.total - mem.free;

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    totalmem: mem.total,
    freemem: mem.free,
    usedmem: usedMemory,
    memory_usage_percent: mem.total > 0 ? Number(((usedMemory / mem.total) * 100).toFixed(2)) : 0,
    cpus: cpus.length,
    cpu_model: cpus[0]?.model || 'Unknown CPU',
    cpu_usage_percent: getCpuUsagePercent(),
    interfaces: getNetworkInterfaces(),
    disk: getDiskUsage(),
  };
}

function buildConfigMap() {
  const config = db.prepare('SELECT * FROM config').all();
  return config.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function buildDebugEndpoints(instance, interfaces) {
  if (instance.host === '0.0.0.0') {
    return interfaces.map((iface) => ({
      interface: iface.name,
      host: iface.address,
      port: instance.port,
      url: `http://${iface.address}:${instance.port}`,
    }));
  }

  return [{
    interface: null,
    host: instance.host,
    port: instance.port,
    url: `http://${instance.host}:${instance.port}`,
  }];
}

function buildForwardTargets(instance, interfaces) {
  if (!instance.forward_port) return [];

  return interfaces.map((iface) => ({
    interface: iface.name,
    listen_host: iface.address,
    listen_port: instance.forward_port,
    target_host: '127.0.0.1',
    target_port: instance.port,
    route: `${iface.address}:${instance.forward_port} -> 127.0.0.1:${instance.port}`,
  }));
}

// Live tab counts + memory usage per running instance, refreshed by the
// periodic sync loop.
const instanceTabCounts = new Map();
const instanceMemoryBytes = new Map();

async function refreshTabCounts(instances) {
  const runningIds = new Set();
  await Promise.all(instances.map(async (instance) => {
    if (instance.status !== 'running') return;
    runningIds.add(instance.id);
    instanceMemoryBytes.set(instance.id, chromeManager.getInstanceMemoryBytes(instance));
    try {
      const tabs = await cdpClient.getTabs(instance.host, instance.port);
      const count = Array.isArray(tabs)
        ? tabs.filter((tab) => tab.type === 'page' || tab.type === undefined).length
        : null;
      instanceTabCounts.set(instance.id, count);
    } catch {
      instanceTabCounts.set(instance.id, null);
    }
  }));

  // Forget counts for instances that are no longer running.
  for (const id of instanceTabCounts.keys()) {
    if (!runningIds.has(id)) instanceTabCounts.delete(id);
  }
  for (const id of instanceMemoryBytes.keys()) {
    if (!runningIds.has(id)) instanceMemoryBytes.delete(id);
  }
}

function serializeInstance(instance, interfaces = getNetworkInterfaces()) {
  const forwardTargets = buildForwardTargets(instance, interfaces);
  const launchState = chromeManager.getInstanceLaunchState(instance);
  return {
    ...instance,
    tab_count: instanceTabCounts.has(instance.id) ? instanceTabCounts.get(instance.id) : null,
    memory_bytes: instanceMemoryBytes.has(instance.id) ? instanceMemoryBytes.get(instance.id) : null,
    use_xvfb: launchState?.launch_mode === 'xvfb',
    use_socat: Boolean(instance.use_socat),
    headless_stack_enabled: Boolean(launchState?.headless_stack_enabled),
    launch_mode: launchState?.launch_mode || instance.launch_mode || 'unknown',
    launch_mode_label: launchState?.launch_mode_label || 'Unknown',
    launch_backend: launchState?.launch_backend || 'unknown',
    launch_backend_label: launchState?.launch_backend_label || 'Unknown',
    xvfb_enabled: Boolean(launchState?.xvfb_enabled),
    headless_enabled: Boolean(launchState?.headless_enabled),
    headless_stack_requested: Boolean(launchState?.headless_stack_requested),
    launch_state_source: launchState?.launch_state_source || 'config',
    launch_reason: launchState?.launch_reason || null,
    interfaces,
    debug_endpoints: buildDebugEndpoints(instance, interfaces),
    forward_targets: forwardTargets,
    forward_to: forwardTargets.map((target) => target.route),
  };
}

function getSerializedInstances() {
  const interfaces = getNetworkInterfaces();
  return chromeManager.getInstances().map((instance) => serializeInstance(instance, interfaces));
}

function getInstanceSummaryCounts() {
  return chromeManager.getInstances().reduce((acc, instance) => {
    acc.total += 1;
    acc[instance.status] = (acc[instance.status] || 0) + 1;
    return acc;
  }, { total: 0, running: 0, starting: 0, stopped: 0 });
}

function broadcastUpdate() {
  io.emit('instances_updated', getSerializedInstances());
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value, fieldName) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  throw createHttpError(400, `Invalid boolean for "${fieldName}"`);
}

function parseLaunchMode(value, fieldName = 'launch_mode') {
  const normalized = normalizeString(value).toLowerCase();
  if (['gui', 'xvfb', 'chrome_headless', 'external'].includes(normalized)) {
    return normalized;
  }
  throw createHttpError(400, `Invalid value for "${fieldName}"`);
}

function parsePort(value, fieldName, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) {
    return null;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createHttpError(400, `Invalid port for "${fieldName}"`);
  }
  return port;
}

function validateInstancePayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError(400, 'Request body must be a JSON object');
  }

  const result = {};

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'name')) {
    const name = normalizeString(payload.name);
    if (!name) throw createHttpError(400, 'Instance name is required');
    result.name = name;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'type')) {
    const type = normalizeString(payload.type).toLowerCase();
    if (!['local', 'external'].includes(type)) {
      throw createHttpError(400, 'Instance type must be "local" or "external"');
    }
    result.type = type;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'host')) {
    const host = normalizeString(payload.host);
    if (!host) throw createHttpError(400, 'Host is required');
    result.host = host;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'port')) {
    result.port = parsePort(payload.port, 'port');
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'forward_port')) {
    result.forward_port = parsePort(payload.forward_port, 'forward_port', { allowNull: true });
  }

  const hasLaunchMode = Object.prototype.hasOwnProperty.call(payload, 'launch_mode');
  const hasLegacyUseXvfb = Object.prototype.hasOwnProperty.call(payload, 'use_xvfb');
  if (!partial || hasLaunchMode || hasLegacyUseXvfb) {
    if (hasLaunchMode) {
      result.launch_mode = parseLaunchMode(payload.launch_mode);
    } else if (hasLegacyUseXvfb) {
      result.launch_mode = parseBoolean(payload.use_xvfb ?? false, 'use_xvfb') ? 'xvfb' : 'chrome_headless';
    } else {
      result.launch_mode = 'chrome_headless';
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'use_socat')) {
    result.use_socat = parseBoolean(payload.use_socat ?? false, 'use_socat');
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'profile_dir')) {
    const profileDir = normalizeString(payload.profile_dir);
    result.profile_dir = profileDir || null;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'notes')) {
    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
    result.notes = notes || null;
  }

  return result;
}

function applyInstanceDefaults(instance) {
  const next = { ...instance };

  if (next.type === 'external') {
    next.launch_mode = 'external';
    next.use_xvfb = false;
    next.use_socat = false;
    next.forward_port = null;
    next.profile_dir = null;
    return next;
  }

  if (typeof next.launch_mode === 'undefined' || next.launch_mode === null || next.launch_mode === '') {
    next.launch_mode = next.use_xvfb ? 'xvfb' : 'chrome_headless';
  }

  if (!['gui', 'xvfb', 'chrome_headless'].includes(String(next.launch_mode).toLowerCase())) {
    throw createHttpError(400, 'Local instance launch_mode must be "gui", "xvfb", or "chrome_headless"');
  }
  next.launch_mode = String(next.launch_mode).toLowerCase();
  next.use_xvfb = next.launch_mode === 'xvfb';

  if (!next.use_socat) {
    next.forward_port = null;
  } else if (!next.forward_port) {
    next.forward_port = Number(next.port) + 1;
  }

  if (typeof next.use_socat === 'undefined') {
    next.use_socat = false;
  }

  return next;
}

function getInstanceByIdOrThrow(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw createHttpError(400, 'Invalid instance id');
  }

  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(numericId);
  if (!instance) {
    throw createHttpError(404, 'Instance not found');
  }
  return instance;
}

function ensureInstanceUniqueness(instance, excludeId = null) {
  const excludedId = excludeId ? Number(excludeId) : -1;
  const existing = db.prepare(`
    SELECT * FROM instances
    WHERE id != ?
      AND (
        name = ?
        OR port = ?
        OR (? IS NOT NULL AND forward_port = ?)
      )
    LIMIT 1
  `).get(excludedId, instance.name, instance.port, instance.forward_port, instance.forward_port);

  if (!existing) return;

  let field = 'Field';
  if (existing.name === instance.name) field = 'Name';
  else if (existing.port === instance.port) field = 'Debug Port';
  else if (instance.forward_port !== null && existing.forward_port === instance.forward_port) field = 'Forward Port';

  throw createHttpError(400, `${field} is already in use.`);
}

// --- Dependency Check ---
console.log('Checking dependencies...');
const check = runChecks();
Object.entries(check.results).forEach(([tool, result]) => {
  const icon = result.status === 'ok' ? '✅' : (result.status === 'warning' ? '⚠️' : '❌');
  console.log(`${icon} ${tool}: ${result.msg}`);
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
  await refreshTabCounts(chromeManager.getInstances());
  broadcastUpdate();
}, 10000);

// --- Handlers ---
async function handleGetServerStats(req, res) {
  res.json(getServerStatsPayload());
}

async function handleGetServerLogs(req, res) {
  res.json(serverLogs);
}

async function handleHealthz(req, res) {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    server: getServerStatsPayload(),
    instances: getInstanceSummaryCounts(),
  });
}

async function handleGetCapabilities(req, res) {
  const platform = os.platform();
  res.json({
    platform,
    xvfb_supported: !['darwin', 'win32'].includes(platform),
  });
}

async function handleGetConfig(req, res) {
  res.json(buildConfigMap());
}

async function handleSetConfig(req, res) {
  const key = normalizeString(req.body?.key);
  const value = req.body?.value;

  if (!key) {
    throw createHttpError(400, 'Missing key');
  }

  if (value === undefined || value === null) {
    throw createHttpError(400, 'Missing value');
  }

  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
  res.json({ success: true, key, value: String(value) });
}

async function handleDeleteConfig(req, res) {
  db.prepare('DELETE FROM config WHERE key = ?').run(req.params.key);
  res.json({ success: true, key: req.params.key });
}

async function handleGetInstances(req, res) {
  res.json(getSerializedInstances());
}

async function handleGetInstance(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  res.json(serializeInstance(instance));
}

async function handleCreateInstance(req, res) {
  const payload = applyInstanceDefaults(validateInstancePayload(req.body, { partial: false }));
  ensureInstanceUniqueness(payload);

  const info = db.prepare(`
    INSERT INTO instances (name, type, host, port, forward_port, launch_mode, use_xvfb, use_socat, profile_dir, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.name,
    payload.type,
    payload.host,
    payload.port,
    payload.forward_port,
    payload.launch_mode,
    payload.use_xvfb ? 1 : 0,
    payload.use_socat ? 1 : 0,
    payload.profile_dir,
    payload.notes
  );

  const instance = getInstanceByIdOrThrow(info.lastInsertRowid);
  broadcastUpdate();
  res.status(201).json({ id: info.lastInsertRowid, instance: serializeInstance(instance) });
}

async function handleUpdateInstance(req, res) {
  const current = getInstanceByIdOrThrow(req.params.id);
  if (current.status !== 'stopped') {
    throw createHttpError(400, 'Cannot edit a running or starting instance. Stop it first.');
  }

  const updates = validateInstancePayload(req.body, { partial: true });
  if (Object.keys(updates).length === 0) {
    throw createHttpError(400, 'No valid fields provided for update');
  }

  const next = applyInstanceDefaults({ ...current, ...updates });
  ensureInstanceUniqueness(next, current.id);

  const normalizedUpdates = { ...updates };
  if (
    Object.prototype.hasOwnProperty.call(normalizedUpdates, 'launch_mode') ||
    Object.prototype.hasOwnProperty.call(updates, 'use_xvfb') ||
    Object.prototype.hasOwnProperty.call(normalizedUpdates, 'type')
  ) {
    normalizedUpdates.launch_mode = next.launch_mode;
    normalizedUpdates.use_xvfb = next.use_xvfb;
  }
  const clientTouchedForwardPort = Object.prototype.hasOwnProperty.call(normalizedUpdates, 'forward_port');
  const currentAutoForward = current.forward_port === null || current.forward_port === current.port + 1;

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'use_socat') && normalizedUpdates.use_socat === false) {
    normalizedUpdates.forward_port = null;
  } else if (next.use_socat) {
    const shouldAutoRefreshForwardPort =
      (!clientTouchedForwardPort && Object.prototype.hasOwnProperty.call(normalizedUpdates, 'port') && currentAutoForward) ||
      (!clientTouchedForwardPort && Object.prototype.hasOwnProperty.call(normalizedUpdates, 'use_socat') && normalizedUpdates.use_socat === true && !current.forward_port) ||
      (clientTouchedForwardPort && normalizedUpdates.forward_port === null);

    if (shouldAutoRefreshForwardPort) {
      normalizedUpdates.forward_port = next.forward_port;
    }
  }

  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(normalizedUpdates)) {
    fields.push(`${key} = ?`);
    if (key === 'use_xvfb' || key === 'use_socat') {
      values.push(value ? 1 : 0);
    } else {
      values.push(value);
    }
  }

  db.prepare(`UPDATE instances SET ${fields.join(', ')} WHERE id = ?`).run(...values, current.id);
  const instance = getInstanceByIdOrThrow(current.id);
  broadcastUpdate();
  res.json({ success: true, instance: serializeInstance(instance) });
}

async function handleDeleteInstance(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  chromeManager.stopInstance(instance.id);
  db.prepare('DELETE FROM instances WHERE id = ?').run(instance.id);
  broadcastUpdate();
  res.json({ success: true, id: instance.id });
}

async function handleStartInstance(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  await chromeManager.spawnInstance(instance.id);
  const refreshed = getInstanceByIdOrThrow(instance.id);
  await refreshTabCounts([refreshed]);
  broadcastUpdate();
  res.json({ success: true, instance: serializeInstance(refreshed) });
}

async function handleStopInstance(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  chromeManager.stopInstance(instance.id);
  instanceTabCounts.delete(instance.id);
  const refreshed = getInstanceByIdOrThrow(instance.id);
  broadcastUpdate();
  res.json({ success: true, instance: serializeInstance(refreshed) });
}

async function handleGetInstanceLogs(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const logPath = chromeManager.getLogPath(instance.id);

  if (!logPath || !fs.existsSync(logPath)) {
    return res.json({ id: instance.id, log_path: logPath, logs: 'No log file found.' });
  }

  const stats = fs.statSync(logPath);
  const size = stats.size;
  const start = Math.max(0, size - 10000);
  const stream = fs.createReadStream(logPath, { start, encoding: 'utf8' });
  let data = '';

  stream.on('data', (chunk) => {
    data += chunk;
  });
  stream.on('end', () => {
    res.json({ id: instance.id, log_path: logPath, logs: data });
  });
  stream.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
}

async function handleGetTabs(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const tabs = await cdpClient.getTabs(instance.host, instance.port);
  res.json(tabs);
}

async function handleNewTab(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const url = normalizeString(req.body?.url) || 'about:blank';
  const tab = await cdpClient.newTab(instance.host, instance.port, url);
  await refreshTabCounts([instance]);
  broadcastUpdate();
  res.json(tab);
}

async function handleActivateTab(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  await cdpClient.bringToFront(instance.host, instance.port, req.params.tabId);
  res.json({ success: true });
}

async function handleNavigateTab(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const url = normalizeString(req.body?.url);
  if (!url) throw createHttpError(400, 'Missing url');

  await cdpClient.navigateTab(instance.host, instance.port, req.params.tabId, url);
  res.json({ success: true });
}

async function handleDeleteTab(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  await cdpClient.closeTab(instance.host, instance.port, req.params.tabId);
  await refreshTabCounts([instance]);
  broadcastUpdate();
  res.json({ success: true });
}

async function handleScreenshot(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const data = await cdpClient.captureScreenshot(instance.host, instance.port, req.params.tabId);
  if (!data) {
    throw createHttpError(500, 'Failed to capture screenshot');
  }
  res.type('image/jpeg').send(Buffer.from(data, 'base64'));
}

async function handleInput(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const type = req.body?.type;
  const params = req.body?.params;

  if (!type || !params) {
    throw createHttpError(400, 'Missing type or params');
  }

  if (type === 'mouse') {
    await cdpClient.sendInput(instance.host, instance.port, req.params.tabId, 'Input.dispatchMouseEvent', params);
  } else if (type === 'key') {
    await cdpClient.sendInput(instance.host, instance.port, req.params.tabId, 'Input.dispatchKeyEvent', params);
  } else if (type === 'text') {
    await cdpClient.sendInput(instance.host, instance.port, req.params.tabId, 'Input.insertText', params);
  } else {
    throw createHttpError(400, 'Input type must be "mouse", "key", or "text"');
  }

  res.json({ success: true });
}

async function handleImportCookies(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const files = Array.isArray(req.body?.files) ? req.body.files : null;

  if (!files || files.length === 0) {
    throw createHttpError(400, 'Missing cookie files');
  }

  if (instance.type === 'local' && instance.status !== 'running') {
    throw createHttpError(400, `Instance "${instance.name}" is ${instance.status}. Start it first so the CDP port ${instance.host}:${instance.port} is available.`);
  }

  let parsed;
  try {
    parsed = parseCookieFiles(files);
  } catch (error) {
    throw createHttpError(400, error.message);
  }

  const importResult = await cdpClient.importCookies(instance.host, instance.port, parsed.cookies);

  res.json({
    success: true,
    instance_id: instance.id,
    imported: importResult.imported,
    failed: importResult.failed,
    failures: importResult.failures,
    files: parsed.files,
    file_errors: parsed.errors,
    total_cookies: parsed.cookies.length,
  });
}

function registerRoutes(router) {
  router.get('/server/stats', withErrorBoundary(handleGetServerStats));
  router.get('/server/logs', withErrorBoundary(handleGetServerLogs));
  router.get('/server/healthz', withErrorBoundary(handleHealthz));
  router.get('/server/healtz', withErrorBoundary(handleHealthz));

  router.get('/capabilities', withErrorBoundary(handleGetCapabilities));
  router.get('/config', withErrorBoundary(handleGetConfig));
  router.post('/config', withErrorBoundary(handleSetConfig));
  router.delete('/config/:key', withErrorBoundary(handleDeleteConfig));

  router.get('/instances', withErrorBoundary(handleGetInstances));
  router.get('/instances/:id', withErrorBoundary(handleGetInstance));
  router.post('/instances', withErrorBoundary(handleCreateInstance));
  router.put('/instances/:id', withErrorBoundary(handleUpdateInstance));
  router.patch('/instances/:id', withErrorBoundary(handleUpdateInstance));
  router.delete('/instances/:id', withErrorBoundary(handleDeleteInstance));
  router.post('/instances/:id/start', withErrorBoundary(handleStartInstance));
  router.post('/instances/:id/spawn', withErrorBoundary(handleStartInstance));
  router.post('/instances/:id/stop', withErrorBoundary(handleStopInstance));
  router.get('/instances/:id/logs', withErrorBoundary(handleGetInstanceLogs));

  router.get('/instances/:id/tabs', withErrorBoundary(handleGetTabs));
  router.post('/instances/:id/tabs/new', withErrorBoundary(handleNewTab));
  router.post('/instances/:id/tabs/:tabId/activate', withErrorBoundary(handleActivateTab));
  router.post('/instances/:id/tabs/:tabId/navigate', withErrorBoundary(handleNavigateTab));
  router.delete('/instances/:id/tabs/:tabId', withErrorBoundary(handleDeleteTab));
  router.get('/instances/:id/tabs/:tabId/screenshot', withErrorBoundary(handleScreenshot));
  router.post('/instances/:id/tabs/:tabId/input', withErrorBoundary(handleInput));
  router.post('/instances/:id/cookies/import', withErrorBoundary(handleImportCookies));
}

registerRoutes(legacyApi);
registerRoutes(restApi);

restApi.get('/healthz', withErrorBoundary(handleHealthz));
restApi.get('/healtz', withErrorBoundary(handleHealthz));

if (REST_API_ENABLED) {
  app.use('/rest', restCors, restApiAuth, restApi);
}

// Auth Middleware for legacy UI/basic-auth API surface.
app.use(basicAuth({
  users: { [USERNAME]: PASSWORD },
  challenge: true,
  realm: 'Chrome Fleet Control',
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', legacyApi);

io.on('connection', () => {
  broadcastUpdate();
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  if (REST_API_ENABLED) {
    console.log(`REST API enabled on http://${HOST}:${PORT}/rest`);
  }
});
