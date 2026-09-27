# REST API

The REST API exposes everything the dashboard can do to scripts and other
services: create instances, launch browsers, drive tabs, read the loaded DOM. It
is authenticated with an API key instead of the dashboard login.

Every example below was run against a live server; the responses are real, only
trimmed where noted.

---

## 1. Enable it

The API is off until you switch it on in the dashboard: **Configuration → REST
API**. Turn the switch on, click **Generate** for a key, then **Save**. The
change is live immediately, with no restart.

`REST_API` / `REST_API_KEY` in `.env` only seed these values the first time the
server runs against a fresh database. After that the dashboard is the source of
truth.

While the API is disabled, every `/rest/*` path answers:

```json
{ "error": "REST API is disabled. Enable it in Configuration -> REST API." }
```

with status `404`, because a disabled deployment does not advertise that the
API exists.

## 2. Authenticate

Send the key as either header:

```bash
curl -H "X-API-Key: <key>"            http://HOST:3000/rest/instances
curl -H "Authorization: Bearer <key>" http://HOST:3000/rest/instances
```

A missing or wrong key gives `401`:

```json
{ "error": "Invalid or missing REST API key" }
```

The key is compared in constant time. Rotating it in the dashboard takes effect
on the very next request, so update your clients when you rotate.

> The dashboard's own `/api/*` endpoints use Basic Auth and are a separate
> surface. REST settings are deliberately **not** exposed under `/rest`, so an
> API client cannot rotate its own key or switch the API off.

## 3. Browsable contract

The server publishes its own API reference, so you do not have to read this file
to look up a shape:

| URL | Needs | What it is |
|---|---|---|
| `/rest/docs` | REST API enabled | Browsable reference with a **Try** button per operation |
| `/rest/openapi.json` | REST API enabled | OpenAPI 3.1 document |
| `/api/docs` | Dashboard login | The same page, on the Basic Auth surface |
| `/api/openapi.json` | Dashboard login | The same contract, `/api` as the server URL |

Neither docs URL requires the API key. A browser cannot set an `X-API-Key`
header, and the contract contains no data and no secrets, only the shape of
endpoints that are themselves key-protected. They still disappear with the rest
of `/rest` when the API is switched off. Paste your key into the field at the
top of the page to make the **Try** buttons work; it is kept in that tab's
`sessionStorage` and sent nowhere else.

The spec is generated from `lib/openapi.js`, and at boot the server compares it
against the routes Express actually registered. It logs any endpoint that is
served but undocumented, so the contract cannot quietly fall behind the code.

There is also a Postman/codegen path:

```bash
curl -s http://HOST:PORT/rest/openapi.json -o chrome-fleet.openapi.json
```

## 4. Conventions

| | |
|---|---|
| Base URL | `http://HOST:PORT/rest` |
| Request body | `application/json` |
| Success | `200` with a JSON body; mutations usually return `{"success": true, ...}` |
| Errors | JSON `{"error": "<message>"}` with a `4xx`/`5xx` status |
| CORS | Allowed from any origin while the API is enabled |

Status codes you should handle:

| Code | Meaning |
|---|---|
| `400` | Bad input: missing field, bad `format`, a script that threw |
| `401` | Missing/invalid API key |
| `404` | API disabled, unknown instance, or unknown endpoint |
| `409` | Valid request, impossible right now (no history entry, no open tab) |
| `500` | Server or browser-side failure; the message says which |

`id` in the paths below is the **instance id** (an integer). `tabId` is the CDP
**target id** (a hex string) from `GET /instances/:id/tabs`.

---

## 5. Quick start

Launch a browser, open a page, read back what it actually rendered:

```bash
BASE=http://127.0.0.1:3000/rest
AUTH="X-API-Key: your-key-here"

# 1. Create an instance (headless, CDP on port 9222)
ID=$(curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"scraper-1","type":"local","host":"0.0.0.0","port":9222,"launch_mode":"chrome_headless"}' \
  $BASE/instances | jq -r '.id')

# 2. Start Chrome
curl -s -X POST -H "$AUTH" $BASE/instances/$ID/start

# 3. Open a tab on a URL
TAB=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' \
  $BASE/instances/$ID/tabs/new | jq -r '.id')

# 4. Read the DOM *after* JavaScript has run
curl -s -H "$AUTH" "$BASE/instances/$ID/tabs/$TAB/html?format=html" -o page.html

# 5. Shut it down
curl -s -X POST -H "$AUTH" $BASE/instances/$ID/stop
```

---

## 6. Instances

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/instances` | List all instances |
| `GET` | `/instances/:id` | One instance, with live tab count and memory |
| `POST` | `/instances` | Create |
| `PUT` / `PATCH` | `/instances/:id` | Update (PATCH accepts partial bodies) |
| `DELETE` | `/instances/:id` | Delete |
| `POST` | `/instances/:id/start` | Launch the browser (alias: `/spawn`) |
| `POST` | `/instances/:id/stop` | Terminate the browser |
| `GET` | `/instances/:id/logs` | Tail of the instance's `chrome.log` |

### Create

```bash
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
        "name": "scraper-1",
        "type": "local",
        "host": "0.0.0.0",
        "port": 9222,
        "launch_mode": "chrome_headless"
      }' \
  $BASE/instances
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique; also the profile directory name |
| `type` | yes | `local` (this host launches it) or `external` (already running elsewhere) |
| `host` | yes | `0.0.0.0` to listen on every interface |
| `port` | yes | CDP debug port; must be free and unique across instances |
| `launch_mode` | no | `chrome_headless` (default), `xvfb`, `gui`, or `external` |
| `forward_port` + `use_socat` | no | Publish the CDP port through socat |
| `profile_dir` | no | Absolute path; defaults to `<profiles_dir>/<name>` |
| `notes` | no | Free text |

> **Launch mode matters.** `gui` and `xvfb` drive a real browser window; native
> headless does not. See *Tab lifecycle* below.

### Read

`GET /instances/:id`:

```json
{
  "id": 2,
  "name": "feat1",
  "type": "local",
  "host": "0.0.0.0",
  "port": 9360,
  "forward_port": null,
  "launch_mode": "chrome_headless",
  "status": "running",
  "started_at": "2026-09-27T03:37:35.008Z",
  "tab_count": 3,
  "memory_bytes": 1322319872,
  "launch_mode_label": "Native Chrome Headless",
  "launch_backend": "chrome_headless",
  "headless_enabled": true,
  "xvfb_enabled": false,
  "debug_endpoints": [
    { "interface": "en0", "host": "192.168.110.2", "port": 9360, "url": "http://192.168.110.2:9360" }
  ],
  "forward_targets": [],
  "forward_to": []
}
```

`status` is one of `stopped`, `starting`, `running`. `tab_count` and
`memory_bytes` are only populated for running local instances (`null` otherwise);
`memory_bytes` is the resident memory of the whole browser process tree.

`debug_endpoints` lists the reachable CDP URLs, which is useful if you want to
attach Puppeteer or Playwright directly instead of going through this API.

---

## 7. Tabs

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/instances/:id/tabs` | List targets |
| `POST` | `/instances/:id/tabs/new` | Open a tab |
| `DELETE` | `/instances/:id/tabs/:tabId` | Close a tab |
| `POST` | `/instances/:id/tabs/:tabId/navigate` | Go to a URL |
| `POST` | `/instances/:id/tabs/:tabId/reload` | Reload |
| `POST` | `/instances/:id/tabs/:tabId/history/back` | Back |
| `POST` | `/instances/:id/tabs/:tabId/history/forward` | Forward |
| `POST` | `/instances/:id/tabs/:tabId/activate` | Bring to front |
| `GET` | `/instances/:id/tabs/:tabId/html` | **Dump the loaded DOM** |
| `POST` | `/instances/:id/tabs/:tabId/evaluate` | Run JavaScript |
| `GET` | `/instances/:id/tabs/:tabId/screenshot` | JPEG of the viewport |
| `GET` | `/instances/:id/tabs/:tabId/pdf` | Print the page to PDF |
| `POST` | `/instances/:id/tabs/:tabId/input` | Mouse / keyboard / text |

### List

`GET /instances/:id/tabs` returns raw CDP targets. Filter on `type === "page"`
for actual tabs, because the list also contains iframes, workers and extension
pages.

```json
{
  "id": "6F9634BFDD6EEA2DD6C2C04E4BBE84DC",
  "type": "page",
  "title": "Example Domain",
  "url": "https://example.org/",
  "webSocketDebuggerUrl": "ws://0.0.0.0:9360/devtools/page/6F9634BFDD6EEA2DD6C2C04E4BBE84DC"
}
```

### Open and navigate

```bash
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' $BASE/instances/$ID/tabs/new

curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.org"}' $BASE/instances/$ID/tabs/$TAB/navigate
```

`navigate` returns as soon as the navigation is *started*, not when the page has
finished loading. Poll `GET .../html` and check `ready_state` if you need to wait.

### Reload, back, forward

```bash
curl -X POST -H "$AUTH" $BASE/instances/$ID/tabs/$TAB/reload
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"ignore_cache":true}' $BASE/instances/$ID/tabs/$TAB/reload

curl -X POST -H "$AUTH" $BASE/instances/$ID/tabs/$TAB/history/back
# {"success":true,"url":"https://example.com/","title":"Example Domain"}
```

At the end of the history, back/forward answer `409`:

```json
{ "error": "No forward entry in this tab's history" }
```

### Dump the loaded HTML

This is the DOM **as the browser currently holds it**, after scripts ran and the
framework rendered. It is not the same as re-fetching the URL, which gives you
the server's raw response.

```bash
# JSON envelope with metadata (default)
curl -H "$AUTH" $BASE/instances/$ID/tabs/$TAB/html

# just the document, ready to save
curl -H "$AUTH" "$BASE/instances/$ID/tabs/$TAB/html?format=html" -o page.html

# rendered text only
curl -H "$AUTH" "$BASE/instances/$ID/tabs/$TAB/html?format=text"
```

```json
{
  "instance_id": 2,
  "tab_id": "6F9634BFDD6EEA2DD6C2C04E4BBE84DC",
  "url": "https://example.org/",
  "title": "Example Domain",
  "ready_state": "complete",
  "html_bytes": 560,
  "captured_at": "2026-09-27T03:41:56.387Z",
  "html": "<!DOCTYPE html>\n<html lang=\"en\"><head>…</head><body>…</body></html>",
  "text": "Example Domain\n\nThis domain is for use in…"
}
```

| Param | Values | Result |
|---|---|---|
| `format` | `json` (default) | The envelope above |
| | `html` | `text/html`, the document only |
| | `text` | `text/plain`, from `document.body.innerText` |

`ready_state` is the page's `document.readyState`. A value of `loading` means you
captured mid-load; wait and capture again. The doctype is reconstructed, so a
`format=html` dump opens as a standalone file.

### Run JavaScript

```bash
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"expression":"({title: document.title, links: document.links.length})"}' \
  $BASE/instances/$ID/tabs/$TAB/evaluate
```

```json
{ "success": true, "value": { "title": "Example Domain", "links": 1 } }
```

The expression is evaluated in the page and the result is serialised by value, so
you get plain JSON back, so return an object rather than a DOM node. Promises
are awaited by default; pass `"await_promise": false` to get the promise object instead.

A throw inside the page is reported as `400` with the page's own message:

```json
{ "error": "Error: boom\n    at <anonymous>:1:7" }
```

### Screenshot and PDF

```bash
curl -H "$AUTH" $BASE/instances/$ID/tabs/$TAB/screenshot -o shot.jpg
curl -H "$AUTH" "$BASE/instances/$ID/tabs/$TAB/pdf?landscape=1" -o page.pdf
```

Screenshot JPEG quality follows the `SCREENSHOT_QUALITY` env var (10 to 100,
default 60). PDF accepts `landscape=1` and `background=0`.

### Synthetic input

```bash
# click at (400, 300): press then release
for t in mousePressed mouseReleased; do
  curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"type\":\"mouse\",\"params\":{\"type\":\"$t\",\"x\":400,\"y\":300,\"button\":\"left\",\"clickCount\":1}}" \
    $BASE/instances/$ID/tabs/$TAB/input
