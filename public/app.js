const socket = io();

// --- Elements ---
const pageTitle = document.getElementById('page-title');
const btnAddInstance = document.getElementById('btnAddInstance');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const htmlEl = document.documentElement;

// Navigation
const navDashboard = document.getElementById('nav-dashboard');
const navServer = document.getElementById('nav-server');
const navConfig = document.getElementById('nav-config');
const views = {
    dashboard: document.getElementById('view-dashboard'),
    server: document.getElementById('view-server'),
    config: document.getElementById('view-config')
};

// Dashboard
const viewToggleBtns = document.querySelectorAll('#viewToggle button');
const instancesList = document.getElementById('instances-list');
const instancesTableContainer = document.getElementById('instances-table-container');
const instancesTableBody = document.getElementById('instances-table-body');
let currentViewMode = 'grid'; 

// Add Instance
const addInstanceForm = document.getElementById('addInstanceForm');
const instanceType = document.getElementById('instanceType');
const localOptionsInputs = document.getElementById('localOptionsInputs');
const localOptionsCheckboxes = document.getElementById('localOptionsCheckboxes');
const launchMode = document.getElementById('launchMode');
const useSocat = document.getElementById('use_socat');
const inputDebugPort = document.getElementById('inputDebugPort');
const inputForwardPort = document.getElementById('inputForwardPort');
const editInstanceForm = document.getElementById('editInstanceForm');
const editInstanceName = document.getElementById('editInstanceName');
const editLaunchModeGroup = document.getElementById('editLaunchModeGroup');
const editLaunchMode = document.getElementById('editLaunchMode');
const editInstanceNotes = document.getElementById('editInstanceNotes');
const editInstanceModal = new bootstrap.Modal(document.getElementById('editInstanceModal'));
const importCookiesModalEl = document.getElementById('importCookiesModal');
const importCookiesModal = new bootstrap.Modal(importCookiesModalEl);
const importCookiesForm = document.getElementById('importCookiesForm');
const importCookiesInstanceName = document.getElementById('importCookiesInstanceName');
const importCookiesFilesInput = document.getElementById('importCookiesFiles');
const importCookiesSelectedFiles = document.getElementById('importCookiesSelectedFiles');
const importCookiesResult = document.getElementById('importCookiesResult');
const importCookiesSubmitBtn = document.getElementById('importCookiesSubmitBtn');

// Control Modal
const controlModalEl = document.getElementById('controlModal');
const controlModal = new bootstrap.Modal(controlModalEl);
const tabList = document.getElementById('tabList');
const tabContent = document.getElementById('tabContent');
const noTabSelected = document.getElementById('noTabSelected');
const tabScreenshot = document.getElementById('tabScreenshot');
const activeTabUrl = document.getElementById('activeTabUrl');
const tabCountBadge = document.getElementById('tabCountBadge');
const screenWrapper = document.getElementById('screenWrapper');
const focusHint = document.getElementById('focusHint');
const btnLiveToggle = document.getElementById('btnLiveToggle');
const liveToggleLabel = document.getElementById('liveToggleLabel');
const liveFps = document.getElementById('liveFps');
const liveScale = document.getElementById('liveScale');
const streamStatusDot = document.getElementById('streamStatusDot');
const streamStatusText = document.getElementById('streamStatusText');
const streamLatency = document.getElementById('streamLatency');

// Dashboard toolbar
const instanceSearch = document.getElementById('instanceSearch');
const fleetSummary = document.getElementById('fleetSummary');
const btnStartAll = document.getElementById('btnStartAll');
const btnStopAll = document.getElementById('btnStopAll');

// Log Modal
const logModal = new bootstrap.Modal(document.getElementById('logModal'));
const logContent = document.getElementById('instance-logs-content');

// Stats
const serverLogsContainer = document.getElementById('server-logs');

// --- State ---
let allInstances = [];
let currentInstanceId = null;
let currentTabId = null;
let statsInterval = null;
let currentLogInstanceId = null;
let currentEditInstanceId = null;
let currentImportInstanceId = null;
let searchQuery = '';
let serverCaps = { platform: null, xvfb_supported: true };

// Control / streaming state
let liveEnabled = true;       // is live streaming toggled on
let streamLoopActive = false; // is the async capture loop currently running
let controlModalOpen = false;
let currentTabObjectUrl = null; // object URL of the frame currently shown
let dragging = false;           // mouse drag in progress over the screenshot

// --- Init ---

// Theme Init
const savedTheme = localStorage.getItem('theme') || 'light';
setTheme(savedTheme);

themeToggle.addEventListener('click', () => {
    const current = htmlEl.getAttribute('data-theme');
    const newTheme = current === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
});

function setTheme(theme) {
    htmlEl.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (theme === 'dark') {
        themeIcon.className = 'bi bi-moon-stars-fill';
    } else {
        themeIcon.className = 'bi bi-sun-fill';
    }
}

socket.on('instances_updated', (instances) => {
    allInstances = instances;
    renderInstances(instances);
});

// --- Platform capabilities (e.g. Xvfb is Linux-only) ---
async function loadCapabilities() {
    try {
        const caps = await fetchAPI('/api/capabilities');
        if (caps && typeof caps === 'object') serverCaps = caps;
    } catch (e) {
        // Keep optimistic defaults if the probe fails.
    }
    applyCapabilities();
}

function applyCapabilities() {
    // Disable the Xvfb option on platforms that don't support it (macOS/Windows)
    // and relabel it so the limitation is obvious.
    [launchMode, editLaunchMode].forEach((select) => {
        if (!select) return;
        const opt = select.querySelector('option[value="xvfb"]');
        if (!opt) return;
        if (serverCaps.xvfb_supported) {
            opt.disabled = false;
            opt.textContent = 'Headless via Xvfb';
        } else {
            opt.disabled = true;
            opt.textContent = 'Headless via Xvfb (Linux only)';
            // If anything left an unsupported value selected, fall back.
            if (select.value === 'xvfb') select.value = 'chrome_headless';
        }
    });
}

loadCapabilities();

// Prepare Add Instance Form with Random Values
const addInstanceModalEl = document.getElementById('addInstanceModal');
addInstanceModalEl.addEventListener('show.bs.modal', () => {
    const randomId = Math.floor(1000 + Math.random() * 9000);
    const nameInput = addInstanceForm.querySelector('[name="name"]');
    
    // Generate Unique Name
    let name = `Chrome-${randomId}`;
    while (allInstances.some(inst => inst.name === name)) {
        name = `Chrome-${Math.floor(1000 + Math.random() * 9000)}`;
    }
    nameInput.value = name;

    // Generate Unique Debug Port (Range 9222-9999)
    let dPort = 9222 + Math.floor(Math.random() * 700);
    // Ensure dPort is even or just check uniqueness for both dPort and dPort+1
    while (allInstances.some(inst => inst.port === dPort || inst.forward_port === dPort + 1)) {
        dPort += 2;
    }
    inputDebugPort.value = dPort;

    // Forward Port is always Debug Port + 1
    inputForwardPort.value = dPort + 1;
    
    // Default checkboxes
    instanceType.value = 'local';
    launchMode.value = serverCaps.xvfb_supported ? 'xvfb' : 'chrome_headless';
    useSocat.checked = true;
    syncInstanceTypeOptions();
});

// View Toggle
viewToggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        viewToggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentViewMode = btn.dataset.view;
        toggleDashboardView();
    });
});

function toggleDashboardView() {
    if (currentViewMode === 'grid') {
        instancesList.classList.remove('d-none');
        instancesTableContainer.classList.add('d-none');
    } else {
        instancesList.classList.add('d-none');
        instancesTableContainer.classList.remove('d-none');
    }
}

// Navigation
function switchView(viewName) {
    Object.values(views).forEach(el => el.classList.add('d-none'));
    [navDashboard, navServer, navConfig].forEach(el => el.classList.remove('active'));

    views[viewName].classList.remove('d-none');
    
    if (viewName === 'dashboard') {
        navDashboard.classList.add('active');
        pageTitle.innerText = 'Dashboard';
        btnAddInstance.parentElement.classList.remove('d-none'); 
        stopStats();
    } else if (viewName === 'server') {
        navServer.classList.add('active');
        pageTitle.innerText = 'My Server';
        btnAddInstance.parentElement.classList.add('d-none');
        startStats();
    } else if (viewName === 'config') {
        navConfig.classList.add('active');
        pageTitle.innerText = 'Configuration';
        btnAddInstance.parentElement.classList.add('d-none');
        loadConfig();
        loadRestSettings();
        stopStats();
    }
}

navDashboard.onclick = () => switchView('dashboard');
navServer.onclick = () => switchView('server');
navConfig.onclick = () => switchView('config');

// --- Render Logic ---

function getFilteredInstances(instances) {
    if (!searchQuery) return instances;
    const q = searchQuery.toLowerCase();
    return instances.filter(inst =>
        (inst.name || '').toLowerCase().includes(q) ||
        (inst.notes || '').toLowerCase().includes(q) ||
        (inst.host || '').toLowerCase().includes(q) ||
        String(inst.port || '').includes(q) ||
        (inst.status || '').toLowerCase().includes(q)
    );
}

function renderFleetSummary(instances) {
    if (!fleetSummary) return;
    const running = instances.filter(i => i.status === 'running').length;
    const total = instances.length;
    const tabs = instances.reduce((sum, i) => sum + (typeof i.tab_count === 'number' ? i.tab_count : 0), 0);
    fleetSummary.innerText = `${running}/${total} running · ${tabs} tab${tabs === 1 ? '' : 's'}`;
}

