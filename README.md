# Chrome Fleet Control

Chrome Fleet Control is a dashboard for managing multiple Chrome or Chromium instances through the Chrome DevTools Protocol (CDP). It supports isolated profiles, optional port forwarding, per-instance logs, tab control, and an optional REST API.

## Features

- Create, edit, and delete local or external browser instances
- Start, stop, and inspect instances from the web UI
- Per-instance cards show live **uptime** (how long it has been running) and **open tab count**
- Bulk **Start All / Stop All** and instant instance **search/filter**
- Keep separate browser profiles per instance
- Port forwarding through `socat`
- Per-instance launch mode selector with `GUI`, `Headless via Xvfb`, and `Native Chrome Headless`
- Smooth, low-latency **live tab control**: continuous flicker-free streaming from 10 fps
  up to Max, full mouse (click, drag, scroll, right-click) and **keyboard** input (typing,
  special keys, and Ctrl/Cmd shortcuts)
- Tab toolbar with **back / forward / reload**, and an address bar that follows the page
  wherever it navigates itself
- **Inspect loaded HTML** per tab: view, copy, or download the DOM *after* JavaScript has
  run — not the raw server response
- Run JavaScript in any tab and get the result back as JSON
- Export a page to **PDF**, or the viewport to JPEG
- Persistent CDP connections per tab keep interactive control fast
- Import cookies into a running browser instance through CDP from Netscape or JSON exports,
  and export the profile's cookies back out
- Closing the last tab never stops an instance — a replacement blank tab is opened first
- Server dashboard for CPU, memory, disk, uptime, and network interfaces
- Basic Auth for the UI and legacy `/api/*` endpoints
- **CDP reverse proxy**: attach Puppeteer or Playwright to any instance through the
  API key instead of exposing its unauthenticated DevTools port
- Optional API key protected REST API under `/rest/*`, toggled from the dashboard at runtime
  (no restart) — see [docs/REST-API.md](docs/REST-API.md)
- `run.sh` auto-creates `.env` from `.env.example` on first launch and enables WebGL-friendly Chrome flags by default

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

Configuration is managed via a `.env` file. To get started, copy the example configuration:

```bash
cp .env.example .env
```

Edit the `.env` file to set your credentials (`CHROME_FLEET_USERNAME`, `CHROME_FLEET_PASSWORD`), `PORT`, the initial `REST_API` seed values, and background daemon settings (`RUN_IN_SCREEN`). You can also configure `POP_UP_REAL_BROWSER=true` to force a GUI launch instead of headless mode, point `CHROME_BIN` at a specific browser binary, and tune `SCREENSHOT_QUALITY` (10–100) for the live control stream. See `.env.example` for the full, documented list.

If you run `./run.sh` without a `.env`, it copies `.env.example` to `.env` automatically and continues with the defaults (review the credentials before exposing the server).

Once configured, simply run the launcher:

```bash
./run.sh
```

Notes:

- Local instances now use `launch_mode`:
  - `gui`
  - `xvfb`
  - `chrome_headless`
- `GUI` mode needs a real desktop display on Linux.
- `Headless via Xvfb` requires `Xvfb` and does not silently fall back to another mode.
- Each instance keeps two logs in its profile directory: `manager.log` (why it
  launched, why it stopped, what the health checks saw) and `chrome.log` (the
  browser's own output). They used to share one file, and Chrome truncated the
  manager's lines away on every start.
- Chrome's verbose logging (`--v=1`) is off by default; it wrote roughly 1.5 GB
  per hour per instance. Set `CHROME_MANAGER_VERBOSE_CHROME_LOG=1` to get it back.
- Graphics flags are left to Chrome by default. It picks a real GPU where one exists
  and SwiftShader where it does not, so WebGL works either way; measured at roughly
  twice the capture rate of the SwiftShader stack that used to be forced.
  `CHROME_MANAGER_ENABLE_WEBGL=1` restores that forced stack, `=0` passes `--disable-gpu`.
- `REST_API` / `REST_API_KEY` only seed the REST settings on first run; afterwards the API is toggled from Configuration -> REST API. A toggle that is on with no key is treated as off.

## Docker Deployment

Run everything — the Node dashboard **and** a real browser — in one container.
The image bundles Google's official **headless-shell Chromium** (multi-arch
amd64 + arm64) plus every helper the app shells out to (`socat`, `Xvfb`,
`lsof`), so the only host requirement is Docker.