done

# type text
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"text","params":{"text":"hello"}}' \
  $BASE/instances/$ID/tabs/$TAB/input
```

`type` is `mouse`, `key`, or `text`; `params` is passed straight through to
`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, or `Input.insertText`.

### Tab lifecycle

Closing the **last** tab would terminate the browser outright in `gui` and `xvfb`
mode. Rather than let a tab close stop an instance, the API opens a replacement
blank tab first and reports it:

```json
{ "success": true, "replacement": { "id": "9C1…", "url": "about:blank" } }
```

`replacement` is `null` on every other close. So an instance always has at least
one page target while it is running.

---

## 8. Cookies

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/instances/:id/cookies` | Export every cookie in the profile |
| `POST` | `/instances/:id/cookies/import` | Import cookie files |

```bash
# export, optionally narrowed to one domain
curl -H "$AUTH" "$BASE/instances/$ID/cookies?domain=example.com"
```

```json
{ "instance_id": 2, "count": 12, "cookies": [ { "name": "sid", "value": "…", "domain": ".example.com", "path": "/" } ] }
```

Import accepts Netscape `cookies.txt` and common JSON exports; send the file
contents inline:

```bash
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"cookies.json","content":"[{\"name\":\"sid\",\"value\":\"abc\",\"domain\":\".example.com\",\"path\":\"/\"}]"}]}' \
  $BASE/instances/$ID/cookies/import
```

```json
{ "success": true, "imported": 1, "failed": 0, "failures": [], "total_cookies": 1 }
```

The instance must be running. Per-cookie failures are listed in `failures`
instead of failing the whole request.

---

## 9. Health, server and config

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness + host stats + instance summary |
| `GET` | `/server/stats` | Host CPU, memory, disk, interfaces |
| `GET` | `/server/logs` | Recent server log lines |
| `GET` | `/config` | Key/value config map |
| `POST` | `/config` | Set a config key |
| `DELETE` | `/config/:key` | Delete a config key |

```json
{
  "ok": true,
  "timestamp": "2026-09-27T03:41:56.387Z",
  "server": {
    "hostname": "chrome-fleet-01",
    "platform": "linux",
    "cpu_usage_percent": 46.46,
    "memory_usage_percent": 80.26
  },
  "instances": { "total": 1, "running": 1, "starting": 0, "stopped": 0 }
}
```

`/healthz` is a good container healthcheck and a good scrape target. `/healtz`
is kept as a typo alias.

`rest_api_enabled` and `rest_api_key` are **not** returned by `/config` and
cannot be written through it. They are managed in the dashboard so that the
toggle and the key stay consistent.

---

## 10. Worked example: scrape a JS-rendered page

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:3000/rest
AUTH="X-API-Key: $REST_KEY"
ID=1

TAB=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' $BASE/instances/$ID/tabs/new | jq -r '.id')

# wait for the document to finish loading
for _ in $(seq 1 30); do
  state=$(curl -s -H "$AUTH" $BASE/instances/$ID/tabs/$TAB/html | jq -r '.ready_state')
  [ "$state" = "complete" ] && break
  sleep 0.5
done

# pull structured data straight out of the page
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"expression":"[...document.querySelectorAll(\"a\")].map(a => ({text: a.innerText, href: a.href}))"}' \
  $BASE/instances/$ID/tabs/$TAB/evaluate | jq '.value'

# and keep the rendered DOM for the record
curl -s -H "$AUTH" "$BASE/instances/$ID/tabs/$TAB/html?format=html" -o page.html

curl -s -X DELETE -H "$AUTH" $BASE/instances/$ID/tabs/$TAB >/dev/null
```