// Human-readable bytes (e.g. 412 MB, 1.3 GB). Returns '—' for non-numbers.
function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// My Server page: live fleet overview (stat card + fleet table).
function renderServerFleet(instances) {
    const running = instances.filter(i => i.status === 'running');
    const totalTabs = instances.reduce((sum, i) => sum + (typeof i.tab_count === 'number' ? i.tab_count : 0), 0);

    const instStat = document.getElementById('stats-instances');
    if (instStat) instStat.innerText = `${running.length}/${instances.length}`;
    const tabsStat = document.getElementById('stats-total-tabs');
    if (tabsStat) tabsStat.innerText = totalTabs;

    const summary = document.getElementById('fleet-status-summary');
    if (summary) summary.innerText = `${running.length} running · ${instances.length - running.length} stopped`;

    const body = document.getElementById('fleet-status-body');
    if (!body) return;
    if (!instances.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-center text-theme-muted py-3">No instances configured.</td></tr>';
        return;
    }
    body.innerHTML = instances.map(inst => `
        <tr>
            <td><span class="status-indicator status-${inst.status}"></span> <span class="x-small text-uppercase">${inst.status}</span></td>
            <td class="fw-bold">${escapeHtml(inst.name)}</td>
            <td><span class="badge ${inst.type === 'local' ? 'bg-info' : 'bg-warning'} text-dark">${inst.type}</span></td>
            <td class="font-monospace x-small">${escapeHtml(inst.host)}:${inst.port}</td>
            <td class="x-small text-theme-muted">${escapeHtml(inst.launch_backend_label || inst.launch_mode_label || '—')}</td>
            <td class="x-small ${inst.status === 'running' ? 'uptime' : 'text-theme-muted'}" ${inst.status === 'running' && inst.started_at ? `data-started-at="${escapeHtml(inst.started_at)}"` : ''}>${inst.status === 'running' && inst.started_at ? `<i class="bi bi-clock-history"></i> ${formatUptimeFrom(inst.started_at)}` : '—'}</td>
            <td class="x-small">${inst.status === 'running' ? (typeof inst.tab_count === 'number' ? inst.tab_count : '…') : '—'}</td>
            <td class="x-small">${inst.status === 'running' ? (typeof inst.memory_bytes === 'number' ? formatBytes(inst.memory_bytes) : (inst.type === 'local' ? '…' : '—')) : '—'}</td>
        </tr>
    `).join('');
}

function renderInstanceMeta(inst) {
    if (inst.status !== 'running') return '';
    const uptime = inst.started_at
        ? `<span class="meta-chip uptime" data-started-at="${escapeHtml(inst.started_at)}" title="Running since ${escapeHtml(inst.started_at)}">
               <i class="bi bi-clock-history"></i> ${formatUptimeFrom(inst.started_at)}
           </span>`
        : '';
    const tabLabel = typeof inst.tab_count === 'number' ? inst.tab_count : '…';
    const tabs = `<span class="meta-chip" title="Open tabs"><i class="bi bi-window-stack"></i> ${tabLabel} tab${tabLabel === 1 ? '' : 's'}</span>`;
    return `<div class="d-flex flex-wrap gap-2 mb-3">${uptime}${tabs}</div>`;
}

function renderInstances(instances) {
    renderFleetSummary(instances);
    renderServerFleet(instances);
    const filtered = getFilteredInstances(instances);

    if (!filtered.length) {
        const emptyMsg = searchQuery
            ? `No instances match "${escapeHtml(searchQuery)}".`
            : 'No instances yet. Click "New Instance" to add one.';
        instancesList.innerHTML = `<div class="col-12"><div class="text-center text-theme-muted py-5">${emptyMsg}</div></div>`;
        instancesTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-theme-muted py-4">${emptyMsg}</td></tr>`;
        return;
    }

    // Grid Render
    instancesList.innerHTML = filtered.map(inst => {
        let interfaceList = '';
        if (inst.interfaces && inst.forward_port) {
            interfaceList = inst.interfaces.map(iface =>
                `<div class="text-info" style="font-size: 0.8rem;">${iface.address}:${inst.forward_port}</div>`
            ).join('');
        }

        return `
        <div class="col">
            <div class="card card-theme h-100">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <h5 class="card-title mb-0 fs-6 text-truncate cursor-pointer text-primary"
                        title="Click to Control"
                        onclick="openControl(${inst.id}, '${escapeAttr(inst.name)}')">
                        <i class="bi bi-browser-chrome me-1"></i> ${escapeHtml(inst.name)}
                    </h5>
                    <span class="badge ${inst.type === 'local' ? 'bg-info' : 'bg-warning'} text-dark">${inst.type}</span>
                </div>
                <div class="card-body">
                    <div class="d-flex align-items-center mb-3">
                        <span class="status-indicator status-${inst.status}"></span>
                        <span class="text-uppercase small fw-bold">${inst.status}</span>
                        <span class="ms-auto x-small text-theme-muted font-monospace user-select-all text-nowrap"
                              title="Use this id in the REST API, e.g. /rest/instances/${inst.id}/tabs">ID of instance: ${inst.id}</span>
                    </div>

                    ${renderInstanceMeta(inst)}

                    <div class="mb-3" title="${escapeHtml(inst.launch_reason || '')}">
                        <small class="text-theme-muted d-block fw-bold" style="font-size: 0.7rem;">MODE</small>
                        <div class="d-flex flex-wrap gap-2 mb-1">
                            ${renderLaunchFlags(inst)}
                        </div>
                        <span class="small text-theme-muted">${escapeHtml(inst.launch_backend_label || inst.launch_mode_label || 'Unknown')}</span>
                    </div>
                    
                    <div class="mb-2">
                        <small class="text-theme-muted d-block fw-bold" style="font-size: 0.7rem;">HOST</small>
                        <span class="font-monospace user-select-all">${inst.host}:${inst.port}</span>
                    </div>

                    ${inst.forward_port ? `
                    <div class="mb-2">
                        <small class="text-theme-muted d-block fw-bold" style="font-size: 0.7rem;">FORWARD</small>
                        ${interfaceList || `<span class="font-monospace">:${inst.forward_port}</span>`}
                    </div>` : ''}

                    ${inst.notes ? `
                    <div class="mt-3 p-2 bg-theme-surface rounded small text-theme-muted border-theme border-start border-4">
                        <i class="bi bi-sticky me-1"></i> ${escapeHtml(inst.notes)}
                    </div>` : ''}
                </div>
                <div class="card-footer d-flex flex-wrap gap-2 p-2">
                     ${getActions(inst)}
                </div>
            </div>
        </div>`;
    }).join('');

    // Table Render
    instancesTableBody.innerHTML = filtered.map(inst => `
        <tr>
            <td><span class="status-indicator status-${inst.status}"></span> ${inst.status}</td>
            <td class="font-monospace user-select-all">${inst.id}</td>
            <td>
                <div class="fw-bold cursor-pointer text-primary" onclick="openControl(${inst.id}, '${escapeAttr(inst.name)}')">${escapeHtml(inst.name)}</div>
                ${inst.notes ? `<div class="x-small text-theme-muted">${escapeHtml(inst.notes)}</div>` : ''}
            </td>
            <td><span class="badge ${inst.type === 'local' ? 'bg-info' : 'bg-warning'} text-dark">${inst.type}</span></td>
            <td>
                ${inst.status === 'running'
                    ? `<div class="x-small uptime" data-started-at="${escapeHtml(inst.started_at || '')}"><i class="bi bi-clock-history"></i> ${inst.started_at ? formatUptimeFrom(inst.started_at) : '—'}</div>
                       <div class="x-small text-theme-muted"><i class="bi bi-window-stack"></i> ${typeof inst.tab_count === 'number' ? inst.tab_count : '…'} tabs</div>`
                    : '<span class="x-small text-theme-muted">—</span>'}
            </td>
            <td title="${escapeHtml(inst.launch_reason || '')}">
                <div class="d-flex flex-wrap gap-1 mb-1">
                    ${renderLaunchFlags(inst)}
                </div>
                <div class="x-small text-theme-muted">${escapeHtml(inst.launch_backend_label || inst.launch_mode_label || 'Unknown')}</div>
            </td>
            <td class="font-monospace">${inst.host}:${inst.port}</td>
            <td class="font-monospace">${inst.forward_port || '-'}</td>
            <td>
                <div class="d-flex flex-wrap gap-2">
                    ${getActions(inst, true)}
                </div>
            </td>
        </tr>
    `).join('');
}

function renderLaunchFlags(inst) {
    return [
        getLaunchFlagBadge('GUI', inst.launch_mode === 'gui', inst.launch_mode === 'gui' ? 'warning text-dark' : 'secondary'),
        getLaunchFlagBadge('HEADLESS', Boolean(inst.headless_enabled), inst.headless_enabled ? 'success' : 'secondary'),
        getLaunchFlagBadge('XVFB', Boolean(inst.xvfb_enabled), inst.xvfb_enabled ? 'primary' : 'secondary')
    ].join('');
}

function getLaunchFlagBadge(label, enabled, variant) {
    return `<span class="badge bg-${variant}">${label} ${enabled ? 'ON' : 'OFF'}</span>`;
}

function getActions(inst, small = false) {
    const btnClass = small ? 'btn-sm btn-theme-secondary' : 'btn-sm flex-grow-1 btn-theme-secondary';
    const canImportCookies = inst.type === 'external' || inst.status === 'running';
    
    let startStopBtn = '';
    if (inst.status === 'stopped') {
        startStopBtn = `<button class="btn ${small ? 'btn-sm btn-success' : 'btn-sm flex-grow-1 btn-success'}" onclick="startInstance(${inst.id})"><i class="bi bi-play-fill"></i> ${small ? '' : 'Start'}</button>`;
    } else {
        startStopBtn = `<button class="btn ${small ? 'btn-sm btn-danger' : 'btn-sm flex-grow-1 btn-danger'}" onclick="stopInstance(${inst.id})"><i class="bi bi-stop-fill"></i> ${small ? '' : 'Stop'}</button>`;
    }

    return `
        ${startStopBtn}
        <button class="btn ${btnClass}" onclick="openControl(${inst.id}, '${inst.name}')" ${inst.status !== 'running' ? 'disabled' : ''}>
            <i class="bi bi-gear-fill"></i> ${small ? '' : 'Control'}
        </button>
        <button class="btn ${btnClass}" onclick="openLogs(${inst.id})">
            <i class="bi bi-journal-text"></i> ${small ? '' : 'Logs'}
        </button>
        <button class="btn ${btnClass}" onclick="openImportCookies(${inst.id})" title="Import Cookies" ${canImportCookies ? '' : 'disabled'}>
            <i class="bi bi-box-arrow-in-down"></i> ${small ? '' : 'Import Cookies'}
        </button>
        <button class="btn ${btnClass}" onclick="openEditInstance(${inst.id})" ${inst.status !== 'stopped' ? 'disabled' : ''}>
            <i class="bi bi-pencil-square"></i> ${small ? '' : 'Edit'}
        </button>
        <button class="btn ${small ? 'btn-sm btn-outline-danger' : 'btn-sm btn-outline-danger'}" onclick="deleteInstance(${inst.id})">
            <i class="bi bi-trash"></i>
        </button>
    `;
}

