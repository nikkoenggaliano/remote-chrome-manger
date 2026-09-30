const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('\x1b[31m%s\x1b[0m', 'ERROR: .env file not found!');
  console.error('Please copy .env.example to .env and configure it before running the server.');
  process.exit(1);
}
require('dotenv').config({ path: envPath });

const { execFile } = require('child_process');
const basicAuth = require('express-basic-auth');
const db = require('./lib/db');
const chromeManager = require('./lib/chrome-manager');
const cdpClient = require('./lib/cdp-client');
const { parseCookieFiles } = require('./lib/cookie-import');
const { runChecks } = require('./lib/dep-check');
const { buildOpenApiSpec, documentedRoutes } = require('./lib/openapi');
const { createCdpHttpProxy, attachCdpWebSocketProxy } = require('./lib/cdp-proxy');

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
if (!USERNAME || !PASSWORD) {
  originalError('\x1b[31m%s\x1b[0m', 'ERROR: Authentication credentials missing!');
  originalError('Please set CHROME_FLEET_USERNAME and CHROME_FLEET_PASSWORD environment variables.');
  process.exit(1);
}

// --- REST API settings ------------------------------------------------------
// These live in the config table, not in process.env, so they can be flipped
// from Configuration -> REST API without editing .env and restarting. REST_API
// / REST_API_KEY still work, but only to *seed* the rows the first time the
// server sees a database that has never been configured — after that the UI is
// the single source of truth, the same way chrome_bin and profiles_dir behave.
const REST_ENABLED_KEY = 'rest_api_enabled';
const REST_KEY_KEY = 'rest_api_key';
// Managed through the dedicated settings endpoint, which validates them; keep
// them out of the generic key/value config surface so there is only one way in.
const RESERVED_CONFIG_KEYS = new Set([REST_ENABLED_KEY, REST_KEY_KEY]);

// Prepared once: getRestApiSettings() runs on every /rest request, and
// better-sqlite3 recompiles the statement on each db.prepare() call.
const selectConfigValue = db.prepare('SELECT value FROM config WHERE key = ?');
const upsertConfigValue = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');

function readConfigValue(key) {
  const row = selectConfigValue.get(key);
  return row ? row.value : null;
}

function writeConfigValue(key, value) {
  upsertConfigValue.run(key, String(value));
}

function seedRestSettingsFromEnv() {
  if (readConfigValue(REST_ENABLED_KEY) === null) {
    writeConfigValue(REST_ENABLED_KEY, isTruthy(process.env.REST_API) ? 'true' : 'false');
  }
  if (readConfigValue(REST_KEY_KEY) === null) {
    writeConfigValue(REST_KEY_KEY, process.env.REST_API_KEY || '');
  }
}
seedRestSettingsFromEnv();

function generateApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

// Read on every request, so a toggle takes effect immediately. An enabled flag
// with no key is treated as disabled rather than as an open door.
function getRestApiSettings() {
  const apiKey = readConfigValue(REST_KEY_KEY) || '';
  const requested = isTruthy(readConfigValue(REST_ENABLED_KEY));
  return { requested, api_key: apiKey, enabled: requested && Boolean(apiKey) };
}