```bash
./docker.sh          # build the image and start the dashboard (default action)
./docker.sh logs     # follow logs
./docker.sh down     # stop and remove
./docker.sh help     # all commands
```

`docker.sh` auto-detects your Docker flavour and works with the `docker compose`
plugin, the legacy `docker-compose` binary, **or** plain `docker` (no Compose
needed). It bootstraps `.env` from `.env.example`, creates `./data` for
persistent profiles + database, and exposes the dashboard on `PORT` (default
3000). Configuration is the same `.env` used by `run.sh`.

### Offline / air-gapped install

To run on a machine with no internet (or no build toolchain), export the image
to the `deploy/` folder and copy that folder to the target host:

```bash
./docker.sh export           # -> deploy/chrome-fleet-control-<arch>.tar.gz
# copy the whole deploy/ folder to the offline machine, then there:
cd deploy && ./load.sh       # imports the image and starts the dashboard
```

`deploy/` is a self-contained bundle (image tarball + `load.sh` +
`docker-compose.yml` + `.env.example`); see `deploy/README.md`. The tarball is
architecture-specific — build it on the same CPU architecture as the target
(`arm64` vs `amd64`).

Full functionality — instance spawning, tab navigation, CDP, cookie import, and
**live screenshots / live-control** — is verified working in the container on
both `amd64` (native Linux) and `arm64` (Apple Silicon via colima).

> The CDP client used for live control was switched from `chrome-remote-interface`
> to a small raw-WebSocket client (`lib/cdp-raw.js`): the former crashes modern
> Chromium (150+) the moment a screenshot/input session is opened, while a raw
> WebSocket carrying the identical CDP commands works reliably.

## Authentication

- The UI and legacy `/api/*` endpoints use Basic Auth with `USERNAME` and `PASSWORD`.
- The REST API under `/rest/*` is enabled from the dashboard (Configuration -> REST API) and takes effect immediately, with no restart. While it is off, every `/rest/*` path answers 404.
- The REST API accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`.

## REST API

**Browsable contract, served by the app itself: `http://HOST:PORT/rest/docs`**
(or `/api/docs` with your dashboard login). It renders from
`GET /rest/openapi.json` — an OpenAPI 3.1 document you can import into Postman,
Insomnia, or a client generator — and every operation has a **Try** button.

**Prose guide with worked examples: [docs/REST-API.md](docs/REST-API.md).**

Enable it in the dashboard under **Configuration -> REST API**, generate a key,
and call it with `X-API-Key: <key>` (or `Authorization: Bearer <key>`) against
`http://HOST:PORT/rest`.

```bash
BASE=http://127.0.0.1:3000/rest
AUTH="X-API-Key: your-key-here"

curl -H "$AUTH" $BASE/instances                      # list instances
curl -X POST -H "$AUTH" $BASE/instances/1/start      # launch the browser
curl -H "$AUTH" "$BASE/instances/1/tabs/$TAB/html?format=html" -o page.html
```

What it covers:

| Area | Endpoints |
|---|---|
| Instances | list / read / create / update / delete, `start`, `stop`, `logs` |
| Tabs | list, open, close, `navigate`, `reload`, `history/back`, `history/forward`, `activate` |
| Page content | `html` (loaded DOM, `format=json\|html\|text`), `evaluate`, `screenshot`, `pdf`, `inspect` |
| Whole instance | `tabs/html` and `tabs/screenshot` capture every tab in one call |
| Input | `input` — mouse, key, and text events |
| Cookies | export (`GET /cookies`) and import (`POST /cookies/import`) |
| CDP proxy | `instances/:id/cdp/*` plus WebSocket, for Puppeteer/Playwright |
| Health | `healthz`, `server/stats`, `server/logs`, `config` |
| Docs | `docs` (browsable page), `openapi.json` (the contract) |

Two things worth knowing before you script against it:

- **`GET /instances/:id/tabs/:tabId/html` returns the DOM the browser currently
  holds** — after scripts have run — which is not what re-fetching the URL gives
  you. `ready_state` in the response tells you whether the load had finished.
- **`/instances/:id/cdp/*` proxies the raw DevTools endpoint**, so Puppeteer and
  Playwright can drive a managed browser through the API key. The browser's own
  CDP port has no authentication at all, so this is the safe way to expose it.
- **Closing the last tab never stops an instance.** The API opens a replacement
  blank tab first and returns it as `replacement`, because in `gui`/`xvfb` mode
  closing the final tab would terminate the browser.