// --- Reusable confirmation modal -----------------------------------------
// Stopping an instance tears down a live browser and every tab in it, so it
// must never be one stray click away. Resolves true only if the user confirms;
// dismissing the modal any other way (Cancel, backdrop, Esc, the X) resolves
// false. Falls back to the native confirm() if Bootstrap or the markup is
// missing, so an action can never silently proceed unconfirmed.
let confirmModalInstance = null;
let confirmModalGeneration = 0;

// Bootstrap's hide() is a no-op while the show transition is still running, so
// a confirm click that lands inside that window would leave the dialog open
// *and* never resolve — a safety prompt that silently swallows the action.
// Retry briefly until the modal is actually gone; the generation token stops a
// stale retry from closing a dialog that has since been reopened.
function hideConfirmModal(generation, attempt = 0) {
    if (!confirmModalInstance || generation !== confirmModalGeneration) return;
    confirmModalInstance.hide();
    const el = document.getElementById('confirmModal');
    if (attempt < 20 && el && el.classList.contains('show')) {
        setTimeout(() => hideConfirmModal(generation, attempt + 1), 50);
    }
}

function confirmAction(options = {}) {
    const {
        title = 'Are you sure?',
        messageHtml = '',
        detailHtml = '',
        confirmLabel = 'Confirm',
        confirmClass = 'btn-danger',
        icon = 'bi-exclamation-triangle-fill text-warning',
    } = options;

    const el = document.getElementById('confirmModal');
    if (!el || typeof bootstrap === 'undefined') {
        const plain = String(messageHtml).replace(/<[^>]*>/g, '');
        return Promise.resolve(window.confirm(`${title}\n\n${plain}`));
    }

    document.getElementById('confirmModalTitle').innerText = title;
    document.getElementById('confirmModalMessage').innerHTML = messageHtml;
    document.getElementById('confirmModalIcon').className = `bi ${icon} me-2`;

    const detail = document.getElementById('confirmModalDetail');
    detail.innerHTML = detailHtml;
    detail.classList.toggle('d-none', !detailHtml);

    const btn = document.getElementById('confirmModalConfirmBtn');
    btn.className = `btn ${confirmClass} px-4`;
    btn.innerText = confirmLabel;

    if (!confirmModalInstance) confirmModalInstance = new bootstrap.Modal(el);
    const generation = ++confirmModalGeneration;

    return new Promise((resolve) => {
        let settled = false;
        // Resolve on the click itself rather than on hidden.bs.modal: the
        // outcome must not depend on the dialog finishing its animation.
        const finish = (value) => {
            if (settled) return;
            settled = true;
            btn.removeEventListener('click', onConfirm);
            el.removeEventListener('hidden.bs.modal', onDismiss);
            resolve(value);
        };
        const onConfirm = () => { finish(true); hideConfirmModal(generation); };
        const onDismiss = () => finish(false);

        btn.addEventListener('click', onConfirm);
        el.addEventListener('hidden.bs.modal', onDismiss);
        confirmModalInstance.show();
    });
}

// Render label/value pairs into the modal's detail panel.
function confirmDetailRows(rows) {
    return rows
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => `
            <div class="d-flex justify-content-between gap-3 py-1">
                <span class="text-theme-muted">${escapeHtml(label)}</span>
                <span class="fw-bold text-end">${escapeHtml(value)}</span>
            </div>`)
        .join('');
}

// --- Instance Actions ---
async function startInstance(id) {
    try {
        await fetchJsonOrThrow(`/api/instances/${id}/start`, { method: 'POST' });
    } catch (e) {
        alert('Failed to start instance: ' + (e.message || 'Unknown error'));
    }
}
async function stopInstance(id) {
    // Read the instance fresh rather than trusting the cached list: tab_count
    // and memory_bytes are filled in by the periodic sync, so a card opened
    // shortly after start would show the dialog without the very numbers that
    // make it worth reading. Fall back to the cache if the request fails.
    let inst = null;
    try { inst = await fetchAPI(`/api/instances/${id}`); } catch { /* fall back below */ }
    if (!inst || !inst.id) inst = allInstances.find(item => item.id === id) || null;

    const name = inst ? inst.name : `#${id}`;
    const tabs = inst && typeof inst.tab_count === 'number' ? inst.tab_count : null;

    const confirmed = await confirmAction({
        title: 'Stop instance?',
        messageHtml: `<b>${escapeHtml(name)}</b> will be shut down. Chrome and every tab it has open are closed.`
            + ' The profile on disk is kept, but anything in flight — uploads, unsaved form input — is lost.',
        detailHtml: confirmDetailRows([
            ['Endpoint', inst ? `${inst.host}:${inst.port}` : null],
            ['Mode', inst ? (inst.launch_mode_label || inst.launch_mode) : null],
            ['Open tabs', tabs === null ? null : `${tabs} tab${tabs === 1 ? '' : 's'} will be closed`],
            ['Memory', inst && typeof inst.memory_bytes === 'number' ? formatBytes(inst.memory_bytes) : null],
            ['Uptime', inst && inst.started_at ? formatUptimeFrom(inst.started_at) : null],
        ]),
        confirmLabel: 'Stop instance',
    });
    if (!confirmed) return;

    try {
        await fetchJsonOrThrow(`/api/instances/${id}/stop`, { method: 'POST' });
    } catch (e) {
        alert('Failed to stop instance: ' + (e.message || 'Unknown error'));
    }
}
async function deleteInstance(id) { if (confirm('Delete this instance?')) await fetchAPI(`/api/instances/${id}`, 'DELETE'); }

// --- Search & Bulk Actions ---
if (instanceSearch) {
    instanceSearch.addEventListener('input', () => {
        searchQuery = instanceSearch.value.trim();
        renderInstances(allInstances);
    });
}

async function bulkAction(targets, action, label, btn) {
    if (!targets.length) return;
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${label}...`; }
    try {
        // Sequential to avoid hammering the host / port-allocation races on start.
        for (const inst of targets) {
            try { await fetchAPI(`/api/instances/${inst.id}/${action}`, 'POST'); }
            catch (e) { console.error(`Failed to ${action} ${inst.name}:`, e); }
        }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

if (btnStartAll) {
    btnStartAll.addEventListener('click', () => {
        const targets = getFilteredInstances(allInstances).filter(i => i.status === 'stopped');
        if (!targets.length) { alert('No stopped instances to start.'); return; }
        bulkAction(targets, 'start', 'Starting', btnStartAll);
    });
}

if (btnStopAll) {
    btnStopAll.addEventListener('click', async () => {
        // Same reason as stopInstance: one fresh list so the tab total shown is
        // the real one. /api/instances is a single request for the whole fleet.
        let fleet = allInstances;
        try {
            const fresh = await fetchAPI('/api/instances');
            if (Array.isArray(fresh) && fresh.length) fleet = fresh;
        } catch { /* fall back to the cached list */ }

        const targets = getFilteredInstances(fleet).filter(i => i.status !== 'stopped');
        if (!targets.length) { alert('No running instances to stop.'); return; }

        const totalTabs = targets.reduce((sum, i) => sum + (typeof i.tab_count === 'number' ? i.tab_count : 0), 0);
        // Name every instance that is about to go down — "Stop all" acts on the
        // current search filter, so the set is not always what's on screen.
        const list = targets.map(i => `
            <div class="d-flex justify-content-between gap-3 py-1">
                <span class="fw-bold">${escapeHtml(i.name)}</span>
                <span class="text-theme-muted">${escapeHtml(`${i.host}:${i.port}`)}</span>
            </div>`).join('');

        const confirmed = await confirmAction({
            title: `Stop ${targets.length} instance${targets.length === 1 ? '' : 's'}?`,
            messageHtml: `Every instance listed below is shut down, closing <b>${totalTabs}</b> open tab${totalTabs === 1 ? '' : 's'} in total.`,
            detailHtml: list,
            confirmLabel: `Stop ${targets.length} instance${targets.length === 1 ? '' : 's'}`,
        });
        if (!confirmed) return;

        bulkAction(targets, 'stop', 'Stopping', btnStopAll);
    });
}

function openEditInstance(id) {
    const inst = allInstances.find(item => item.id === id);
    if (!inst) {
        alert('Instance not found');
        return;
    }
    currentEditInstanceId = id;
    editInstanceName.value = inst.name || '';
    editLaunchMode.value = inst.launch_mode && inst.launch_mode !== 'external' ? inst.launch_mode : 'chrome_headless';
    editLaunchModeGroup.style.display = inst.type === 'local' ? 'block' : 'none';
    editLaunchMode.disabled = inst.type !== 'local';
    editInstanceNotes.value = inst.notes || '';
    editInstanceModal.show();
}

function openImportCookies(id) {
    const inst = allInstances.find(item => item.id === id);
    if (!inst) {
        alert('Instance not found');
        return;
    }

    currentImportInstanceId = id;
    importCookiesForm.reset();
    importCookiesInstanceName.value = inst.name || '';
    setImportCookiesResult('', 'secondary', true);
    renderImportCookieFiles([]);
    importCookiesModal.show();
}

editInstanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentEditInstanceId) return;

    const payload = {
        name: editInstanceName.value.trim(),
        notes: editInstanceNotes.value.trim()
    };
    const inst = allInstances.find(item => item.id === currentEditInstanceId);
    if (inst?.type === 'local') {
        payload.launch_mode = editLaunchMode.value;
    }

    const res = await fetch(`/api/instances/${currentEditInstanceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('Error: ' + (err.error || 'Failed to update instance'));
        return;
    }

    editInstanceModal.hide();
    currentEditInstanceId = null;
});