if (isTruthy(process.env.REST_API) && !process.env.REST_API_KEY && !getRestApiSettings().api_key) {
  console.log('[REST] REST_API=true but no key is set. The REST API stays off until you set a key in Configuration -> REST API.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({
  limit: '10mb',
  // The CDP proxy has to replay request bodies verbatim upstream, and the
  // parsed object is not good enough for that.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

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

// The REST surface only exists while it is switched on. Answering 404 rather
// than 403 keeps a disabled deployment from advertising that the API is there
// at all.
function restEnabledGate(req, res, next) {
  if (!getRestApiSettings().enabled) {
    return res.status(404).json({ error: 'REST API is disabled. Enable it in Configuration -> REST API.' });
  }
  next();
}

function secretsMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, and the lengths themselves leak
  // nothing useful here, so compare them up front.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function restApiAuth(req, res, next) {
  // Read the key per request instead of closing over a boot-time constant, so
  // rotating it in the UI takes effect on the very next call.
  const { api_key: apiKey } = getRestApiSettings();
  const bearerMatch = req.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  const providedApiKey = req.get('x-api-key') || (bearerMatch ? bearerMatch[1] : '');
  if (!providedApiKey || !apiKey || !secretsMatch(providedApiKey, apiKey)) {
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

// `df` used to run synchronously inside every /server/stats request, stalling
// the event loop for ~14 ms while the Server page polled it every 3 seconds.
// Disk usage barely moves, so it is refreshed in the background and read from
// a cache: callers stay synchronous, nothing blocks.
const DISK_REFRESH_MS = 15000;
let diskUsage = null;
let diskRefreshing = false;
let diskRefreshedAt = 0;

function parseDiskOutput(output) {
  const lines = String(output).trim().split('\n');
  if (lines.length < 2) return null;
  const parts = lines[1].replace(/\s+/g, ' ').split(' ');
  if (parts.length < 6) return null;
  return {
    total: parseInt(parts[1], 10) * 1024,
    used: parseInt(parts[2], 10) * 1024,
    free: parseInt(parts[3], 10) * 1024,
    percent: parts[4],
  };
}

function refreshDiskUsage() {
  if (diskRefreshing || Date.now() - diskRefreshedAt < DISK_REFRESH_MS) return;
  diskRefreshing = true;
  execFile('df', ['-k', '.'], { cwd: __dirname, timeout: 5000 }, (error, stdout) => {
    diskRefreshing = false;
    diskRefreshedAt = Date.now();
    if (error && !stdout) {
      console.error('Error getting disk usage:', error.message);
      return;
    }
    diskUsage = parseDiskOutput(stdout) || diskUsage;
  });
}

function getDiskUsage() {
  refreshDiskUsage(); // fire-and-forget; this call returns the previous value
  return diskUsage;
}

// os.freemem() on macOS reports only wired-down free pages and reads far lower
// than Activity Monitor, so vm_stat is used to add inactive pages back in. It
// is a shell-out, though, and this runs on every /server/stats call, which the
// dashboard polls every 3 seconds: same treatment as disk usage, refreshed in
// the background so nothing blocks the event loop.
const DARWIN_MEMORY_REFRESH_MS = 3000;
let darwinFreeMemory = null;
let darwinMemoryRefreshing = false;
let darwinMemoryRefreshedAt = 0;

function refreshDarwinMemory() {
  if (os.platform() !== 'darwin') return;
  if (darwinMemoryRefreshing || Date.now() - darwinMemoryRefreshedAt < DARWIN_MEMORY_REFRESH_MS) return;
  darwinMemoryRefreshing = true;
  execFile('vm_stat', [], { timeout: 5000 }, (error, stdout) => {
    darwinMemoryRefreshing = false;
    darwinMemoryRefreshedAt = Date.now();
    if (error && !stdout) return;

    const text = String(stdout);
    const pageSizeMatch = text.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const freePagesMatch = text.match(/Pages free:\s+(\d+)/);
    const inactivePagesMatch = text.match(/Pages inactive:\s+(\d+)/);
    if (freePagesMatch && inactivePagesMatch) {
      darwinFreeMemory = (parseInt(freePagesMatch[1], 10) + parseInt(inactivePagesMatch[1], 10)) * pageSize;
    }
  });
}

function getMemoryStats() {
  refreshDarwinMemory(); // fire-and-forget; uses the previous reading
  const total = os.totalmem();
  const free = darwinFreeMemory !== null ? darwinFreeMemory : os.freemem();
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
    // REST settings have their own validated endpoint and their own UI card;
    // listing them here too would show the API key in plaintext in a table that
    // also offers an unvalidated edit and a delete button.
    if (RESERVED_CONFIG_KEYS.has(row.key)) return acc;
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

  // One async `ps` + `lsof` for the whole fleet. This used to be a synchronous
  // pair of shell-outs per instance, which stalled the event loop on every tab
  // open/close and every sync tick — long enough for the health probe's timer
  // to fire against a live port and get the instance killed.
  const memoryByInstance = await chromeManager.getInstancesMemoryBytes(instances);

  await Promise.all(instances.map(async (instance) => {
    if (instance.status !== 'running') return;
    runningIds.add(instance.id);
    instanceMemoryBytes.set(instance.id, memoryByInstance.get(instance.id) ?? null);
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

// The periodic sync fires every 10 s whether or not anything moved, and each
// broadcast re-serialises every instance and pushes it to every connected
// client. Skip the emit when the payload is byte-identical to the last one;
// `force` is for a client that has just connected and has nothing yet.
let lastBroadcastPayload = null;

function broadcastUpdate(options = {}) {
  const instances = getSerializedInstances();
  const serialized = JSON.stringify(instances);
  if (!options.force && serialized === lastBroadcastPayload) return;
  lastBroadcastPayload = serialized;
  io.emit('instances_updated', instances);
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

refreshDiskUsage();
refreshDarwinMemory();

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

  if (RESERVED_CONFIG_KEYS.has(key)) {
    throw createHttpError(400, `"${key}" is managed under Configuration -> REST API. Use that panel (or POST /api/settings/rest) so the key and the toggle stay consistent.`);
  }

  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
  res.json({ success: true, key, value: String(value) });
}

async function handleDeleteConfig(req, res) {
  if (RESERVED_CONFIG_KEYS.has(req.params.key)) {
    throw createHttpError(400, `"${req.params.key}" is managed under Configuration -> REST API.`);
  }
  db.prepare('DELETE FROM config WHERE key = ?').run(req.params.key);
  res.json({ success: true, key: req.params.key });
}

// A CDP proxy target has to exist, be a browser we can actually reach, and be
// running: forwarding to a dead port would surface as a confusing 502.
function getRunningInstanceForProxy(idOrName) {
  const instance = getInstanceByIdOrThrow(idOrName);
  if (instance.status !== 'running') {
    throw createHttpError(409, `Instance "${instance.name}" is ${instance.status}. Start it before using its CDP endpoint.`);
  }
  return instance;
}

function serializeRestSettings() {
  const { requested, enabled, api_key: apiKey } = getRestApiSettings();
  return {
    enabled,
    // What the toggle is set to, which differs from `enabled` when the switch
    // is on but no key exists — the UI needs to be able to say why it's off.
    requested,
    api_key: apiKey,
    has_key: Boolean(apiKey),
    base_path: '/rest',
    env_seeded: isTruthy(process.env.REST_API),
  };
}

async function handleGetRestSettings(req, res) {
  res.json(serializeRestSettings());
}

async function handleSetRestSettings(req, res) {
  const body = req.body || {};
  let apiKey = readConfigValue(REST_KEY_KEY) || '';

  if (body.generate_key) {
    apiKey = generateApiKey();
  } else if (body.api_key !== undefined && body.api_key !== null) {
    const provided = normalizeString(body.api_key);
    // A short key is worse than no key: it looks configured while being
    // guessable, and this endpoint is the only thing standing in front of the
    // whole instance-control API.
    if (provided && provided.length < 16) {
      throw createHttpError(400, 'API key must be at least 16 characters. Use Generate for a random one.');
    }
    apiKey = provided;
  }

  const enabled = body.enabled === undefined ? isTruthy(readConfigValue(REST_ENABLED_KEY)) : Boolean(body.enabled);
  if (enabled && !apiKey) {
    throw createHttpError(400, 'The REST API cannot be enabled without an API key. Generate one first.');
  }

  writeConfigValue(REST_KEY_KEY, apiKey);
  writeConfigValue(REST_ENABLED_KEY, enabled ? 'true' : 'false');

  const settings = serializeRestSettings();
  console.log(`[REST] ${settings.enabled ? 'Enabled' : 'Disabled'} via dashboard${body.generate_key ? ' (new key generated)' : ''}.`);
  res.json({ success: true, ...settings });
}

// The contract, served from the same spec the /docs page renders, so the two
// can never disagree.
function handleOpenApiSpec(surface) {
  return async (req, res) => {
    res.json(buildOpenApiSpec({ surface, serverUrl: surface === 'rest' ? '/rest' : '/api' }));
  };
}

async function handleApiDocsPage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
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

// Tail of a file, or a short note when there is nothing to read.
function tailFile(filePath, bytes) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const size = fs.statSync(filePath).size;
    if (!size) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const length = Math.min(size, bytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return `Could not read ${filePath}: ${error.message}`;
  }
}

async function handleGetInstanceLogs(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const managerPath = chromeManager.getLogPath(instance.id);
  const chromePath = chromeManager.getChromeLogPath(instance.id);

  // The manager's log is what actually explains a misbehaving instance, and it
  // used to be destroyed by Chrome truncating the shared file. It now leads,
  // with Chrome's own output kept underneath it.
  const managerLog = tailFile(managerPath, 20000);
  const chromeLog = tailFile(chromePath, 20000);

  const sections = [];
  sections.push(`===== manager (${managerPath || 'n/a'}) =====`);
  sections.push(managerLog === null ? 'No manager log yet.' : (managerLog || '(empty)'));
  sections.push('');
  sections.push(`===== chrome (${chromePath || 'n/a'}) =====`);
  sections.push(chromeLog === null ? 'No chrome log yet.' : (chromeLog || '(empty)'));

  res.json({
    id: instance.id,
    // Kept for callers that already read `log_path`; it now points at the
    // manager log, which is the one worth looking at.
    log_path: managerPath,
    manager_log_path: managerPath,
    chrome_log_path: chromePath,
    manager_logs: managerLog,
    chrome_logs: chromeLog,
    logs: sections.join('\n'),
  });
}

async function handleClearInstanceLogs(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const targets = [
    ['manager', chromeManager.getLogPath(instance.id)],
    ['chrome', chromeManager.getChromeLogPath(instance.id)],
  ];

  const cleared = [];
  for (const [label, filePath] of targets) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      // Truncated, not deleted: Chrome and the spawned process both hold this
      // file open, and unlinking it would leave them writing into an inode
      // nobody can read any more, silently losing every later line.
      const before = fs.statSync(filePath).size;
      fs.truncateSync(filePath, 0);
      cleared.push({ log: label, path: filePath, freed_bytes: before });
    } catch (error) {
      throw createHttpError(500, `Could not clear ${label} log: ${error.message}`);
    }
  }

  res.json({ success: true, instance_id: instance.id, cleared });
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
  // closeTab keeps the browser alive when this is the last page target by
  // opening a replacement first; hand that tab back so the caller can focus it.
  const { replacement } = await cdpClient.closeTab(instance.host, instance.port, req.params.tabId);
  await refreshTabCounts([instance]);
  broadcastUpdate();
  res.json({ success: true, replacement: replacement || null });
}

// Dump the DOM as the browser currently holds it. format=html returns the
// document itself (handy for `curl -o page.html`), format=text the rendered
// text, and the default JSON wraps it with the metadata a caller needs to know
// what it got — which URL answered, and whether the page had finished loading.
async function handleTabHtml(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const format = normalizeString(req.query?.format) || 'json';
  if (!['json', 'html', 'text'].includes(format)) {
    throw createHttpError(400, 'format must be "json", "html", or "text"');
  }

  const dump = await cdpClient.getPageDump(instance.host, instance.port, req.params.tabId);

  if (format === 'html') {
    res.type('text/html; charset=utf-8').send(dump.html);
    return;
  }
  if (format === 'text') {
    res.type('text/plain; charset=utf-8').send(dump.text || '');
    return;
  }
  res.json({
    instance_id: instance.id,
    tab_id: req.params.tabId,
    url: dump.url,
    title: dump.title,
    ready_state: dump.ready_state,
    html_bytes: dump.html_bytes,
    captured_at: dump.captured_at,
    html: dump.html,
    text: dump.text,
  });
}

// Collection versions of the per-tab endpoints: one round trip instead of
// listing tabs and then fanning out by hand. A tab that fails carries an
// `error` field rather than failing the batch.
async function handleAllTabsHtml(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const metadataOnly = isTruthy(req.query?.metadata_only);
  const tabs = await cdpClient.dumpAllPages(instance.host, instance.port, { metadataOnly });

  res.json({
    instance_id: instance.id,
    count: tabs.length,
    failed: tabs.filter((t) => t.error).length,
    metadata_only: metadataOnly,
    captured_at: new Date().toISOString(),
    tabs,
  });
}

async function handleAllTabsScreenshot(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const tabs = await cdpClient.captureAllPages(instance.host, instance.port, { scale: req.query?.scale });

  res.json({
    instance_id: instance.id,
    count: tabs.length,
    failed: tabs.filter((t) => t.error).length,
    captured_at: new Date().toISOString(),
    tabs,
  });
}

async function handleTabInspect(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw createHttpError(400, 'x and y are required and must be numbers (viewport CSS pixels)');
  }

  try {
    const node = await cdpClient.inspectAt(instance.host, instance.port, req.params.tabId, Math.round(x), Math.round(y), {
      highlight: req.body?.highlight !== false,
    });
    res.json({ success: true, node });
  } catch (error) {
    if (error.code === 'NO_NODE_AT_POINT') {
      throw createHttpError(404, error.message);
    }
    throw error;
  }
}

async function handleTabHighlightClear(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  await cdpClient.hideHighlight(instance.host, instance.port, req.params.tabId);
  res.json({ success: true });
}

async function handleTabEvaluate(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const expression = typeof req.body?.expression === 'string' ? req.body.expression : '';
  if (!expression.trim()) {
    throw createHttpError(400, 'Missing expression');
  }

  try {
    const value = await cdpClient.evaluateInTab(instance.host, instance.port, req.params.tabId, expression, {
      awaitPromise: req.body?.await_promise !== false,
    });
    res.json({ success: true, value: value === undefined ? null : value });
  } catch (error) {
    // A throw inside the page is the caller's bug, not a server fault — report
    // it as a 400 with the page's own message rather than a 500.
    if (error.code === 'EVALUATION_FAILED') {
      throw createHttpError(400, error.message);
    }
    throw error;
  }
}

async function handleTabReload(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  await cdpClient.reloadTab(instance.host, instance.port, req.params.tabId, {
    ignoreCache: Boolean(req.body?.ignore_cache),
  });
  res.json({ success: true });
}

async function handleTabHistory(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const direction = req.params.direction;
  if (!['back', 'forward'].includes(direction)) {
    throw createHttpError(400, 'direction must be "back" or "forward"');
  }
  const delta = direction === 'back' ? -1 : 1;
  const moved = await cdpClient.historyGo(instance.host, instance.port, req.params.tabId, delta);
  if (!moved) {
    throw createHttpError(409, `No ${direction} entry in this tab's history`);
  }
  res.json({ success: true, ...moved });
}

async function handleTabPdf(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const data = await cdpClient.printToPdf(instance.host, instance.port, req.params.tabId, {
    landscape: req.query?.landscape === '1' || req.query?.landscape === 'true',
    printBackground: req.query?.background !== '0',
  });
  res.type('application/pdf').send(Buffer.from(data, 'base64'));
}

// The mirror of the existing cookie import: dumps every cookie in the browser
// profile, in the same shape the import endpoint accepts, so a profile's
// session can be moved between instances.
async function handleExportCookies(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  const tabs = cdpClient.listPageTargets(await cdpClient.getTabs(instance.host, instance.port));
  if (!tabs.length) {
    throw createHttpError(409, `Instance "${instance.name}" has no open page to read cookies through`);
  }

  const cookies = await cdpClient.exportCookies(instance.host, instance.port, tabs[0].id);
  const domain = normalizeString(req.query?.domain);
  const filtered = domain
    ? cookies.filter((c) => String(c.domain || '').replace(/^\./, '').endsWith(domain.replace(/^\./, '')))
    : cookies;

  res.json({ instance_id: instance.id, count: filtered.length, cookies: filtered });
}

async function handleScreenshot(req, res) {
  const instance = getInstanceByIdOrThrow(req.params.id);
  // The live view renders the frame scaled to fit its panel anyway, so asking
  // Chrome for exactly the resolution that will be shown costs it far less work
  // than capturing full size and throwing pixels away in the browser.
  const scale = cdpClient.clampScale(req.query?.scale ?? 1);
  const data = await cdpClient.captureScreenshot(instance.host, instance.port, req.params.tabId, { scale });
  if (!data) {
    throw createHttpError(500, 'Failed to capture screenshot');
  }

  // A scaled frame is no longer 1:1 with the page, so a viewer that maps a
  // click through the image would land somewhere else entirely. Report the
  // scale that was actually applied so the caller can convert image pixels back
  // to viewport pixels exactly.
  res.set('X-Capture-Scale', String(scale));
  res.set('Access-Control-Expose-Headers', 'X-Capture-Scale');
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

  // Three shapes, because the dashboard and an API client want different ones.
  // The browser picks files and sends `files`; a script usually already holds
  // the cookies, and making it stringify them into a fake file was needless
  // ceremony. `content` covers pasting one export straight in.
  const body = req.body || {};
  let files = Array.isArray(body.files) ? body.files : null;

  if (!files && Array.isArray(body.cookies)) {
    if (!body.cookies.length) throw createHttpError(400, 'cookies is empty');
    files = [{ name: 'cookies.json', content: JSON.stringify(body.cookies) }];
  }
  if (!files && typeof body.content === 'string' && body.content.trim()) {
    files = [{ name: normalizeString(body.name) || 'cookies.txt', content: body.content }];
  }

  if (!files || files.length === 0) {
    throw createHttpError(400, 'Send cookies as "cookies" (an array), "content" (a Netscape or JSON export), or "files" (a list of {name, content})');
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
  router.delete('/instances/:id/logs', withErrorBoundary(handleClearInstanceLogs));

  router.get('/instances/:id/tabs', withErrorBoundary(handleGetTabs));
  // Registered before the /:tabId routes so the literal paths win.
  router.get('/instances/:id/tabs/html', withErrorBoundary(handleAllTabsHtml));
  router.get('/instances/:id/tabs/screenshot', withErrorBoundary(handleAllTabsScreenshot));
  router.post('/instances/:id/tabs/new', withErrorBoundary(handleNewTab));
  router.post('/instances/:id/tabs/:tabId/activate', withErrorBoundary(handleActivateTab));
  router.post('/instances/:id/tabs/:tabId/navigate', withErrorBoundary(handleNavigateTab));
  router.delete('/instances/:id/tabs/:tabId', withErrorBoundary(handleDeleteTab));
  router.get('/instances/:id/tabs/:tabId/screenshot', withErrorBoundary(handleScreenshot));
  router.post('/instances/:id/tabs/:tabId/input', withErrorBoundary(handleInput));
  router.get('/instances/:id/tabs/:tabId/html', withErrorBoundary(handleTabHtml));
  router.post('/instances/:id/tabs/:tabId/evaluate', withErrorBoundary(handleTabEvaluate));
  router.post('/instances/:id/tabs/:tabId/inspect', withErrorBoundary(handleTabInspect));
  router.delete('/instances/:id/tabs/:tabId/highlight', withErrorBoundary(handleTabHighlightClear));
  router.post('/instances/:id/tabs/:tabId/reload', withErrorBoundary(handleTabReload));
  // Plain param + handler validation: Express 5's path-to-regexp dropped the
  // inline `:param(a|b)` form.
  router.post('/instances/:id/tabs/:tabId/history/:direction', withErrorBoundary(handleTabHistory));
  router.get('/instances/:id/tabs/:tabId/pdf', withErrorBoundary(handleTabPdf));
  router.post('/instances/:id/cookies/import', withErrorBoundary(handleImportCookies));
  router.get('/instances/:id/cookies', withErrorBoundary(handleExportCookies));
}

registerRoutes(legacyApi);
registerRoutes(restApi);

// Dashboard-only: an API client should not be able to rotate the key it is
// authenticating with, or switch the surface off from under other clients.
legacyApi.get('/settings/rest', withErrorBoundary(handleGetRestSettings));
legacyApi.post('/settings/rest', withErrorBoundary(handleSetRestSettings));

legacyApi.get('/openapi.json', withErrorBoundary(handleOpenApiSpec('dashboard')));
legacyApi.get('/docs', withErrorBoundary(handleApiDocsPage));

// Guard against the spec drifting behind the code: every route the API
// actually serves must appear in lib/openapi.js. This compares what Express
// registered with what the spec documents and says so at boot rather than
// letting the published contract quietly go stale.
function auditApiDocumentation() {
  const documented = documentedRoutes();
  const registered = new Set();
  for (const layer of restApi.stack) {
    if (!layer.route) continue;
    // Express path params are :name; the spec uses OpenAPI's {name}.
    const specPath = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const method of Object.keys(layer.route.methods)) {
      registered.add(`${method.toUpperCase()} ${specPath}`);
    }
  }

  // The CDP proxy is deliberately a catch-all (`/cdp/*splat`): it forwards
  // whatever DevTools path it is given, so it is documented as one operation
  // rather than enumerated route by route.
  const isProxyRoute = (route) => route.includes('/cdp');
  const undocumented = [...registered].filter((r) => !documented.has(r) && !isProxyRoute(r));
  const stale = [...documented].filter((r) => !registered.has(r)
    && !r.endsWith('/docs') && !r.endsWith('/openapi.json') && !isProxyRoute(r));
  if (undocumented.length) {
    console.log(`[API docs] Not in the OpenAPI spec: ${undocumented.join(', ')}`);
  }
  if (stale.length) {
    console.log(`[API docs] Documented but not served: ${stale.join(', ')}`);
  }
  if (!undocumented.length && !stale.length) {
    console.log(`[API docs] Contract covers all ${registered.size} REST routes.`);
  }
}

restApi.get('/healthz', withErrorBoundary(handleHealthz));
restApi.get('/healtz', withErrorBoundary(handleHealthz));

// Runs once every REST route is on the router.
auditApiDocumentation();

// Everything under /cdp is a transparent pass-through to the instance's own
// DevTools endpoint, so it is mounted as a catch-all rather than enumerated.
const cdpHttpProxy = createCdpHttpProxy({ resolveInstance: getRunningInstanceForProxy });
restApi.all('/instances/:id/cdp/*splat', withErrorBoundary(cdpHttpProxy));
restApi.all('/instances/:id/cdp', withErrorBoundary(cdpHttpProxy));

// Always mounted; restEnabledGate decides per request whether it answers.
// Mounting conditionally at boot is what made this an .env-and-restart setting.
// The trailing handler stops unmatched /rest paths from falling through to the
// dashboard's basic-auth middleware, which answered them with a 401 challenge
// (and a browser login prompt) instead of an honest 404.
// Docs sit in front of restApiAuth on purpose: a browser cannot set an
// X-API-Key header, so requiring the key would make the page unopenable — and
// the contract carries no data and no secrets, only the shape of endpoints that
// are themselves key-protected. It still hides behind restEnabledGate, so a
// disabled deployment advertises nothing.
const restDocs = express.Router();
restDocs.get('/openapi.json', withErrorBoundary(handleOpenApiSpec('rest')));
restDocs.get('/docs', withErrorBoundary(handleApiDocsPage));

app.use('/rest', restEnabledGate, restCors, restDocs, restApiAuth, restApi, (req, res) => {
  res.status(404).json({ error: `No REST endpoint for ${req.method} ${req.originalUrl}` });
});

// Auth Middleware for legacy UI/basic-auth API surface.
app.use(basicAuth({
  users: { [USERNAME]: PASSWORD },
  challenge: true,
  realm: 'Chrome Fleet Control',
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', legacyApi);

io.on('connection', (socket) => {
  // A fresh client needs the current state even though nothing changed.
  socket.emit('instances_updated', getSerializedInstances());
});

// A browser cannot attach headers to a WebSocket handshake, and neither can
// some CDP clients, so the key is accepted from the query string as well. The
// header is preferable: query strings end up in access logs and shell history.
attachCdpWebSocketProxy(server, {
  resolveInstance: getRunningInstanceForProxy,
  onLog: (level, message) => console.log(`[CDP proxy:${level}] ${message}`),
  authorize: (req, url) => {
    if (!getRestApiSettings().enabled) {
      return { ok: false, status: 404, error: 'REST API is disabled. Enable it in Configuration -> REST API.' };
    }
    const { api_key: apiKey } = getRestApiSettings();
    const bearerMatch = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    const provided = req.headers['x-api-key']
      || (bearerMatch ? bearerMatch[1] : '')
      || url.searchParams.get('key')
      || '';
    if (!provided || !apiKey || !secretsMatch(provided, apiKey)) {
      return { ok: false, status: 401, error: 'Invalid or missing REST API key' };
    }
    return { ok: true };
  },
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  const rest = getRestApiSettings();
  console.log(rest.enabled
    ? `REST API enabled on http://${HOST}:${PORT}/rest (docs at http://${HOST}:${PORT}/rest/docs)`
    : 'REST API disabled (toggle it in Configuration -> REST API)');
  console.log(`API contract browsable at http://${HOST}:${PORT}/api/docs`);
  if (rest.enabled) {
    // proxyBase() percent-encodes the id, which is right for a real id and
    // wrong for a placeholder in a log line.
    console.log(`CDP proxy at http://${HOST}:${PORT}/rest/instances/<id>/cdp (Puppeteer/Playwright entry point)`);
  }
});
