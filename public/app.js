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
const useSocat = document.getElementById('use_socat');
const inputDebugPort = document.getElementById('inputDebugPort');
const inputForwardPort = document.getElementById('inputForwardPort');

// Control Modal
const controlModalEl = document.getElementById('controlModal');
const controlModal = new bootstrap.Modal(controlModalEl);
const tabList = document.getElementById('tabList');
const tabContent = document.getElementById('tabContent');
const noTabSelected = document.getElementById('noTabSelected');
const tabScreenshot = document.getElementById('tabScreenshot');
const activeTabUrl = document.getElementById('activeTabUrl');
const tabCountBadge = document.getElementById('tabCountBadge');

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
    document.getElementById('use_xvfb').checked = true;
    document.getElementById('use_socat').checked = true;
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
        stopStats();
    }
}

navDashboard.onclick = () => switchView('dashboard');
navServer.onclick = () => switchView('server');
navConfig.onclick = () => switchView('config');

// --- Render Logic ---

function renderInstances(instances) {
    // Grid Render
    instancesList.innerHTML = instances.map(inst => {
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
                        onclick="openControl(${inst.id}, '${inst.name}')">
                        <i class="bi bi-browser-chrome me-1"></i> ${inst.name}
                    </h5>
                    <span class="badge ${inst.type === 'local' ? 'bg-info' : 'bg-warning'} text-dark">${inst.type}</span>
                </div>
                <div class="card-body">
                    <div class="d-flex align-items-center mb-3">
                        <span class="status-indicator status-${inst.status}"></span>
                        <span class="text-uppercase small fw-bold">${inst.status}</span>
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
                <div class="card-footer d-flex gap-2 p-2">
                     ${getActions(inst)}
                </div>
            </div>
        </div>`;
    }).join('');

    // Table Render
    instancesTableBody.innerHTML = instances.map(inst => `
        <tr>
            <td><span class="status-indicator status-${inst.status}"></span> ${inst.status}</td>
            <td>
                <div class="fw-bold cursor-pointer text-primary" onclick="openControl(${inst.id}, '${inst.name}')">${inst.name}</div>
                ${inst.notes ? `<div class="x-small text-theme-muted">${escapeHtml(inst.notes)}</div>` : ''}
            </td>
            <td><span class="badge ${inst.type === 'local' ? 'bg-info' : 'bg-warning'} text-dark">${inst.type}</span></td>
            <td class="font-monospace">${inst.host}:${inst.port}</td>
            <td class="font-monospace">${inst.forward_port || '-'}</td>
            <td>
                <div class="d-flex gap-2">
                    ${getActions(inst, true)}
                </div>
            </td>
        </tr>
    `).join('');
}

function getActions(inst, small = false) {
    const btnClass = small ? 'btn-sm btn-theme-secondary' : 'btn-sm flex-grow-1 btn-theme-secondary';
    
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
        <button class="btn ${small ? 'btn-sm btn-outline-danger' : 'btn-sm btn-outline-danger'}" onclick="deleteInstance(${inst.id})">
            <i class="bi bi-trash"></i>
        </button>
    `;
}

// --- Instance Actions ---
async function startInstance(id) { await fetchAPI(`/api/instances/${id}/start`, 'POST'); }
async function stopInstance(id) { await fetchAPI(`/api/instances/${id}/stop`, 'POST'); }
async function deleteInstance(id) { if (confirm('Delete this instance?')) await fetchAPI(`/api/instances/${id}`, 'DELETE'); }

addInstanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(addInstanceForm);
    const data = Object.fromEntries(formData.entries());
    data.use_xvfb = formData.get('use_xvfb') === 'on';
    data.use_socat = formData.get('use_socat') === 'on';
        const res = await fetch('/api/instances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    
        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addInstanceModal')).hide();
            addInstanceForm.reset();
        } else {
            const err = await res.json();
            alert('Error: ' + (err.error || 'Failed to save instance'));
        }
    });
    

[useSocat, inputDebugPort].forEach(el => { el.addEventListener('change', updateForwardPort); el.addEventListener('input', updateForwardPort); });
function updateForwardPort() { if (useSocat.checked) { const debugPort = parseInt(inputDebugPort.value) || 0; if (debugPort > 0) inputForwardPort.value = debugPort + 1; } }
instanceType.addEventListener('change', (e) => { const isLocal = e.target.value === 'local'; localOptionsInputs.style.display = isLocal ? 'block' : 'none'; localOptionsCheckboxes.style.display = isLocal ? 'block' : 'none'; });

// --- Logs ---
async function openLogs(id) { currentLogInstanceId = id; logContent.innerText = 'Loading...'; logModal.show(); refreshInstanceLogs(); }
async function refreshInstanceLogs() { if (!currentLogInstanceId) return; const res = await fetchAPI(`/api/instances/${currentLogInstanceId}/logs`); logContent.innerText = res.logs || 'No logs found.'; logContent.scrollTop = logContent.scrollHeight; }