importCookiesModalEl.addEventListener('hidden.bs.modal', () => {
    currentImportInstanceId = null;
    importCookiesForm.reset();
    setImportCookiesResult('', 'secondary', true);
    renderImportCookieFiles([]);
    setImportSubmitState(false);
});

importCookiesFilesInput.addEventListener('change', () => {
    renderImportCookieFiles(Array.from(importCookiesFilesInput.files || []));
});

importCookiesForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentImportInstanceId) {
        alert('Instance not selected');
        return;
    }

    const files = Array.from(importCookiesFilesInput.files || []);
    if (!files.length) {
        setImportCookiesResult('Select at least one cookie file.', 'danger');
        return;
    }

    setImportSubmitState(true);
    setImportCookiesResult('', 'secondary', true);

    try {
        const payloadFiles = await Promise.all(files.map(readFileAsText));
        const result = await fetchJsonOrThrow(`/api/instances/${currentImportInstanceId}/cookies/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: payloadFiles })
        });

        const summary = formatCookieImportSummary(result);
        setImportCookiesResult(summary, result.failed || result.file_errors?.length ? 'warning' : 'success');
        alert(summary);
        importCookiesModal.hide();
    } catch (error) {
        setImportCookiesResult(error.message || 'Failed to import cookies.', 'danger');
    } finally {
        setImportSubmitState(false);
    }
});

addInstanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(addInstanceForm);
    const data = Object.fromEntries(formData.entries());
    data.use_socat = formData.get('use_socat') === 'on';
        const res = await fetch('/api/instances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    
        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addInstanceModal')).hide();
            addInstanceForm.reset();
            launchMode.value = serverCaps.xvfb_supported ? 'xvfb' : 'chrome_headless';
            applyCapabilities();
            syncInstanceTypeOptions();
        } else {
            const err = await res.json();
            alert('Error: ' + (err.error || 'Failed to save instance'));
        }
    });
    

[useSocat, inputDebugPort].forEach(el => { el.addEventListener('change', updateForwardPort); el.addEventListener('input', updateForwardPort); });
function updateForwardPort() { if (useSocat.checked) { const debugPort = parseInt(inputDebugPort.value) || 0; if (debugPort > 0) inputForwardPort.value = debugPort + 1; } }

function syncInstanceTypeOptions() {
    const isLocal = instanceType.value === 'local';
    localOptionsInputs.style.display = isLocal ? 'block' : 'none';
    localOptionsCheckboxes.style.display = isLocal ? 'block' : 'none';

    localOptionsInputs.querySelectorAll('input, textarea, select').forEach((el) => {
        el.disabled = !isLocal;
    });
    localOptionsCheckboxes.querySelectorAll('input, textarea, select').forEach((el) => {
        el.disabled = !isLocal;
    });
}

instanceType.addEventListener('change', syncInstanceTypeOptions);
syncInstanceTypeOptions();

// --- Logs ---
async function openLogs(id) { currentLogInstanceId = id; logContent.innerText = 'Loading...'; logModal.show(); refreshInstanceLogs(); }
async function refreshInstanceLogs() { if (!currentLogInstanceId) return; const res = await fetchAPI(`/api/instances/${currentLogInstanceId}/logs`); logContent.innerText = res.logs || 'No logs found.'; logContent.scrollTop = logContent.scrollHeight; }

// Emptying the logs loses the record of why an instance did what it did, and
// there is no undo, so it asks first.
async function clearInstanceLogs() {
    if (!currentLogInstanceId) return;
    const inst = allInstances.find(item => item.id === currentLogInstanceId);
    const confirmed = await confirmAction({
        title: 'Clear logs?',
        messageHtml: `Both log files for <b>${escapeHtml(inst ? inst.name : `#${currentLogInstanceId}`)}</b> are emptied:`
            + ' the manager log that records why it launched and stopped, and Chrome\'s own log.'
            + ' The instance keeps running and starts writing fresh lines straight away.',
        confirmLabel: 'Clear logs',
        icon: 'bi-trash text-danger',
    });
    if (!confirmed) return;

    try {
        const res = await fetchJsonOrThrow(`/api/instances/${currentLogInstanceId}/logs`, { method: 'DELETE' });
        const freed = (res?.cleared || []).reduce((sum, c) => sum + (c.freed_bytes || 0), 0);
        await refreshInstanceLogs();
        logContent.innerText = `Cleared ${formatBytes(freed)} of logs.\n\n` + logContent.innerText;
    } catch (e) {
        alert(`Could not clear the logs: ${e.message}`);
    }
}

// --- Control Logic ---
let currentTabs = [];
let streamToken = 0;     // increments to cancel an in-flight streaming loop
let dragButton = 'left'; // button held during a drag
let lastMoveSent = 0;    // throttle timestamp for drag mousemove

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openControl(id, name) {
    currentInstanceId = id;
    document.getElementById('controlModalTitle').innerText = `Control: ${name}`;
    resetControlView();
    controlModalOpen = true;
    controlModal.show();
    lastTabsSignature = '';
    await loadTabs();
    startTabPoll();
    // Auto-select the first tab so the operator lands on a live view.
    if (!currentTabId && currentTabs.length) selectTab(currentTabs[0].id);
}

function resetControlView() {
    lastCaptureScale = 1;
    stopStream();
    currentTabId = null;
    currentTabs = [];
    tabContent.classList.add('d-none');
    noTabSelected.classList.remove('d-none');
    tabScreenshot.removeAttribute('src');
    if (currentTabObjectUrl) { URL.revokeObjectURL(currentTabObjectUrl); currentTabObjectUrl = null; }
    screenWrapper.classList.remove('has-focus');
    setStreamStatus('idle');
}

controlModalEl.addEventListener('hidden.bs.modal', () => {
    controlModalOpen = false;
    currentInstanceId = null;
    stopTabPoll();
    resetControlView();
});

// Re-rendering the list on every poll would flicker and drop hover state, so
// the markup is only rebuilt when something a viewer can actually see changed.
let lastTabsSignature = '';

async function loadTabs() {
    if (!currentInstanceId) return;
    const tabs = await fetchAPI(`/api/instances/${currentInstanceId}/tabs`);
    currentTabs = Array.isArray(tabs) ? tabs.filter(t => t.type === 'page' || t.type === undefined) : [];
    tabCountBadge.innerText = currentTabs.length;

    const signature = `${currentTabId}::` + currentTabs.map(t => `${t.id}|${t.title}|${t.url}|${t.favIconUrl || ''}`).join('~');
    if (signature === lastTabsSignature) {
        syncAddressBar();
        return;
    }
    lastTabsSignature = signature;

    tabList.innerHTML = currentTabs.map(tab => `
        <button type="button" class="list-group-item list-group-item-action tab-list-item d-flex align-items-center gap-2 ${currentTabId === tab.id ? 'active' : ''}"
                data-tab-id="${escapeAttr(tab.id)}">
            ${tab.favIconUrl ? `<img src="${escapeAttr(tab.favIconUrl)}" width="16" height="16" onerror="this.style.display='none'">` : '<i class="bi bi-window"></i>'}
            <div class="overflow-hidden w-100">
                <div class="text-truncate small fw-bold">${escapeHtml(tab.title || 'No Title')}</div>
                <div class="text-truncate x-small opacity-75" style="font-size: 0.7rem;">${escapeHtml(tab.url)}</div>
            </div>
            <span class="tab-inspect px-1" role="button" tabindex="-1" title="Inspect loaded HTML"
                  data-inspect-tab-id="${escapeAttr(tab.id)}"><i class="bi bi-code-slash"></i></span>
        </button>
    `).join('');

    syncAddressBar();

    // If the previously controlled tab is gone, drop back to the empty state.
    if (currentTabId && !currentTabs.some(t => t.id === currentTabId)) {
        stopStream();
        currentTabId = null;
        tabContent.classList.add('d-none');
        noTabSelected.classList.remove('d-none');
        tabScreenshot.removeAttribute('src');
        setStreamStatus('idle');
    }
}

// The page can move on its own — a link click sent through the live view, a
// redirect, a back/forward — so the address bar follows the tab's real URL.
// Never while the operator is typing in it, or their half-typed URL vanishes.
function syncAddressBar() {
    const active = currentTabs.find(t => t.id === currentTabId);
    if (!active) return;
    if (document.activeElement === activeTabUrl) return;
    if (activeTabUrl.value !== (active.url || '')) activeTabUrl.value = active.url || '';
}

// Keep titles, URLs and the tab set fresh while the control view is open.
let tabPollTimer = null;
function startTabPoll() {
    stopTabPoll();
    tabPollTimer = setInterval(() => { if (controlModalOpen) loadTabs(); }, 3000);
}
function stopTabPoll() {
    if (tabPollTimer) clearInterval(tabPollTimer);
    tabPollTimer = null;
}

tabList.addEventListener('click', (e) => {
    // The inspect affordance lives inside the tab button, so it has to be
    // checked first or the row's own click handler swallows it.
    const inspect = e.target.closest('[data-inspect-tab-id]');
    if (inspect) {
        e.preventDefault();
        e.stopPropagation();
        openHtmlInspector(inspect.getAttribute('data-inspect-tab-id'));
        return;
    }
    const btn = e.target.closest('[data-tab-id]');
    if (btn) selectTab(btn.getAttribute('data-tab-id'));
});

function selectTab(id) {
    const tab = currentTabs.find(t => t.id === id);
    if (!tab) return;
    const switching = currentTabId !== id;

    // Cancel any streaming bound to the previous tab BEFORE switching ids, then
    // clear the stale frame so we never show the old tab's screenshot.
    stopStream();
    if (switching) {
        tabScreenshot.removeAttribute('src');
        if (currentTabObjectUrl) { URL.revokeObjectURL(currentTabObjectUrl); currentTabObjectUrl = null; }
    }

    currentTabId = id;
    tabContent.classList.remove('d-none');
    noTabSelected.classList.add('d-none');
    activeTabUrl.value = tab.url || '';
    tabList.querySelectorAll('[data-tab-id]').forEach(el =>
        el.classList.toggle('active', el.getAttribute('data-tab-id') === id));

    // Bring the target tab to the foreground (best effort) then start the view.
    fetchAPI(`/api/instances/${currentInstanceId}/tabs/${id}/activate`, 'POST').catch(() => {});
    if (liveEnabled) startStream();
    else { setStreamStatus('paused'); grabAndSwap(); }
    screenWrapper.focus();
}

// --- Streaming (flicker-free double-buffered frames) ---
function setStreamStatus(state, latencyMs) {
    if (!streamStatusDot) return;
    const map = {
        idle:    { cls: 'status-stopped',  text: 'Idle' },
        loading: { cls: 'status-partial',  text: 'Connecting…' },
        live:    { cls: 'streaming',       text: 'Streaming' },
        paused:  { cls: 'status-partial',  text: 'Paused (manual)' },
        error:   { cls: 'status-stopped',  text: 'Reconnecting…' },
    };
    const s = map[state] || map.idle;
    streamStatusDot.className = `status-indicator ${s.cls}`;
    streamStatusText.innerText = s.text;
    streamLatency.innerText = (state === 'live' && typeof latencyMs === 'number') ? `${latencyMs} ms` : '—';
}

// The scale the server actually applied to the frame on screen, reported back
// in X-Capture-Scale. Everything that converts between the image and the page
// needs it: at scale 0.45 the image is 864 px wide while the page is still
// 1920, so a click read straight off the image lands less than half way across.
let lastCaptureScale = 1;

// Width of the page's viewport in CSS pixels, recovered from the frame we are
// showing. Deriving it from naturalWidth alone is what made the old version
// oscillate: naturalWidth is itself the *result* of the scale, so asking for a
// smaller frame made the next computation ask for a bigger one, and the live
// view flipped between two resolutions on every single frame.
function viewportWidthFromFrame() {
    const natural = tabScreenshot.naturalWidth;
    if (!natural) return 0;
    return natural / (lastCaptureScale || 1);
}

// Capture resolution to ask for. "Auto" requests exactly what the panel will
// display: the image is scaled to fit anyway, so anything sharper is pixels
// Chrome reads back and the browser immediately throws away.
function currentCaptureScale() {
    const choice = liveScale ? liveScale.value : 'auto';
    if (choice !== 'auto') return Number(choice);
    const shown = tabScreenshot.clientWidth;
    const viewport = viewportWidthFromFrame();
    if (!shown || !viewport) return 1;
    // Round up to a 0.05 step so small panel resizes do not churn the value and
    // defeat the server's frame sharing.
    return Math.min(1, Math.max(0.25, Math.ceil((shown / viewport) * 20) / 20));
}

async function grabAndSwap() {
    if (!currentInstanceId || !currentTabId) return false;
    // Remember which tab this frame belongs to so a late-arriving frame from a
    // previously selected tab can never overwrite the current view.
    const reqInstance = currentInstanceId;
    const reqTab = currentTabId;
    const t0 = performance.now();
    try {
        const res = await fetch(`/api/instances/${reqInstance}/tabs/${reqTab}/screenshot?scale=${currentCaptureScale()}&t=${Date.now()}`);
        if (res.status === 401) { window.location.reload(); return false; }
        if (!res.ok) throw new Error(`screenshot ${res.status}`);
        // Recorded before the image is swapped in, so coordinate mapping and
        // the next scale decision both describe the frame actually on screen.
        const appliedScale = parseFloat(res.headers.get('X-Capture-Scale'));
        if (Number.isFinite(appliedScale) && appliedScale > 0) lastCaptureScale = appliedScale;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                if (reqInstance !== currentInstanceId || reqTab !== currentTabId) {
                    URL.revokeObjectURL(url); // stale: tab changed while decoding
                    resolve();
                    return;
                }
                tabScreenshot.src = url;
                if (currentTabObjectUrl) URL.revokeObjectURL(currentTabObjectUrl);
                currentTabObjectUrl = url;
                resolve();
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
            img.src = url;
        });
        if (liveEnabled && streamLoopActive) setStreamStatus('live', Math.round(performance.now() - t0));
        return true;
    } catch (e) {
        if (streamLoopActive) setStreamStatus('error');
        return false;
    }
}

function startStream() {
    if (!liveEnabled || !currentTabId || !controlModalOpen) return;
    if (streamLoopActive) return;
    streamLoopActive = true;
    const token = ++streamToken;
    setStreamStatus('loading');
    (async () => {
        let fails = 0;
        while (controlModalOpen && liveEnabled && currentTabId && token === streamToken) {
            const frameStart = performance.now();
            const ok = await grabAndSwap();
            if (ok) {
                fails = 0;
            } else {
                fails += 1;
                // After a few consecutive failures, resync the tab list: the tab
                // may have been closed or its target swapped while controlling it.
                // loadTabs() drops currentTabId if it's gone, which ends this loop.
                if (fails >= 3 && token === streamToken) {
                    fails = 0;
                    await loadTabs();
                }
            }
            // The selector is a target frame *rate*, so the wait is whatever is
            // left of the frame's budget after the capture, not a flat delay
            // added on top of it. Treating it as a flat delay is why "10 fps"
            // used to deliver about 6: a ~70 ms capture plus a 100 ms sleep.
            const target = parseInt(liveFps.value, 10);
            const budget = Number.isFinite(target) && target > 0 ? 1000 / target : 0;
            const elapsed = performance.now() - frameStart;
            const wait = ok ? Math.max(0, budget - elapsed) : Math.max(budget, 1000);
            await sleep(wait); // back off on error
        }
        streamLoopActive = false;
    })();
}

function stopStream() {
    streamToken++;          // any running loop sees a token mismatch and exits
    streamLoopActive = false;
}

// Single refresh used by the manual refresh button.
function refreshScreenshot() { grabAndSwap(); }

// When not live-streaming, pull a fresh frame shortly after an interaction.
let nudgeTimer = null;
function nudge(delay = 150) {
    if (liveEnabled) return; // live loop already refreshes
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(grabAndSwap, delay);
}

// Live toggle + FPS controls
btnLiveToggle.addEventListener('click', () => {
    liveEnabled = !liveEnabled;
    btnLiveToggle.classList.toggle('active', liveEnabled);
    btnLiveToggle.classList.toggle('btn-success', liveEnabled);
    btnLiveToggle.classList.toggle('btn-outline-secondary', !liveEnabled);
    liveToggleLabel.innerText = liveEnabled ? 'Live' : 'Paused';
    if (liveEnabled) startStream();
    else { stopStream(); setStreamStatus('paused'); }
});

// --- Navigation / tab buttons ---
function ensureProtocol(url) { return url.match(/^[a-zA-Z]+:\/\//) ? url : 'https://' + url; }

document.getElementById('btnGo').addEventListener('click', async () => {
    if (!currentTabId) return;
    let url = ensureProtocol(activeTabUrl.value.trim());
    activeTabUrl.value = url;
    await fetchAPI(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/navigate`, 'POST', { url });
    nudge(800);
});
activeTabUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btnGo').click(); } });

