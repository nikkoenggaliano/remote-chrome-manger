# Chrome Fleet Control

Chrome Fleet Control is a dashboard for managing multiple Chrome or Chromium instances through the Chrome DevTools Protocol (CDP). It supports isolated profiles, optional port forwarding, per-instance logs, tab control, and an optional REST API.

## Features

- Create, edit, and delete local or external browser instances
- Start, stop, and inspect instances from the web UI
- Keep separate browser profiles per instance
- Port forwarding through `socat`
- `Xvfb` support for headless Linux display sessions
- Import cookies into a running browser instance through CDP from Netscape or JSON exports
- Server dashboard for CPU, memory, disk, uptime, and network interfaces
- Basic Auth for the UI and legacy `/api/*` endpoints
- Optional API key protected REST API under `/rest/*`
- `run.sh` enables headless and WebGL-friendly Chrome flags by default

## Requirements

- Node.js and npm
- Google Chrome, Chromium, or Chrome for Testing
- `socat`
- `lsof`
- `wget` and `unzip` if you want to download a portable browser binary
- `screen` if you want `RUN_IN_SCREEN=true`
- `Xvfb` if you run Linux in a headless display setup

## Browser Installation

### Recommended: auto-detect OS and architecture, then download official Chrome for Testing with `wget`

This example detects the current OS and CPU architecture, resolves the matching official Chrome for Testing download, and extracts it into the project directory.

If the extracted folder matches one of the app's built-in browser search paths, the app can auto-detect it without additional config.

```bash
PROJECT_DIR="$(pwd)"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64)
    CFT_PLATFORM="linux64"
    CFT_DIR="chrome-linux64"
    CHROME_BIN_PATH="$PROJECT_DIR/chrome-linux64/chrome"
    ;;
  Darwin:arm64|Darwin:aarch64)
    CFT_PLATFORM="mac-arm64"
    CFT_DIR="chrome-mac-arm64"
    CHROME_BIN_PATH="$PROJECT_DIR/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    ;;
  Darwin:x86_64)
    CFT_PLATFORM="mac-x64"
    CFT_DIR="chrome-mac-x64"
    CHROME_BIN_PATH="$PROJECT_DIR/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    ;;
  MINGW*:x86_64|MSYS_NT*:x86_64|CYGWIN*:x86_64)
    CFT_PLATFORM="win64"
    CFT_DIR="chrome-win64"
    CHROME_BIN_PATH="$PROJECT_DIR/chrome-win64/chrome.exe"
    ;;
  MINGW*:i686|MSYS_NT*:i686|CYGWIN*:i686)
    CFT_PLATFORM="win32"
    CFT_DIR="chrome-win32"
    CHROME_BIN_PATH="$PROJECT_DIR/chrome-win32/chrome.exe"
    ;;
  *)
    echo "Unsupported OS/arch: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

CFT_JSON="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
CFT_URL="$(wget -qO- "$CFT_JSON" | node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); const platform = process.argv[1]; const item = data.channels.Stable.downloads.chrome.find((entry) => entry.platform === platform); if (!item) { console.error(`No Chrome for Testing download found for ${platform}`); process.exit(1); } process.stdout.write(item.url);' "$CFT_PLATFORM")"
ARCHIVE_PATH="/tmp/$(basename "$CFT_URL")"

wget -O "$ARCHIVE_PATH" "$CFT_URL"
rm -rf "$PROJECT_DIR/$CFT_DIR"
unzip -q "$ARCHIVE_PATH" -d "$PROJECT_DIR"

echo "Downloaded platform: $CFT_PLATFORM"
echo "Chrome binary: $CHROME_BIN_PATH"
export CHROME_BIN="$CHROME_BIN_PATH"
```

Notes:

- At the time of writing, the official stable Chrome for Testing JSON publishes `linux64`, `mac-arm64`, `mac-x64`, `win32`, and `win64`.
- If your platform is not published in that list, use your own Chrome or Chromium binary and point `CHROME_BIN` to it.
- On Linux and macOS, extracting into the project root matches the app's built-in browser auto-detection paths.

### Alternative: Debian or Ubuntu x86_64 system package

If you specifically want the system-wide Google Chrome `.deb` package:

```bash
wget -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
```

### Using your own Chromium or custom Chrome binary

If you already have a browser binary, just point `CHROME_BIN` to it:

```bash
export CHROME_BIN="/absolute/path/to/chrome"
```

## Environment Preparation

Run the preflight checker before starting the server:

```bash
./prep.sh
```

If you want the script to try installing dependencies that can be installed automatically:

```bash
./prep.sh AUTO_INSTALL=true
```

`prep.sh` will:

- detect OS family and available package manager
- check `node`, `npm`, browser availability, `socat`, `Xvfb`, `screen`, and `lsof`
- run `npm install` when `node_modules` is missing

## Running the Application

Standard foreground mode:

```bash
./run.sh USERNAME=admin PASSWORD=admin PORT=3000
```

Background mode through `screen`:

```bash
./run.sh USERNAME=admin PASSWORD=admin PORT=3000 RUN_IN_SCREEN=true
```

REST API enabled:

```bash
./run.sh USERNAME=admin PASSWORD=admin PORT=3000 REST_API=true REST_API_KEY=super-secret-key
```

Notes:

- `run.sh` enables `CHROME_MANAGER_FORCE_HEADLESS=1` and `CHROME_MANAGER_ENABLE_WEBGL=1` by default.
- If `REST_API=true` and `REST_API_KEY` is empty, the launcher aborts.

## Authentication

- The UI and legacy `/api/*` endpoints use Basic Auth with `USERNAME` and `PASSWORD`.
- The REST API under `/rest/*` is only enabled when `REST_API=true`.
- The REST API accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`.

## Main REST Endpoints

All endpoints below are mounted under `/rest` when the REST API is enabled.

### Instances

- `GET /instances`
- `GET /instances/:id`
- `POST /instances`
- `PUT /instances/:id`
- `PATCH /instances/:id`
- `DELETE /instances/:id`
- `POST /instances/:id/start`
- `POST /instances/:id/spawn`
- `POST /instances/:id/stop`
- `GET /instances/:id/logs`

`GET /instances/:id` includes:

- `host` and `port`
- `debug_endpoints`
- `forward_targets`
- `forward_to`

### Health and Server

- `GET /healthz`
- `GET /healtz`
- `GET /server/stats`
- `GET /server/logs`
- `GET /server/healthz`
- `GET /server/healtz`

`/healthz` returns CPU usage, memory usage, disk usage, uptime, network interfaces, and an instance status summary.

### Config and Tab Control

The REST API also exposes the same operational features that exist in the legacy `/api` surface:

- `GET /config`
- `POST /config`
- `DELETE /config/:key`
- `GET /instances/:id/tabs`
- `POST /instances/:id/tabs/new`
- `POST /instances/:id/tabs/:tabId/navigate`
- `DELETE /instances/:id/tabs/:tabId`
- `GET /instances/:id/tabs/:tabId/screenshot`
- `POST /instances/:id/tabs/:tabId/input`
- `POST /instances/:id/cookies/import`

`POST /instances/:id/cookies/import` expects JSON like:

```json
{
  "files": [
    {
      "name": "x.com_cookies.txt",
      "content": "# Netscape HTTP Cookie File\n..."
    }
  ]
}
```

Supported import formats:

- Netscape cookie files such as browser-exported `.txt`
- JSON arrays of cookies
- JSON objects containing a `cookies` array

## `curl` Examples

List instances:

```bash
curl -H "X-API-Key: super-secret-key" http://localhost:3000/rest/instances
```

Get instance details:

```bash
curl -H "X-API-Key: super-secret-key" http://localhost:3000/rest/instances/1
```

Spawn an instance:

```bash
curl -X POST -H "X-API-Key: super-secret-key" http://localhost:3000/rest/instances/1/spawn
```

Update an instance:

```bash
curl -X PATCH \
  -H "X-API-Key: super-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome-1001","notes":"updated from REST"}' \
  http://localhost:3000/rest/instances/1
```

Delete an instance:

```bash
curl -X DELETE -H "X-API-Key: super-secret-key" http://localhost:3000/rest/instances/1
```

Health check:

```bash
curl -H "X-API-Key: super-secret-key" http://localhost:3000/rest/healthz
```

Import cookies:

```bash
curl -X POST \
  -H "X-API-Key: super-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"name":"x.com_cookies.txt","content":"# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t1808403617\tauth_token\tvalue"}]}' \
  http://localhost:3000/rest/instances/1/cookies/import
```