// --- Control Logic ---
async function openControl(id, name) { currentInstanceId = id; document.getElementById('controlModalTitle').innerText = `Control: ${name}`; controlModal.show(); loadTabs(); }
async function loadTabs() {
    const tabs = await fetchAPI(`/api/instances/${currentInstanceId}/tabs`);
    tabCountBadge.innerText = tabs.length;
    tabList.innerHTML = tabs.map(tab => `
        <button class="list-group-item list-group-item-action tab-list-item d-flex align-items-center gap-2 ${currentTabId === tab.id ? 'active' : ''}" 
                onclick="selectTab('${tab.id}', '${escapeHtml(tab.title)}', '${tab.url}')">
            ${tab.favIconUrl ? `<img src="${tab.favIconUrl}" width="16" height="16">` : '<i class="bi bi-window"></i>'}
            <div class="overflow-hidden w-100">
                <div class="text-truncate small fw-bold">${tab.title || 'No Title'}</div>
                <div class="text-truncate x-small opacity-75" style="font-size: 0.7rem;">${tab.url}</div>
            </div>
        </button>
    `).join('');
}
function selectTab(id, title, url) {
    currentTabId = id; tabContent.classList.remove('d-none'); noTabSelected.classList.add('d-none'); activeTabUrl.value = url; refreshScreenshot();
    document.querySelectorAll('#tabList button').forEach(el => {
        if (el.onclick.toString().includes(id)) el.classList.add('active'); else el.classList.remove('active');
    });
}
async function refreshScreenshot() {
    if (!currentInstanceId || !currentTabId) return;
    const loading = document.getElementById('screenshotLoading'); loading.style.display = 'block';
    const src = `/api/instances/${currentInstanceId}/tabs/${currentTabId}/screenshot?t=${Date.now()}`;
    const img = new Image(); img.onload = () => { tabScreenshot.src = src; loading.style.display = 'none'; }; img.src = src;
}
function ensureProtocol(url) { if (!url.match(/^https?:\/\//)) { return 'https://' + url; } return url; }
document.getElementById('btnGo').addEventListener('click', async () => { let url = activeTabUrl.value; url = ensureProtocol(url); activeTabUrl.value = url; await fetchAPI(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/navigate`, 'POST', { url }); setTimeout(refreshScreenshot, 1000); });
document.getElementById('btnNewTab').addEventListener('click', async () => { let url = document.getElementById('newTabUrl').value; if (url) url = ensureProtocol(url); else url = 'about:blank'; await fetchAPI(`/api/instances/${currentInstanceId}/tabs/new`, 'POST', { url }); document.getElementById('newTabUrl').value = ''; loadTabs(); });
document.getElementById('btnCloseTab').addEventListener('click', async () => { if (confirm('Close tab?')) { await fetchAPI(`/api/instances/${currentInstanceId}/tabs/${currentTabId}`, 'DELETE'); currentTabId = null; tabContent.classList.add('d-none'); noTabSelected.classList.remove('d-none'); loadTabs(); } });
// Interactive Input (Click)
tabScreenshot.addEventListener('mousedown', async (e) => {
    if (!currentInstanceId || !currentTabId) return;
    const rect = tabScreenshot.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = tabScreenshot.naturalWidth / rect.width;
    const scaleY = tabScreenshot.naturalHeight / rect.height;
    const actualX = Math.round(x * scaleX);
    const actualY = Math.round(y * scaleY);

    await sendInput('mousePressed', { x: actualX, y: actualY, button: 'left', clickCount: 1 });
    await sendInput('mouseReleased', { x: actualX, y: actualY, button: 'left', clickCount: 1 });
    setTimeout(refreshScreenshot, 500);
});

// Interactive Input (Scroll/Wheel)
tabScreenshot.addEventListener('wheel', async (e) => {
    if (!currentInstanceId || !currentTabId) return;
    e.preventDefault(); // Prevent page scroll

    const rect = tabScreenshot.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = tabScreenshot.naturalWidth / rect.width;
    const scaleY = tabScreenshot.naturalHeight / rect.height;
    
    // CDP expects deltaX and deltaY
    await sendInput('mouseWheel', {
        x: Math.round(x * scaleX),
        y: Math.round(y * scaleY),
        deltaX: e.deltaX,
        deltaY: e.deltaY
    });
    
    // Throttled refresh
    if (!window.scrollTimeout) {
        window.scrollTimeout = setTimeout(() => {
            refreshScreenshot();
            window.scrollTimeout = null;
        }, 300);
    }
}, { passive: false });

async function sendInput(type, params) {
    let method = 'Input.dispatchMouseEvent';
    if (type.includes('Key') || type === 'char') {
        method = 'Input.dispatchKeyEvent';
        if (type === 'char') params = { type: 'char', text: params.text };
    } else if (type === 'mouseWheel') {
        params.type = 'mouseWheel';
    } else {
        params.type = type;
    }
    
    await fetchAPI(`/api/instances/${currentInstanceId}/tabs/${currentTabId}/input`, 'POST', {
        type: method.includes('Mouse') ? 'mouse' : 'key', params
    });
}

// --- Stats & Server Logs ---
function startStats() { fetchStats(); statsInterval = setInterval(fetchStats, 3000); }
function stopStats() { clearInterval(statsInterval); }
document.getElementById('btnRefreshServerLogs').addEventListener('click', fetchServerLogs);

async function fetchStats() {
    const stats = await fetchAPI('/api/server/stats');
    if (!stats) return;

    // CPU
    document.getElementById('stats-cpus').innerText = stats.cpus;
    document.getElementById('stats-cpu-model').innerText = stats.cpu_model;
    
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

// --- Utils ---
async function fetchAPI(url, method = 'GET', body = null) { const opts = { method }; if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); } const res = await fetch(url, opts); if (res.status === 401) { window.location.reload(); return null; } return res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text(); }
function formatBytes(bytes) { if (!+bytes) return '0 B'; const i = Math.floor(Math.log(bytes) / Math.log(1024)); return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${['B','KB','MB','GB'][i]}`; }
function formatUptime(s) { const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); return `${h}h ${m}m`; }
function escapeHtml(t) { return t ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ''; }