document.getElementById('btnNewTab').addEventListener('click', async () => {
    const input = document.getElementById('newTabUrl');
    let url = input.value.trim();
    url = url ? ensureProtocol(url) : 'about:blank';
    const tab = await fetchAPI(`/api/instances/${currentInstanceId}/tabs/new`, 'POST', { url });
    input.value = '';
    await loadTabs();
    if (tab && tab.id) selectTab(tab.id);
});

document.getElementById('btnCloseTab').addEventListener('click', async () => {
    if (!currentTabId) return;
    if (!confirm('Close tab?')) return;
    const closingId = currentTabId;
    stopStream();
    currentTabId = null;
    tabContent.classList.add('d-none');
    noTabSelected.classList.remove('d-none');
    tabScreenshot.removeAttribute('src');
    setStreamStatus('idle');
    // The server refuses to leave the browser with zero tabs — closing the last
    // one kills the instance in gui/xvfb mode — so it hands back the blank tab
    // it opened in its place. Focus that instead of falling back to tab 0.
    const res = await fetchAPI(`/api/instances/${currentInstanceId}/tabs/${closingId}`, 'DELETE');
    await loadTabs();
    const replacementId = res && res.replacement && res.replacement.id;
    if (replacementId && currentTabs.some(t => t.id === replacementId)) selectTab(replacementId);
    else if (currentTabs.length) selectTab(currentTabs[0].id);
});

// --- Tab navigation (back / forward / reload) ---
async function tabAction(path, options, failureMessage) {
    if (!currentInstanceId || !currentTabId) return;
    try {
        await fetchJsonOrThrow(`/api/instances/${currentInstanceId}/tabs/${currentTabId}${path}`, {
            method: 'POST',
            ...options,
        });
        nudge(900);
        setTimeout(loadTabs, 1200); // let the new document settle, then refresh titles/URLs
    } catch (e) {
        // "nothing to go back to" is a normal outcome, not an error worth a dialog.
        if (e.message && /No (back|forward) entry/.test(e.message)) return;
        alert(`${failureMessage}: ${e.message}`);
    }
}

document.getElementById('btnTabBack').addEventListener('click', () => tabAction('/history/back', {}, 'Back failed'));
document.getElementById('btnTabForward').addEventListener('click', () => tabAction('/history/forward', {}, 'Forward failed'));
document.getElementById('btnTabReload').addEventListener('click', (e) => tabAction('/reload', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignore_cache: e.shiftKey }),
}, 'Reload failed'));

