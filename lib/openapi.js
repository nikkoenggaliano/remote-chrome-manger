// The API contract, in one place.
//
// This module is the single source of truth for /openapi.json and for the
// browsable /docs page (which renders this spec rather than restating it), so
// documenting a new endpoint means editing exactly one file. server.js also
// cross-checks the registered Express routes against `documentedRoutes()` at
// boot and warns about anything missing, so the two cannot drift silently.

const ERROR_RESPONSE = {
  description: 'Error. The body carries a human-readable message.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

function json(schemaRef, description, example) {
  return {
    description,
    content: {
      'application/json': {
        schema: typeof schemaRef === 'string' ? { $ref: `#/components/schemas/${schemaRef}` } : schemaRef,
        ...(example ? { example } : {}),
      },
    },
  };
}

function body(schema, example, required = true) {
  return {
    required,
    content: { 'application/json': { schema, ...(example ? { example } : {}) } },
  };
}

const ID_PARAM = {
  name: 'id', in: 'path', required: true, description: 'Instance id.',
  schema: { type: 'integer' }, example: 1,
};
const TAB_PARAM = {
  name: 'tabId', in: 'path', required: true,
  description: 'CDP target id, from `GET /instances/{id}/tabs`.',
  schema: { type: 'string' }, example: '6F9634BFDD6EEA2DD6C2C04E4BBE84DC',
};

const SCHEMAS = {
  Error: {
    type: 'object',
    properties: { error: { type: 'string' } },
    example: { error: 'Instance 99 not found' },
  },
  Success: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    example: { success: true },
  },
  Instance: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', description: 'Unique; also the profile directory name.' },
      type: { type: 'string', enum: ['local', 'external'] },
      host: { type: 'string', description: '`0.0.0.0` listens on every interface.' },
      port: { type: 'integer', description: 'CDP debug port. Must be free and unique.' },
      forward_port: { type: 'integer', nullable: true },
      use_socat: { type: 'boolean' },
      launch_mode: { type: 'string', enum: ['chrome_headless', 'xvfb', 'gui', 'external'] },
      launch_mode_label: { type: 'string' },
      profile_dir: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['stopped', 'starting', 'running'] },
      started_at: { type: 'string', nullable: true, format: 'date-time' },
      tab_count: { type: 'integer', nullable: true, description: 'Open page targets. Null unless running and local.' },
      memory_bytes: { type: 'integer', nullable: true, description: 'Resident memory of the whole browser process tree.' },
      debug_endpoints: {
        type: 'array',
        description: 'Reachable CDP URLs, if you would rather attach Puppeteer or Playwright directly.',
        items: { type: 'object', properties: { interface: { type: 'string' }, host: { type: 'string' }, port: { type: 'integer' }, url: { type: 'string' } } },
      },
    },
    example: {
      id: 2, name: 'feat1', type: 'local', host: '0.0.0.0', port: 9360,
      launch_mode: 'chrome_headless', launch_mode_label: 'Native Chrome Headless',
      status: 'running', started_at: '2026-09-27T03:37:35.008Z',
      tab_count: 3, memory_bytes: 1322319872,
      debug_endpoints: [{ interface: 'en0', host: '192.168.110.2', port: 9360, url: 'http://192.168.110.2:9360' }],
    },
  },
  InstanceCreate: {
    type: 'object',
    required: ['name', 'type', 'host', 'port'],
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['local', 'external'] },
      host: { type: 'string' },
      port: { type: 'integer' },
      launch_mode: { type: 'string', enum: ['chrome_headless', 'xvfb', 'gui', 'external'], default: 'chrome_headless' },
      forward_port: { type: 'integer', nullable: true },
      use_socat: { type: 'boolean', default: false },
      profile_dir: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
    },
    example: { name: 'scraper-1', type: 'local', host: '0.0.0.0', port: 9222, launch_mode: 'chrome_headless' },
  },
  Target: {
    type: 'object',
    description: 'A raw CDP target. Filter on `type === "page"` for real tabs, because the list also contains iframes, workers and extension pages.',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', example: 'page' },
      title: { type: 'string' },
      url: { type: 'string' },
      webSocketDebuggerUrl: { type: 'string' },
    },
    example: {
      id: '6F9634BFDD6EEA2DD6C2C04E4BBE84DC', type: 'page',
      title: 'Example Domain', url: 'https://example.org/',
      webSocketDebuggerUrl: 'ws://0.0.0.0:9360/devtools/page/6F9634BFDD6EEA2DD6C2C04E4BBE84DC',
    },
  },
  PageDump: {
    type: 'object',
    properties: {
      instance_id: { type: 'integer' },
      tab_id: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      ready_state: { type: 'string', enum: ['loading', 'interactive', 'complete'], description: "The page's document.readyState at capture time." },
      html_bytes: { type: 'integer' },
      captured_at: { type: 'string', format: 'date-time' },
      html: { type: 'string', description: 'The DOM as the browser currently holds it, with the doctype restored.' },
      text: { type: 'string', description: 'document.body.innerText.' },
    },
    example: {
      instance_id: 2, tab_id: '6F9634BFDD…', url: 'https://example.org/',
      title: 'Example Domain', ready_state: 'complete', html_bytes: 560,
      captured_at: '2026-09-27T03:41:56.387Z',
      html: '<!DOCTYPE html>\n<html lang="en"><head>…</head><body>…</body></html>',
      text: 'Example Domain\n\nThis domain is for use in…',
    },
  },
  InspectedNode: {
    type: 'object',
    properties: {
      tag: { type: 'string' },
      id: { type: 'string', nullable: true },
      classes: { type: 'array', items: { type: 'string' } },
      selector: { type: 'string', description: 'Pasteable into querySelector.' },
      attributes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } },
      text: { type: 'string', description: 'Rendered text, truncated.' },
      outer_html: { type: 'string', description: 'The element markup, truncated.' },
      rect: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } } },
      link: { type: 'string', nullable: true, description: 'href of the nearest enclosing anchor, if any.' },
      image: { type: 'string', nullable: true, description: 'Resolved source when the element is an img.' },
      child_count: { type: 'integer' },
      styles: { type: 'object', additionalProperties: { type: 'string' } },
    },
    example: {
      tag: 'h1', id: null, classes: [], selector: 'html > body > div > h1',
      attributes: [], text: 'Example Domain',
      outer_html: '<h1>Example Domain</h1>',
      rect: { x: 256, y: 107, width: 768, height: 28 },
      link: null, image: null, child_count: 0,
      styles: { display: 'block', 'font-size': '24px', color: 'rgb(0, 0, 0)' },
    },
  },
  Cookie: {
    type: 'object',
    properties: {
      name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' },
      path: { type: 'string' }, expires: { type: 'number' }, httpOnly: { type: 'boolean' },
      secure: { type: 'boolean' }, sameSite: { type: 'string' },
    },
    example: { name: 'sid', value: 'abc123', domain: '.example.com', path: '/', secure: true },
  },
  Health: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      timestamp: { type: 'string', format: 'date-time' },
      server: { type: 'object' },
      instances: { type: 'object' },
    },
    example: {
      ok: true, timestamp: '2026-09-27T03:41:56.387Z',
      server: { hostname: 'chrome-fleet-01', platform: 'linux', cpu_usage_percent: 46.46, memory_usage_percent: 80.26 },
      instances: { total: 1, running: 1, starting: 0, stopped: 0 },
    },
  },
};

