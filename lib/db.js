const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL, -- 'local' or 'external'
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    forward_port INTEGER,
    launch_mode TEXT DEFAULT 'chrome_headless',
    use_xvfb INTEGER DEFAULT 0,
    use_socat INTEGER DEFAULT 0,
    profile_dir TEXT,
    display TEXT,
    status TEXT DEFAULT 'stopped',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add notes column if it doesn't exist (handle migration)
try {
  db.exec("ALTER TABLE instances ADD COLUMN notes TEXT");
} catch (e) {
  // Column already exists, ignore
}

try {
  db.exec("ALTER TABLE instances ADD COLUMN launch_mode TEXT DEFAULT 'chrome_headless'");
} catch (e) {
  // Column already exists, ignore
}

// Track when an instance last entered the 'running' state so the UI can show uptime.
try {
  db.exec("ALTER TABLE instances ADD COLUMN started_at DATETIME");
} catch (e) {
  // Column already exists, ignore
}

db.exec(`
  UPDATE instances
  SET launch_mode = CASE
    WHEN type = 'external' THEN 'external'
    WHEN launch_mode IN ('gui', 'xvfb', 'chrome_headless', 'external') THEN launch_mode
    WHEN COALESCE(use_xvfb, 0) = 1 THEN 'xvfb'
    ELSE 'chrome_headless'
  END
  WHERE launch_mode IS NULL
     OR launch_mode NOT IN ('gui', 'xvfb', 'chrome_headless', 'external')
`);

db.exec(`
  UPDATE instances
  SET use_xvfb = CASE
    WHEN launch_mode = 'xvfb' THEN 1
    ELSE 0
  END
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Insert default config if not exists
const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
const isMac = process.platform === 'darwin';
const defaultChrome = isMac 
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' 
  : 'google-chrome-stable';

insertConfig.run('chrome_bin', process.env.CHROME_BIN || defaultChrome);
insertConfig.run('profiles_dir', path.join(__dirname, '..', 'profiles'));
insertConfig.run('xvfb_bin', 'Xvfb');

module.exports = db;