// --- Loaded HTML inspector ---
// Shows the DOM as the browser currently holds it — after scripts have run —
// which is what you actually want to look at, and is not what re-fetching the
// URL would give you.
let htmlModalInstance = null;
let htmlInspectorTabId = null;
let htmlInspectorSource = '';
// Rendering an enormous document into a <pre> locks the tab up, so the preview
// is capped; Download and Copy still hand over the whole thing.
const HTML_PREVIEW_LIMIT = 400000;

const htmlModalUrl = document.getElementById('htmlModalUrl');
const htmlModalMeta = document.getElementById('htmlModalMeta');
const htmlModalBody = document.getElementById('htmlModalBody');
const htmlModalNotice = document.getElementById('htmlModalNotice');

async function loadHtmlInspector(tabId) {
    htmlInspectorTabId = tabId;
    htmlInspectorSource = '';
    htmlModalBody.textContent = 'Loading…';
    htmlModalNotice.classList.add('d-none');
    htmlModalMeta.innerText = '—';

    try {
        const dump = await fetchJsonOrThrow(`/api/instances/${currentInstanceId}/tabs/${tabId}/html`);
        if (!dump) return;
        htmlInspectorSource = dump.html || '';
        htmlModalUrl.innerText = dump.url || '';
        htmlModalUrl.title = dump.url || '';
        htmlModalMeta.innerText = `${formatBytes(dump.html_bytes)} · readyState: ${dump.ready_state}`;

        if (htmlInspectorSource.length > HTML_PREVIEW_LIMIT) {
            htmlModalNotice.innerText = `Document is ${formatBytes(dump.html_bytes)}; showing the first ${formatBytes(HTML_PREVIEW_LIMIT)}. Download or Copy gives you all of it.`;
            htmlModalNotice.classList.remove('d-none');
        }
        htmlModalBody.textContent = htmlInspectorSource.slice(0, HTML_PREVIEW_LIMIT);
    } catch (e) {
        htmlModalBody.textContent = `Could not read the document: ${e.message}`;
    }
}

function openHtmlInspector(tabId) {
    if (!currentInstanceId || !tabId) return;
    if (!htmlModalInstance) htmlModalInstance = new bootstrap.Modal(document.getElementById('htmlModal'));
    htmlModalInstance.show();
    loadHtmlInspector(tabId);
}

document.getElementById('btnInspectHtml').addEventListener('click', () => openHtmlInspector(currentTabId));
document.getElementById('btnHtmlRefresh').addEventListener('click', () => {
    if (htmlInspectorTabId) loadHtmlInspector(htmlInspectorTabId);
});

document.getElementById('btnHtmlCopy').addEventListener('click', async () => {
    if (!htmlInspectorSource) return;
    try {
        await navigator.clipboard.writeText(htmlInspectorSource);
        htmlModalNotice.className = 'alert alert-success rounded-0 mb-0 small';
        htmlModalNotice.innerText = 'Full HTML copied to clipboard.';
        htmlModalNotice.classList.remove('d-none');
    } catch {
        // Clipboard needs a secure context; plain HTTP on a LAN address has none.
        htmlModalNotice.className = 'alert alert-warning rounded-0 mb-0 small';
        htmlModalNotice.innerText = 'Clipboard is blocked by the browser here — use Download instead.';
        htmlModalNotice.classList.remove('d-none');
    }
});

document.getElementById('btnHtmlDownload').addEventListener('click', () => {
    if (!htmlInspectorSource) return;
    const blob = new Blob([htmlInspectorSource], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    let name = 'page';
    try { name = new URL(htmlModalUrl.innerText).hostname || 'page'; } catch { /* keep default */ }
    a.download = `${name}-${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

// --- Input helpers ---
function postInput(type, params) {
    if (!currentInstanceId || !currentTabId) return Promise.resolve();
    return fetchAPI(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/input`, 'POST', { type, params })
        .catch(() => {});
}
const sendMouse = (params) => postInput('mouse', params);
const sendKey = (params) => postInput('key', params);
const sendText = (text) => postInput('text', { text });

// Screen position -> page coordinates in CSS pixels, which is what CDP input
// and DOM.getNodeForLocation expect. Two conversions are involved: the panel
// scales the image to fit, and the image may itself be a downscaled capture.
// Dividing by lastCaptureScale undoes the second one; without it every click,
// drag, scroll and inspect landed short by exactly that factor.
function toCanvasCoords(e) {
    const rect = tabScreenshot.getBoundingClientRect();
    if (!tabScreenshot.naturalWidth || !rect.width) return null;
    const capture = lastCaptureScale || 1;
    const scaleX = tabScreenshot.naturalWidth / capture / rect.width;
    const scaleY = tabScreenshot.naturalHeight / capture / rect.height;
    return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
    };
}
function buttonName(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }
function buttonMask(b) { return b === 2 ? 2 : b === 1 ? 4 : 1; }

// Mouse: press / drag / release for clicks, text selection and dragging.
tabScreenshot.addEventListener('mousedown', (e) => {
    const c = toCanvasCoords(e);
    if (!c) return;
    e.preventDefault();
    screenWrapper.focus();
    dragging = true;
    dragButton = buttonName(e.button);
    sendMouse({ type: 'mousePressed', x: c.x, y: c.y, button: dragButton, buttons: buttonMask(e.button), clickCount: 1 });
});

window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    if (now - lastMoveSent < 33) return; // ~30 moves/sec max
    lastMoveSent = now;
    const c = toCanvasCoords(e);
    if (!c) return;
    sendMouse({ type: 'mouseMoved', x: c.x, y: c.y, button: dragButton, buttons: buttonMask(dragButton === 'right' ? 2 : dragButton === 'middle' ? 1 : 0) });
});

window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const c = toCanvasCoords(e);
    if (!c) return;
    sendMouse({ type: 'mouseReleased', x: c.x, y: c.y, button: dragButton, buttons: 0, clickCount: 1 });
    nudge(120);
});

// --- Right-click menu over the live page ---------------------------------
// Chrome's own context menu is drawn by the browser, not the renderer, so it
// never appears in Page.captureScreenshot: forwarding the right-click alone
// would look like nothing happened. The dashboard draws its own menu instead
// and backs the entries with CDP. Sites that implement their own in-page menu
// still work, via "Send right-click to page".
const pageContextMenu = document.getElementById('pageContextMenu');
let contextPoint = null;
let inspectedNode = null;
let inspectModalInstance = null;

function closeContextMenu() {
    pageContextMenu.classList.add('d-none');
    pageContextMenu.innerHTML = '';
}

function contextItem(label, icon, onClick, options = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<i class="bi ${icon}"></i><span>${escapeHtml(label)}</span>`;
    if (options.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeContextMenu(); onClick(); });
    return b;
}

function openContextMenu(clientX, clientY, canvas) {
    contextPoint = canvas;
    pageContextMenu.innerHTML = '';

    pageContextMenu.append(contextItem('Inspect element', 'bi-bullseye', () => inspectAtPoint(canvas)));
    pageContextMenu.append(contextItem('Copy element selector', 'bi-code-slash', () => copySelectorAtPoint(canvas)));
    pageContextMenu.append(contextItem('Clear highlight', 'bi-eraser', clearHighlight));

    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    pageContextMenu.append(sep);

    pageContextMenu.append(contextItem('Back', 'bi-arrow-left', () => tabAction('/history/back', {}, 'Back failed')));
    pageContextMenu.append(contextItem('Forward', 'bi-arrow-right', () => tabAction('/history/forward', {}, 'Forward failed')));
    pageContextMenu.append(contextItem('Reload', 'bi-arrow-clockwise', () => tabAction('/reload', {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ignore_cache: false }),
    }, 'Reload failed')));

    const sep2 = document.createElement('div');
    sep2.className = 'ctx-sep';
    pageContextMenu.append(sep2);

    pageContextMenu.append(contextItem('View loaded HTML', 'bi-filetype-html', () => openHtmlInspector(currentTabId)));
    pageContextMenu.append(contextItem('Send right-click to page', 'bi-mouse2', () => {
        // For sites that render their own context menu in the document; that
        // one does show up in the screenshot.
        sendMouse({ type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'right', buttons: 2, clickCount: 1 });
        sendMouse({ type: 'mouseReleased', x: canvas.x, y: canvas.y, button: 'right', buttons: 0, clickCount: 1 });
        nudge(250);
    }));

    const hint = document.createElement('div');
    hint.className = 'ctx-hint';
    hint.textContent = `at ${canvas.x}, ${canvas.y}`;
    pageContextMenu.append(hint);

    // Position within the scroll container, flipping near the right/bottom edge
    // so the menu never spills outside the view.
    const wrap = screenWrapper.getBoundingClientRect();
    pageContextMenu.classList.remove('d-none');
    const mw = pageContextMenu.offsetWidth;
    const mh = pageContextMenu.offsetHeight;
    let left = clientX - wrap.left + screenWrapper.scrollLeft;
    let top = clientY - wrap.top + screenWrapper.scrollTop;
    if (left + mw > screenWrapper.scrollLeft + wrap.width) left = Math.max(0, left - mw);
    if (top + mh > screenWrapper.scrollTop + wrap.height) top = Math.max(0, top - mh);
    pageContextMenu.style.left = `${left}px`;
    pageContextMenu.style.top = `${top}px`;
}

tabScreenshot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const c = toCanvasCoords(e);
    if (!c) return;
    openContextMenu(e.clientX, e.clientY, c);
});

document.addEventListener('click', (e) => {
    if (!pageContextMenu.classList.contains('d-none') && !pageContextMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); }, true);
screenWrapper.addEventListener('scroll', closeContextMenu);

// --- Element inspection ---------------------------------------------------
async function requestInspect(point, highlight = true) {
    return fetchJsonOrThrow(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: point.x, y: point.y, highlight }),
    });
}

async function clearHighlight() {
    if (!currentInstanceId || !currentTabId) return;
    try {
        await fetchJsonOrThrow(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/highlight`, { method: 'DELETE' });
        nudge(200);
    } catch { /* best effort */ }
}