// [method, path, definition]. Order here is the order the docs page renders.
const OPERATIONS = [
  // --- Instances ---
  ['get', '/instances', {
    tags: ['Instances'], summary: 'List every instance',
    responses: { 200: json({ type: 'array', items: { $ref: '#/components/schemas/Instance' } }, 'All instances.'), default: ERROR_RESPONSE },
  }],
  ['post', '/instances', {
    tags: ['Instances'], summary: 'Create an instance',
    description: 'Registers an instance. It is not launched until you call `start`.',
    requestBody: body({ $ref: '#/components/schemas/InstanceCreate' }),
    responses: { 200: json('Instance', 'The created instance.'), 400: ERROR_RESPONSE },
  }],
  ['get', '/instances/{id}', {
    tags: ['Instances'], summary: 'Read one instance',
    description: 'Includes live `tab_count` and `memory_bytes` while the instance is running.',
    parameters: [ID_PARAM],
    responses: { 200: json('Instance', 'The instance.'), 404: ERROR_RESPONSE },
  }],
  ['put', '/instances/{id}', {
    tags: ['Instances'], summary: 'Replace an instance',
    parameters: [ID_PARAM], requestBody: body({ $ref: '#/components/schemas/InstanceCreate' }),
    responses: { 200: json('Instance', 'The updated instance.'), 400: ERROR_RESPONSE },
  }],
  ['patch', '/instances/{id}', {
    tags: ['Instances'], summary: 'Update an instance (partial)',
    parameters: [ID_PARAM],
    requestBody: body({ type: 'object' }, { notes: 'updated from REST' }),
    responses: { 200: json('Instance', 'The updated instance.'), 400: ERROR_RESPONSE },
  }],
  ['delete', '/instances/{id}', {
    tags: ['Instances'], summary: 'Delete an instance',
    description: 'Stops the browser first if it is running.',
    parameters: [ID_PARAM], responses: { 200: json('Success', 'Deleted.'), 404: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/start', {
    tags: ['Instances'], summary: 'Launch the browser',
    description: 'Returns once the CDP debug port is accepting connections, or fails with the reason.',
    parameters: [ID_PARAM], responses: { 200: json('Success', 'Running.'), 400: ERROR_RESPONSE, 500: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/spawn', {
    tags: ['Instances'], summary: 'Launch the browser (alias of start)',
    parameters: [ID_PARAM], responses: { 200: json('Success', 'Running.'), 400: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/stop', {
    tags: ['Instances'], summary: 'Terminate the browser',
    description: 'Closes Chrome and every tab it has open. The profile on disk is kept.',
    parameters: [ID_PARAM], responses: { 200: json('Success', 'Stopped.'), 404: ERROR_RESPONSE },
  }],
  ['get', '/instances/{id}/logs', {
    tags: ['Instances'], summary: "Tail the instance's logs",
    description: "Two separate files. `manager_logs` is the manager's own account of the instance: why it launched the way it did, why it was stopped, what the health checks saw. `chrome_logs` is the browser's own output. They used to share one file, which meant Chrome truncated the manager's lines away on every start.",
    parameters: [ID_PARAM],
    responses: {
      200: json({
        type: 'object',
        properties: {
          id: { type: 'integer' },
          manager_log_path: { type: 'string' },
          chrome_log_path: { type: 'string' },
          manager_logs: { type: 'string', nullable: true },
          chrome_logs: { type: 'string', nullable: true },
          logs: { type: 'string', description: 'Both tails joined, manager first. Kept for existing callers.' },
        },
      }, 'Last ~20 KB of each log.'),
      404: ERROR_RESPONSE,
    },
  }],

  ['delete', '/instances/{id}/logs', {
    tags: ['Instances'], summary: 'Clear the instance logs',
    description: "Empties both log files. They are truncated rather than deleted: Chrome holds them open, and unlinking would leave it writing into an inode nobody can read, silently losing every later line. The instance keeps running.",
    parameters: [ID_PARAM],
    responses: {
      200: json({
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          instance_id: { type: 'integer' },
          cleared: {
            type: 'array',
            items: { type: 'object', properties: { log: { type: 'string', example: 'manager' }, path: { type: 'string' }, freed_bytes: { type: 'integer' } } },
          },
        },
      }, 'What was emptied.', {
        success: true, instance_id: 1,
        cleared: [
          { log: 'manager', path: '/app/profiles/scraper-1/manager.log', freed_bytes: 748 },
          { log: 'chrome', path: '/app/profiles/scraper-1/chrome.log', freed_bytes: 4910 },
        ],
      }),
      404: ERROR_RESPONSE,
    },
  }],

  // --- Tabs ---
  ['get', '/instances/{id}/tabs', {
    tags: ['Tabs'], summary: 'List targets',
    parameters: [ID_PARAM],
    responses: { 200: json({ type: 'array', items: { $ref: '#/components/schemas/Target' } }, 'CDP targets.'), 404: ERROR_RESPONSE },
  }],
  ['get', '/instances/{id}/tabs/html', {
    tags: ['Page content'], summary: 'Dump the loaded DOM of every tab',
    description: 'The collection form of the per-tab dump: one round trip instead of listing tabs and fanning out by hand. A tab that cannot be read carries an `error` field instead of failing the batch, so a crashed tab still leaves the others usable. Bodies add up fast, so `metadata_only=1` returns the sizes and titles without them.',
    parameters: [ID_PARAM, {
      name: 'metadata_only', in: 'query', required: false,
      description: 'Omit `html` and `text`, keeping only URL, title, readyState and byte counts.',
      schema: { type: 'boolean', default: false },
    }],
    responses: {
      200: json({
        type: 'object',
        properties: {
          instance_id: { type: 'integer' },
          count: { type: 'integer' },
          failed: { type: 'integer', description: 'How many tabs reported an error.' },
          metadata_only: { type: 'boolean' },
          captured_at: { type: 'string', format: 'date-time' },
          tabs: { type: 'array', items: { $ref: '#/components/schemas/PageDump' } },
        },
      }, 'One entry per page target.', {
        instance_id: 1, count: 2, failed: 0, metadata_only: true,
        captured_at: '2026-09-29T09:58:12.004Z',
        tabs: [
          { tab_id: 'A1B2', url: 'https://example.com/', title: 'Example Domain', ready_state: 'complete', html_bytes: 560 },
          { tab_id: 'C3D4', url: 'about:blank', title: '', error: 'Tab C3D4 is no longer available on 127.0.0.1:9222' },
        ],
      }),
      404: ERROR_RESPONSE,
    },
  }],
  ['get', '/instances/{id}/tabs/screenshot', {
    tags: ['Page content'], summary: 'Screenshot every tab',
    description: 'The collection form of the per-tab screenshot. Images come back base64 encoded in the JSON so one response carries the whole set. Chrome serialises captures, so the cost grows with the tab count: `scale` is worth using here even more than for a single tab (measured over 4 tabs: 184 ms and 71 KB at full size, 95 ms and 23 KB at `scale=0.5`).',
    parameters: [ID_PARAM, {
      name: 'scale', in: 'query', required: false,
      description: 'Capture resolution as a fraction of the viewport, 0.25 to 1.',
      schema: { type: 'number', minimum: 0.25, maximum: 1, default: 1 }, example: 0.5,
    }],
    responses: {
      200: json({
        type: 'object',
        properties: {
          instance_id: { type: 'integer' },
          count: { type: 'integer' },
          failed: { type: 'integer' },
          captured_at: { type: 'string', format: 'date-time' },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tab_id: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' },
                format: { type: 'string', example: 'jpeg' },
                bytes: { type: 'integer' },
                data: { type: 'string', description: 'Base64 JPEG.' },
                error: { type: 'string', description: 'Present only when that tab failed.' },
              },
            },
          },
        },
      }, 'One image per page target.', {
        instance_id: 1, count: 1, failed: 0, captured_at: '2026-09-29T09:58:12.004Z',
        tabs: [{ tab_id: 'A1B2', url: 'https://example.com/', title: 'Example Domain', format: 'jpeg', bytes: 16187, data: '/9j/4AAQSkZJRgABAQAA…' }],
      }),
      404: ERROR_RESPONSE,
    },
  }],
  ['post', '/instances/{id}/tabs/new', {
    tags: ['Tabs'], summary: 'Open a tab',
    parameters: [ID_PARAM],
    requestBody: body({ type: 'object', properties: { url: { type: 'string', default: 'about:blank' } } }, { url: 'https://example.com' }, false),
    responses: { 200: json('Target', 'The new tab.'), 404: ERROR_RESPONSE },
  }],
  ['delete', '/instances/{id}/tabs/{tabId}', {
    tags: ['Tabs'], summary: 'Close a tab',
    description: 'Closing the **last** tab would terminate the browser in `gui`/`xvfb` mode, so a replacement blank tab is opened first and returned as `replacement`. It is `null` on every other close.',
    parameters: [ID_PARAM, TAB_PARAM],
    responses: {
      200: json({ type: 'object', properties: { success: { type: 'boolean' }, replacement: { $ref: '#/components/schemas/Target' } } },
        'Closed.', { success: true, replacement: { id: '9C1…', url: 'about:blank' } }),
      404: ERROR_RESPONSE,
    },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/navigate', {
    tags: ['Tabs'], summary: 'Navigate to a URL',
    description: 'Returns as soon as the navigation *starts*, not when the page has loaded. Poll `GET .../html` and watch `ready_state` if you need to wait.',
    parameters: [ID_PARAM, TAB_PARAM],
    requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, { url: 'https://example.com' }),
    responses: { 200: json('Success', 'Navigation started.'), 400: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/reload', {
    tags: ['Tabs'], summary: 'Reload the page',
    parameters: [ID_PARAM, TAB_PARAM],
    requestBody: body({ type: 'object', properties: { ignore_cache: { type: 'boolean', default: false } } }, { ignore_cache: true }, false),
    responses: { 200: json('Success', 'Reloading.'), 404: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/history/{direction}', {
    tags: ['Tabs'], summary: 'Go back or forward',
    parameters: [ID_PARAM, TAB_PARAM, {
      name: 'direction', in: 'path', required: true, schema: { type: 'string', enum: ['back', 'forward'] }, example: 'back',
    }],
    responses: {
      200: json({ type: 'object', properties: { success: { type: 'boolean' }, url: { type: 'string' }, title: { type: 'string' } } },
        'Moved.', { success: true, url: 'https://example.com/', title: 'Example Domain' }),
      400: ERROR_RESPONSE,
      409: json('Error', 'Nothing to move to in that direction.', { error: "No forward entry in this tab's history" }),
    },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/activate', {
    tags: ['Tabs'], summary: 'Bring the tab to the front',
    parameters: [ID_PARAM, TAB_PARAM], responses: { 200: json('Success', 'Activated.') },
  }],
  ['get', '/instances/{id}/tabs/{tabId}/html', {
    tags: ['Page content'], summary: 'Dump the loaded DOM',
    description: 'The DOM **as the browser currently holds it**, after scripts have run. This is not what re-fetching the URL gives you. The doctype is restored so a `format=html` dump opens as a standalone file.',
    parameters: [ID_PARAM, TAB_PARAM, {
      name: 'format', in: 'query', required: false,
      description: '`json` (default) returns the envelope; `html` returns `text/html`; `text` returns the rendered text.',
      schema: { type: 'string', enum: ['json', 'html', 'text'], default: 'json' },
    }],
    responses: {
      200: json('PageDump', 'The document. Content type follows `format`.'),
      400: ERROR_RESPONSE, 500: ERROR_RESPONSE,
    },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/evaluate', {
    tags: ['Page content'], summary: 'Run JavaScript in the page',
    description: 'The result is serialised by value, so return a plain object, not a DOM node. Promises are awaited by default. A throw inside the page comes back as `400` with the page\'s own message.',
    parameters: [ID_PARAM, TAB_PARAM],
    requestBody: body({
      type: 'object', required: ['expression'],
      properties: { expression: { type: 'string' }, await_promise: { type: 'boolean', default: true } },
    }, { expression: '({title: document.title, links: document.links.length})' }),
    responses: {
      200: json({ type: 'object', properties: { success: { type: 'boolean' }, value: {} } },
        'The evaluated value.', { success: true, value: { title: 'Example Domain', links: 1 } }),
      400: json('Error', 'Bad expression, or the page threw.', { error: 'Error: boom\n    at <anonymous>:1:7' }),
    },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/inspect', {
    tags: ['Page content'], summary: 'Inspect the element at a point',
    description: "Point at a viewport coordinate and get the element there: tag, id, classes, a pasteable CSS selector, attributes, text, outerHTML, bounding box, and a subset of computed styles. With `highlight` left on, the DevTools element highlight is drawn in the page, so it shows up in the screenshot stream too. Clear it with `DELETE .../highlight`.",
    parameters: [ID_PARAM, TAB_PARAM],
    requestBody: body({
      type: 'object', required: ['x', 'y'],
      properties: {
        x: { type: 'integer', description: 'Viewport CSS pixels from the left.' },
        y: { type: 'integer', description: 'Viewport CSS pixels from the top.' },
        highlight: { type: 'boolean', default: true, description: 'Draw the DevTools highlight on the element.' },
      },
    }, { x: 640, y: 120, highlight: true }),
    responses: {
      200: json({ type: 'object', properties: { success: { type: 'boolean' }, node: { $ref: '#/components/schemas/InspectedNode' } } },
        'The element at that point.'),
      400: ERROR_RESPONSE,
      404: json('Error', 'Nothing is rendered at that coordinate.', { error: 'No element at (640, 120)' }),
    },
  }],
  ['delete', '/instances/{id}/tabs/{tabId}/highlight', {
    tags: ['Page content'], summary: 'Clear the inspection highlight',
    parameters: [ID_PARAM, TAB_PARAM],
    responses: { 200: json('Success', 'Highlight removed.') },
  }],
  ['get', '/instances/{id}/tabs/{tabId}/screenshot', {
    tags: ['Page content'], summary: 'JPEG of the viewport',
    description: 'Quality follows the `SCREENSHOT_QUALITY` env var (10 to 100, default 60). `scale` below 1 makes Chrome read back fewer pixels, which is where the cost is: at 1920x993 a full frame takes about 80 ms and 18 KB, while `scale=0.5` takes about 50 ms and 6 KB.',
    parameters: [ID_PARAM, TAB_PARAM, {
      name: 'scale', in: 'query', required: false,
      description: 'Capture resolution as a fraction of the viewport, 0.25 to 1.',
      schema: { type: 'number', minimum: 0.25, maximum: 1, default: 1 }, example: 0.5,
    }],
    responses: {
      200: {
        description: 'JPEG image.',
        headers: {
          'X-Capture-Scale': {
            description: 'The scale actually applied, after clamping. A scaled frame is no longer 1:1 with the page, so divide image coordinates by this before sending them to `input` or `inspect`, or the click lands short by exactly this factor.',
            schema: { type: 'number', example: 0.5 },
          },
        },
        content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
      },
      500: ERROR_RESPONSE,
    },
  }],
  ['get', '/instances/{id}/tabs/{tabId}/pdf', {
    tags: ['Page content'], summary: 'Print the page to PDF',
    parameters: [ID_PARAM, TAB_PARAM,
      { name: 'landscape', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'], default: '0' } },
      { name: 'background', in: 'query', required: false, description: '`0` drops background graphics.', schema: { type: 'string', enum: ['0', '1'], default: '1' } },
    ],
    responses: { 200: { description: 'PDF document.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 500: ERROR_RESPONSE },
  }],
  ['post', '/instances/{id}/tabs/{tabId}/input', {
    tags: ['Page content'], summary: 'Send mouse, key, or text input',
    description: '`params` is passed straight through to `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, or `Input.insertText`. A click is a `mousePressed` followed by a `mouseReleased`.',
    parameters: [ID_PARAM, TAB_PARAM],
    requestBody: body({
      type: 'object', required: ['type', 'params'],
      properties: { type: { type: 'string', enum: ['mouse', 'key', 'text'] }, params: { type: 'object' } },
    }, { type: 'mouse', params: { type: 'mousePressed', x: 400, y: 300, button: 'left', clickCount: 1 } }),
    responses: { 200: json('Success', 'Dispatched.'), 400: ERROR_RESPONSE },
  }],

  // --- CDP proxy ---
  ['get', '/instances/{id}/cdp/{path}', {
    tags: ['CDP proxy'], summary: "Proxy the instance's DevTools endpoint",
    description: [
      "A transparent reverse proxy in front of the browser's own DevTools endpoint, so Puppeteer, Playwright, chrome-remote-interface or anything else that speaks CDP can drive a managed instance through this API.",
      '',
      'The point is authentication: the raw CDP port has none at all, so anyone who can route to it owns the browser. Going through here puts the API key in front of it and collapses the whole fleet onto one reachable port.',
      '',
      'Any DevTools path works: `json/version`, `json`, `json/new?<url>`, `json/close/<targetId>`, `json/protocol`. Every `webSocketDebuggerUrl` in the response is rewritten to come back through the proxy, so a client that follows them stays authenticated instead of dialling the unprotected port.',
      '',
      'WebSocket endpoints (`.../cdp/devtools/browser/<id>` and `.../cdp/devtools/page/<targetId>`) are proxied too. Authenticate with the `X-API-Key` header, or with `?key=<key>` when the client cannot set headers. Prefer the header: query strings land in access logs and shell history.',
      '',
      'A client that stops reading is throttled and then dropped rather than buffered without limit, and an upstream failure arrives as a close frame carrying the reason instead of a socket that never answers.',
    ].join('\n'),
    parameters: [ID_PARAM, {
      name: 'path', in: 'path', required: true,
      description: [
        'Catch-all, not a single segment: whatever you put here is forwarded verbatim to the browser, so it is any path you would normally hit on the raw CDP port.',
        '',
        '`json/version` browser build and the browser-level WebSocket URL',
        '`json` or `json/list` every open target',
        '`json/new?<url>` open a tab (PUT)',
        '`json/close/<targetId>` close a target',
        '`json/activate/<targetId>` focus a target',
        '`json/protocol` the full protocol definition',
        '`devtools/browser/<id>` browser-level WebSocket session',
        '`devtools/page/<targetId>` page-level WebSocket session',
        '',
        'So `/rest/instances/1/cdp/json/version` reaches `http://<instance host>:<instance port>/json/version`.',
      ].join('\n'),
      schema: { type: 'string' }, example: 'json/version',
    }],
    responses: {
      200: json({ type: 'object' }, "Chrome's own response, with debugger URLs rewritten.", {
        Browser: 'Chrome/154.0.8037.58',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://HOST:PORT/rest/instances/1/cdp/devtools/browser/30a98fed-65b8-493d-9ce4-43c1c6cf96ae',
      }),
      404: json('Error', 'Instance not found, or the REST API is disabled.'),
      409: json('Error', 'The instance is not running.', { error: 'Instance "scraper-1" is stopped. Start it before using its CDP endpoint.' }),
      502: json('Error', "The instance is running but its CDP endpoint did not answer."),
    },
  }],

  // --- Cookies ---
  ['get', '/instances/{id}/cookies', {
    tags: ['Cookies'], summary: "Export the profile's cookies",
    parameters: [ID_PARAM, {
      name: 'domain', in: 'query', required: false,
      description: 'Only cookies whose domain ends with this value.',
      schema: { type: 'string' }, example: 'example.com',
    }],
    responses: {
      200: json({ type: 'object', properties: { instance_id: { type: 'integer' }, count: { type: 'integer' }, cookies: { type: 'array', items: { $ref: '#/components/schemas/Cookie' } } } }, 'Cookies in the profile.'),
      409: json('Error', 'The instance has no open page to read cookies through.'),
    },
  }],
  ['post', '/instances/{id}/cookies/import', {
    tags: ['Cookies'], summary: 'Import cookie files',
    description: [
      'Three shapes are accepted, so a script does not have to pretend to be a file picker:',
      '',
      '`cookies` an array of cookie objects, the simplest thing for an API client',
      '`content` one export pasted in as a string, Netscape `cookies.txt` or JSON',
      '`files` a list of `{name, content}`, which is what the dashboard sends',
      '',
      'Per-cookie failures are listed in `failures` rather than failing the request. The instance must be running.',
    ].join('\n'),
    parameters: [ID_PARAM],
    requestBody: body({
      type: 'object',
      properties: {
        cookies: { type: 'array', items: { $ref: '#/components/schemas/Cookie' }, description: 'Cookie objects, imported directly.' },
        content: { type: 'string', description: 'A Netscape or JSON cookie export, as text.' },
        name: { type: 'string', description: 'Optional label for `content`, used in the per-file report.' },
        files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } } } },
      },
    }, { cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }] }),
    responses: {
      200: json({ type: 'object', properties: { success: { type: 'boolean' }, imported: { type: 'integer' }, failed: { type: 'integer' }, failures: { type: 'array', items: { type: 'object' } } } },
        'Import result.', { success: true, imported: 1, failed: 0, failures: [], total_cookies: 1 }),
      400: ERROR_RESPONSE,
    },
  }],

  // --- Server ---
  ['get', '/healthz', {
    tags: ['Server'], summary: 'Liveness, host stats and instance summary',
    description: 'Good as a container healthcheck or a scrape target. `/healtz` is kept as a typo alias.',
    responses: { 200: json('Health', 'Healthy.') },
  }],
  ['get', '/healtz', { tags: ['Server'], summary: 'Alias of /healthz', responses: { 200: json('Health', 'Healthy.') } }],
  ['get', '/server/healthz', { tags: ['Server'], summary: 'Alias of /healthz', responses: { 200: json('Health', 'Healthy.') } }],
  ['get', '/server/healtz', { tags: ['Server'], summary: 'Alias of /healthz', responses: { 200: json('Health', 'Healthy.') } }],
  ['get', '/server/stats', {
    tags: ['Server'], summary: 'Host CPU, memory, disk and interfaces',
    responses: { 200: json({ type: 'object' }, 'Host statistics.') },
  }],
  ['get', '/server/logs', {
    tags: ['Server'], summary: 'Recent server log lines',
    responses: { 200: json({ type: 'array', items: { type: 'string' } }, 'Log lines, oldest first.') },
  }],
  ['get', '/capabilities', {
    tags: ['Server'], summary: 'What this host supports',
    responses: { 200: json({ type: 'object', properties: { platform: { type: 'string' }, xvfb_supported: { type: 'boolean' } } }, 'Platform capabilities.') },
  }],
  ['get', '/config', {
    tags: ['Server'], summary: 'Read the config map',
    description: '`rest_api_enabled` and `rest_api_key` are deliberately excluded. They are managed in the dashboard so the toggle and the key stay consistent.',
    responses: { 200: json({ type: 'object', additionalProperties: { type: 'string' } }, 'Key/value config.') },
  }],
  ['post', '/config', {
    tags: ['Server'], summary: 'Set a config key',
    requestBody: body({ type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } }, { key: 'chrome_bin', value: '/usr/bin/google-chrome' }),
    responses: { 200: json('Success', 'Stored.'), 400: ERROR_RESPONSE },
  }],
  ['delete', '/config/{key}', {
    tags: ['Server'], summary: 'Delete a config key',
    parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: json('Success', 'Deleted.'), 400: ERROR_RESPONSE },
  }],

  // --- Docs ---
  ['get', '/docs', {
    tags: ['Docs'], summary: 'This page',
    description: 'Browsable contract. Served without an API key so it can be opened in a browser; it contains no data and no secrets.',
    security: [], responses: { 200: { description: 'HTML documentation page.', content: { 'text/html': {} } } },
  }],
  ['get', '/openapi.json', {
    tags: ['Docs'], summary: 'This contract, as OpenAPI 3.1',
    description: 'Import into Postman, Insomnia, or a client generator. Served without an API key.',
    security: [], responses: { 200: json({ type: 'object' }, 'OpenAPI document.') },
  }],
];