async function copySelectorAtPoint(point) {
    try {
        const res = await requestInspect(point, false);
        await navigator.clipboard.writeText(res.node.selector);
    } catch (e) {
        alert(`Could not copy the selector: ${e.message}`);
    }
}

function inspectRow(label, value, mono = false) {
    return `
        <div class="row g-2 py-1 border-bottom border-theme">
            <div class="col-4 col-sm-3 text-theme-muted small">${escapeHtml(label)}</div>
            <div class="col-8 col-sm-9 small ${mono ? 'font-monospace' : ''}" style="word-break:break-all">${value}</div>
        </div>`;
}

function renderInspectedNode(node) {
    inspectedNode = node;
    document.getElementById('inspectSelector').innerText = node.selector || '';
    document.getElementById('inspectTag').innerText = `<${node.tag}>`;
    document.getElementById('inspectSize').innerText = `${node.rect.width} x ${node.rect.height} at ${node.rect.x}, ${node.rect.y}`;

    const attrs = node.attributes.length
        ? node.attributes.map(a => `<div><span class="text-info">${escapeHtml(a.name)}</span>="${escapeHtml(a.value)}"</div>`).join('')
        : '<span class="text-theme-muted">none</span>';

    const styles = Object.entries(node.styles)
        .map(([k, v]) => `<div><span class="text-theme-muted">${escapeHtml(k)}</span>: ${escapeHtml(v)}</div>`).join('');

    document.getElementById('inspectBody').innerHTML = [
        inspectRow('Selector', `<code>${escapeHtml(node.selector)}</code>`, true),
        node.id ? inspectRow('Id', `<code>${escapeHtml(node.id)}</code>`, true) : '',
        node.classes.length ? inspectRow('Classes', node.classes.map(c => `<code>${escapeHtml(c)}</code>`).join(' '), true) : '',
        node.link ? inspectRow('Link', `<a href="${escapeAttr(node.link)}" target="_blank" rel="noopener">${escapeHtml(node.link)}</a>`) : '',
        node.image ? inspectRow('Image', `<a href="${escapeAttr(node.image)}" target="_blank" rel="noopener">${escapeHtml(node.image)}</a>`) : '',
        inspectRow('Children', String(node.child_count)),
        node.text ? inspectRow('Text', escapeHtml(node.text.slice(0, 500))) : '',
        inspectRow('Attributes', `<div class="font-monospace x-small">${attrs}</div>`),
        inspectRow('Computed style', `<div class="font-monospace x-small">${styles}</div>`),
        `<div class="mt-3">
            <div class="text-theme-muted small mb-1">outerHTML</div>
            <pre class="terminal-box mb-0" style="max-height:220px;white-space:pre-wrap;word-break:break-all;font-size:0.72rem">${escapeHtml(node.outer_html)}</pre>
        </div>`,
    ].join('');
}

function inspectNotice(kind, message) {
    const n = document.getElementById('inspectNotice');
    n.className = `alert alert-${kind} rounded-0 mb-0 small`;
    n.innerText = message;
    n.classList.remove('d-none');
    setTimeout(() => n.classList.add('d-none'), 2600);
}

async function inspectAtPoint(point) {
    if (!currentInstanceId || !currentTabId) return;
    if (!inspectModalInstance) inspectModalInstance = new bootstrap.Modal(document.getElementById('inspectModal'));
    document.getElementById('inspectBody').innerHTML = '<div class="text-theme-muted small">Inspecting…</div>';
    document.getElementById('inspectNotice').classList.add('d-none');
    inspectModalInstance.show();

    try {
        const res = await requestInspect(point, true);
        renderInspectedNode(res.node);
        nudge(250); // pull a frame so the highlight shows in the live view
    } catch (e) {
        document.getElementById('inspectBody').innerHTML =
            `<div class="text-danger small">${escapeHtml(e.message)}</div>`;
    }
}

document.getElementById('btnInspectCopySelector').addEventListener('click', async () => {
    if (!inspectedNode) return;
    try {
        await navigator.clipboard.writeText(inspectedNode.selector);
        inspectNotice('success', 'Selector copied.');
    } catch { inspectNotice('warning', 'Clipboard blocked by the browser here.'); }
});
document.getElementById('btnInspectCopyHtml').addEventListener('click', async () => {
    if (!inspectedNode) return;
    try {
        await navigator.clipboard.writeText(inspectedNode.outer_html);
        inspectNotice('success', 'outerHTML copied.');
    } catch { inspectNotice('warning', 'Clipboard blocked by the browser here.'); }
});
document.getElementById('btnInspectClear').addEventListener('click', async () => {
    await clearHighlight();
    inspectNotice('success', 'Highlight cleared.');
});

// Scroll / wheel
tabScreenshot.addEventListener('wheel', (e) => {
    const c = toCanvasCoords(e);
    if (!c) return;
    e.preventDefault();
    sendMouse({ type: 'mouseWheel', x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
    nudge(120);
}, { passive: false });

// --- Keyboard ---
const SPECIAL_KEYS = {
    Enter:      { code: 'Enter', vk: 13 },
    Backspace:  { code: 'Backspace', vk: 8 },
    Tab:        { code: 'Tab', vk: 9 },
    Escape:     { code: 'Escape', vk: 27 },
    Delete:     { code: 'Delete', vk: 46 },
    ArrowUp:    { code: 'ArrowUp', vk: 38 },
    ArrowDown:  { code: 'ArrowDown', vk: 40 },
    ArrowLeft:  { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    Home:       { code: 'Home', vk: 36 },
    End:        { code: 'End', vk: 35 },
    PageUp:     { code: 'PageUp', vk: 33 },
    PageDown:   { code: 'PageDown', vk: 34 },
};

function modifiersFor(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

screenWrapper.addEventListener('focus', () => screenWrapper.classList.add('has-focus'));
screenWrapper.addEventListener('blur', () => screenWrapper.classList.remove('has-focus'));

screenWrapper.addEventListener('keydown', async (e) => {
    if (!currentInstanceId || !currentTabId) return;

    const hasCmdCtrl = e.ctrlKey || e.metaKey;
    const printable = e.key.length === 1;
    const special = SPECIAL_KEYS[e.key];

    // Plain printable character -> insert text (handles all layouts/IME nicely).
    if (printable && !hasCmdCtrl && !e.altKey) {
        e.preventDefault();
        await sendText(e.key);
        nudge();
        return;
    }

    // Special keys and keyboard shortcuts -> real key events.
    if (special || hasCmdCtrl || !printable) {
        e.preventDefault();
        let code, vk;
        if (special) {
            code = special.code; vk = special.vk;
        } else if (printable) {
            const ch = e.key.toUpperCase();
            vk = ch.charCodeAt(0);
            code = /[A-Z]/.test(ch) ? `Key${ch}` : (/[0-9]/.test(ch) ? `Digit${ch}` : (e.code || ''));
        } else {
            code = e.code || ''; vk = e.keyCode || 0;
        }
        const base = {
            modifiers: modifiersFor(e),
            key: e.key,
            code,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
        };
        await sendKey({ ...base, type: 'rawKeyDown' });
        await sendKey({ ...base, type: 'keyUp' });
        nudge();
    }
});

// --- Stats & Server Logs ---
function startStats() { fetchStats(); statsInterval = setInterval(fetchStats, 3000); }
function stopStats() { clearInterval(statsInterval); }
document.getElementById('btnRefreshServerLogs').addEventListener('click', fetchServerLogs);

async function fetchStats() {
    const stats = await fetchAPI('/api/server/stats');
    if (!stats) return;

    // System info bar
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    setText('sys-host', stats.hostname || '—');
    setText('sys-platform', `${stats.platform || ''} ${stats.release || ''}${stats.arch ? ' (' + stats.arch + ')' : ''}`.trim());
    setText('sys-cpu', `${stats.cpu_model || 'CPU'} • ${stats.cpus || '?'} cores`);

    // CPU
    const cpuPct = typeof stats.cpu_usage_percent === 'number' ? stats.cpu_usage_percent : 0;
    document.getElementById('stats-cpus').innerText = `${cpuPct.toFixed(1)}%`;
    const cpuBar = document.getElementById('stats-cpu-bar');
    if (cpuBar) cpuBar.style.width = `${Math.min(100, cpuPct)}%`;
    document.getElementById('stats-cpu-model').innerText = `${stats.cpu_model} • ${stats.cpus} cores`;
    
    // Memory
    const usedMem = stats.totalmem - stats.freemem;
    const memPercent = Math.round((usedMem / stats.totalmem) * 100);
    const memBar = document.getElementById('stats-mem-bar');
    memBar.style.width = `${memPercent}%`;
    document.getElementById('stats-mem-percent').innerText = `${memPercent}%`;
    document.getElementById('stats-mem-text').innerText = `${formatBytes(usedMem)} / ${formatBytes(stats.totalmem)}`;
    
    // Disk
    if (stats.disk) {
        const diskBar = document.getElementById('stats-disk-bar');
        diskBar.style.width = stats.disk.percent;
        document.getElementById('stats-disk-percent').innerText = stats.disk.percent;
        document.getElementById('stats-disk-text').innerText = `${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`;
    }

    document.getElementById('stats-uptime').innerText = formatUptime(stats.uptime);
    document.getElementById('stats-load').innerText = stats.loadavg.map(n => n.toFixed(2)).join(' ');
    
    document.getElementById('stats-interfaces').innerHTML = stats.interfaces.map(iface => `
        <tr><td>${iface.name}</td><td class="font-monospace text-warning">${iface.address}</td></tr>
    `).join('');

    fetchServerLogs();
}
async function fetchServerLogs() { const logs = await fetchAPI('/api/server/logs'); if (logs && Array.isArray(logs)) { serverLogsContainer.innerText = logs.join('\n'); serverLogsContainer.scrollTop = serverLogsContainer.scrollHeight; } }

// --- Config ---
const configList = document.getElementById('config-list');
const configForm = document.getElementById('configForm');
async function loadConfig() { const config = await fetchAPI('/api/config'); configList.innerHTML = Object.entries(config).map(([key, value]) => `<tr><td>${key}</td><td>${value}</td><td><button class="btn btn-sm btn-outline-danger" onclick="deleteConfig('${key}')"><i class="bi bi-trash"></i></button></td></tr>`).join(''); }
configForm.addEventListener('submit', async (e) => { e.preventDefault(); await fetchAPI('/api/config', 'POST', { key: document.getElementById('configKey').value, value: document.getElementById('configValue').value }); bootstrap.Modal.getInstance(document.getElementById('addConfigModal')).hide(); configForm.reset(); loadConfig(); });
async function deleteConfig(key) { if(confirm('Delete?')) { await fetchAPI(`/api/config/${key}`, 'DELETE'); loadConfig(); } }

// --- REST API settings ---------------------------------------------------
// The toggle and key live in the config table server-side, so everything here
// applies at runtime: no .env edit, no restart.
const restEnabledSwitch = document.getElementById('restEnabledSwitch');
const restApiKeyInput = document.getElementById('restApiKey');
const restStatusBadge = document.getElementById('restStatusBadge');
const restAlert = document.getElementById('restAlert');
const restHint = document.getElementById('restHint');
const restExample = document.getElementById('restExample');
const btnRestSave = document.getElementById('btnRestSave');
const btnRestReveal = document.getElementById('btnRestReveal');
const btnRestCopy = document.getElementById('btnRestCopy');
const btnRestGenerate = document.getElementById('btnRestGenerate');

function showRestAlert(kind, message) {
    if (!restAlert) return;
    restAlert.className = `alert alert-${kind}`;
    restAlert.innerText = message;
    restAlert.classList.remove('d-none');
}

function renderRestSettings(settings) {
    if (!settings || !restEnabledSwitch) return;

    restEnabledSwitch.checked = Boolean(settings.requested);
    restApiKeyInput.value = settings.api_key || '';
    restApiKeyInput.placeholder = settings.has_key ? '' : 'No key set';

    const baseUrl = `${window.location.origin}${settings.base_path}`;
    document.getElementById('restBaseUrl').innerText = baseUrl;

    restStatusBadge.className = `badge ${settings.enabled ? 'bg-success' : 'bg-secondary'}`;
    restStatusBadge.innerText = settings.enabled ? 'Enabled' : 'Disabled';

    // The switch can be on while the API is off — that only happens with no key.
    restHint.innerText = settings.requested && !settings.enabled
        ? 'Switched on, but inactive until a key is set.'
        : '';

    // /rest/docs only answers while the API is on; fall back to the dashboard
    // copy at /api/docs so the contract is always one click away.
    const docsLink = document.getElementById('linkRestDocs');
    if (docsLink) {
        docsLink.href = settings.enabled ? `${settings.base_path}/docs` : '/api/docs';
        docsLink.title = settings.enabled
            ? 'Opens the token-protected contract at /rest/docs'
            : 'REST API is off — showing the dashboard copy at /api/docs';
    }

    restExample.classList.toggle('d-none', !settings.enabled);
    if (settings.enabled) {
        restExample.innerText = `curl -H "X-API-Key: ${settings.api_key}" ${baseUrl}/instances`;
    }
}

async function loadRestSettings() {
    if (!restEnabledSwitch) return;
    restAlert.classList.add('d-none');
    try {
        renderRestSettings(await fetchJsonOrThrow('/api/settings/rest'));
    } catch (e) {
        showRestAlert('danger', `Could not load REST settings: ${e.message}`);
    }
}

async function saveRestSettings(payload, successMessage) {
    btnRestSave.disabled = true;
    restAlert.classList.add('d-none');
    try {
        const result = await fetchJsonOrThrow('/api/settings/rest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        renderRestSettings(result);
        showRestAlert('success', successMessage);
    } catch (e) {
        // Re-sync so the switch reflects what the server actually stored rather
        // than the rejected attempt (e.g. enabling without a key).
        await loadRestSettings();
        showRestAlert('danger', e.message);
    } finally {
        btnRestSave.disabled = false;
    }
}

if (btnRestSave) {
    btnRestSave.addEventListener('click', () => saveRestSettings(
        { enabled: restEnabledSwitch.checked, api_key: restApiKeyInput.value.trim() },
        'Saved. The change is live — no restart needed.'
    ));
}

if (btnRestGenerate) {
    btnRestGenerate.addEventListener('click', async () => {
        const rotating = Boolean(restApiKeyInput.value);
        if (rotating && !await confirmAction({
            title: 'Generate a new key?',
            messageHtml: 'The current key stops working immediately. Any script or service using it has to be updated.',
            confirmLabel: 'Generate new key',
        })) return;

        await saveRestSettings(
            { enabled: restEnabledSwitch.checked, generate_key: true },
            rotating ? 'New key generated. Update your clients — the old key no longer works.' : 'Key generated.'
        );
        restApiKeyInput.type = 'text';
        btnRestReveal.innerHTML = '<i class="bi bi-eye-slash"></i>';
    });
}

if (btnRestReveal) {
    btnRestReveal.addEventListener('click', () => {
        const hidden = restApiKeyInput.type === 'password';
        restApiKeyInput.type = hidden ? 'text' : 'password';
        btnRestReveal.innerHTML = `<i class="bi bi-eye${hidden ? '-slash' : ''}"></i>`;
    });
}

if (btnRestCopy) {
    btnRestCopy.addEventListener('click', async () => {
        if (!restApiKeyInput.value) return;
        try {
            await navigator.clipboard.writeText(restApiKeyInput.value);
            showRestAlert('success', 'API key copied to clipboard.');
        } catch {
            // Clipboard access needs a secure context; over plain HTTP on a LAN
            // address it is unavailable, so fall back to selecting the text.
            restApiKeyInput.type = 'text';
            restApiKeyInput.select();
            showRestAlert('warning', 'Clipboard blocked by the browser — the key is selected, copy it manually.');
        }
    });
}

// --- Utils ---
async function fetchAPI(url, method = 'GET', body = null) { const opts = { method }; if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); } const res = await fetch(url, opts); if (res.status === 401) { window.location.reload(); return null; } return res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text(); }
async function fetchJsonOrThrow(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        window.location.reload();
        return null;
    }

    const isJson = res.headers.get('content-type')?.includes('application/json');
    const payload = isJson ? await res.json() : { error: await res.text() };
    if (!res.ok) {
        throw new Error(payload.error || `Request failed with status ${res.status}`);
    }
    return payload;
}
function renderImportCookieFiles(files) {
    if (!files.length) {
        importCookiesSelectedFiles.innerHTML = 'No files selected.';
        return;
    }

    importCookiesSelectedFiles.innerHTML = files.map((file) => `
        <div class="d-flex justify-content-between align-items-center gap-3">
            <span class="text-break">${escapeHtml(file.name)}</span>
            <span class="badge bg-secondary">${formatBytes(file.size)}</span>
        </div>
    `).join('');
}
function setImportCookiesResult(message, tone = 'secondary', hidden = false) {
    importCookiesResult.className = 'alert mb-0';
    if (hidden || !message) {
        importCookiesResult.classList.add('d-none');
        importCookiesResult.textContent = '';
        return;
    }

    importCookiesResult.classList.add(`alert-${tone}`);
    importCookiesResult.classList.remove('d-none');
    importCookiesResult.textContent = message;
}
function setImportSubmitState(isLoading) {
    importCookiesSubmitBtn.disabled = isLoading;
    importCookiesFilesInput.disabled = isLoading;
    importCookiesSubmitBtn.innerHTML = isLoading
        ? '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Importing...'
        : 'Import';
}
async function readFileAsText(file) {
    const content = await file.text();
    return { name: file.name, content };
}
function formatCookieImportSummary(result) {
    const fileCount = (Array.isArray(result.files) ? result.files.length : 0) + (Array.isArray(result.file_errors) ? result.file_errors.length : 0);
    const parts = [
        `Imported ${result.imported || 0} cookies from ${fileCount} file(s).`
    ];

    if (Array.isArray(result.file_errors) && result.file_errors.length) {
        parts.push(`File parse issues: ${result.file_errors.map((item) => `${item.name}: ${item.error}`).join(' | ')}`);
    }

    if (Array.isArray(result.failures) && result.failures.length) {
        const failedCookies = result.failures
            .slice(0, 5)
            .map((item) => `${item.name}${item.domain ? `@${item.domain}` : ''}: ${item.error}`)
            .join(' | ');
        const extraCount = result.failures.length > 5 ? ` (+${result.failures.length - 5} more)` : '';
        parts.push(`CDP rejected ${result.failures.length} cookie(s): ${failedCookies}${extraCount}`);
    }

    return parts.join('\n');
}
function formatBytes(bytes) { if (!+bytes) return '0 B'; const i = Math.floor(Math.log(bytes) / Math.log(1024)); return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${['B','KB','MB','GB'][i]}`; }
function formatUptime(s) { const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); return `${h}h ${m}m`; }
function escapeHtml(t) { return t ? String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ''; }
function escapeAttr(t) { return escapeHtml(t).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

// Compact elapsed-time formatter for instance uptime ("on for how long").
function formatUptimeFrom(startedAt) {
    if (!startedAt) return '—';
    const start = new Date(startedAt.includes('T') ? startedAt : startedAt.replace(' ', 'T') + 'Z');
    let secs = Math.floor((Date.now() - start.getTime()) / 1000);
    if (!Number.isFinite(secs) || secs < 0) secs = 0;
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// Tick uptime chips every second without re-rendering the whole list.
setInterval(() => {
    document.querySelectorAll('.uptime[data-started-at]').forEach((el) => {
        const startedAt = el.getAttribute('data-started-at');
        if (!startedAt) return;
        el.innerHTML = `<i class="bi bi-clock-history"></i> ${formatUptimeFrom(startedAt)}`;
    });
}, 1000);