const TAG_ORDER = [
  { name: 'Instances', description: 'Register, launch and terminate browser instances.' },
  { name: 'Tabs', description: 'Open, close and steer tabs.' },
  { name: 'Page content', description: 'Read and drive what a tab is showing.' },
  { name: 'CDP proxy', description: 'Reach the raw DevTools protocol through the API key.' },
  { name: 'Cookies', description: 'Move a profile\'s session in and out.' },
  { name: 'Server', description: 'Health, host statistics and configuration.' },
  { name: 'Docs', description: 'The contract itself.' },
];

// "METHOD /path" for every documented operation, for the boot-time drift check.
function documentedRoutes() {
  return new Set(OPERATIONS.map(([method, path]) => `${method.toUpperCase()} ${path}`));
}

function buildOpenApiSpec(options = {}) {
  const { serverUrl = '/rest', surface = 'rest' } = options;

  const paths = {};
  for (const [method, path, definition] of OPERATIONS) {
    if (!paths[path]) paths[path] = {};
    paths[path][method] = definition;
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Chrome Fleet Control API',
      version: '1.0.0',
      description: [
        'Control a fleet of Chrome/Chromium instances over the DevTools Protocol:',
        'launch browsers, drive tabs, and read the DOM a page has actually rendered.',
        '',
        surface === 'rest'
          ? 'Authenticate with `X-API-Key: <key>` or `Authorization: Bearer <key>`. The key is issued in the dashboard under Configuration -> REST API.'
          : 'This is the dashboard surface; it uses the same Basic Auth session as the UI. The token-protected copy lives under `/rest`.',
      ].join('\n'),
    },
    servers: [{ url: serverUrl }],
    tags: TAG_ORDER,
    paths,
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        BearerToken: { type: 'http', scheme: 'bearer' },
      },
    },
  };

  if (surface === 'rest') {
    spec.security = [{ ApiKeyHeader: [] }, { BearerToken: [] }];
  }
  return spec;
}

module.exports = { buildOpenApiSpec, documentedRoutes };
