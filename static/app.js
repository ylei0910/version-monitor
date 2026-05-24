'use strict';

const REFRESH_INTERVAL = 60_000;
const LS_SORT = 'vm_sort';
const LS_CUSTOM_ORDER = 'vm_custom_order';

let configMeta = {}; // name → { has_version_url, has_github, github, ... }
let editingService = null; // name of service being edited in the form, or null for add
let customOrder = JSON.parse(localStorage.getItem(LS_CUSTOM_ORDER) || 'null') || []; // names in user-defined order
let lastServices = []; // cached last API response for instant re-sort

// ── Favicon badge ──────────────────────────────────────────────────────────

function updateFavicon(outdatedCount) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, 32, 32);
    if (outdatedCount > 0) {
      const label = outdatedCount > 9 ? '9+' : String(outdatedCount);
      const r = 9;
      const bx = 32 - r, by = r;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, 2 * Math.PI);
      ctx.fillStyle = '#f85149';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${label.length > 1 ? 9 : 11}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by);
    }
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/png';
    link.href = canvas.toDataURL();
  };
  img.src = '/favicon.svg';
}

// ── Utilities ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast');
  const item = document.createElement('div');
  item.className = `toast-item toast-${type}`;
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => item.remove(), 3500);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ── API calls ──────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.detail || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

async function loadConfig() {
  const data = await apiFetch('/api/config');
  configMeta = {};
  for (const svc of data.services) {
    configMeta[svc.name] = svc;
  }
  // Populate settings form
  const intervalInput = document.getElementById('setting-interval');
  if (intervalInput) intervalInput.value = data.settings.github_check_interval_minutes;
  const cronInput = document.getElementById('setting-notify-cron');
  if (cronInput) cronInput.value = data.settings.notify_cron ?? '';

  const tokenInput = document.getElementById('setting-telegram-token');
  const tokenStatus = document.getElementById('telegram-token-status');
  if (tokenInput && tokenStatus) {
    const hasToken = data.settings.has_telegram_token;
    tokenInput.value = data.settings.telegram_bot_token ?? '';
    tokenInput.placeholder = hasToken ? '' : 'Enter token (required for notifications)';
    tokenStatus.textContent = hasToken ? 'Configured' : 'Not set';
    tokenStatus.className = 'status-badge ' + (hasToken ? 'configured' : 'missing');
  }
  const chatInput = document.getElementById('setting-telegram-chat-id');
  const chatStatus = document.getElementById('telegram-chat-status');
  if (chatInput && chatStatus) {
    const hasChat = data.settings.has_telegram_chat_id;
    chatInput.value = data.settings.telegram_chat_id ?? '';
    chatInput.placeholder = hasChat ? '' : 'Enter chat ID (required for notifications)';
    chatStatus.textContent = hasChat ? 'Configured' : 'Not set';
    chatStatus.className = 'status-badge ' + (hasChat ? 'configured' : 'missing');
  }
  return data;
}

async function loadServices() {
  const data = await apiFetch('/api/services');
  const grid = document.getElementById('services-grid');

  if (data.services.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h2>No services configured</h2>
        <p>Open Settings to add your first service.</p>
      </div>`;
    document.getElementById('last-updated').textContent = '';
    return;
  }

  // Remove empty state if present
  const emptyState = grid.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const existingNames = new Set(
    [...grid.querySelectorAll('.service-card')].map(el => el.dataset.name)
  );
  const incomingNames = new Set(data.services.map(s => s.name));

  // Remove cards for deleted services
  for (const name of existingNames) {
    if (!incomingNames.has(name)) {
      grid.querySelector(`[data-name="${CSS.escape(name)}"]`)?.remove();
    }
  }

  lastServices = data.services;

  // Render each service
  for (const svc of data.services) {
    renderCard(svc);
  }

  applySortToGrid();

  document.getElementById('last-updated').textContent = formatDate(data.last_updated);
  document.getElementById('last-github-fetch').textContent = data.last_github_fetch
    ? formatDate(data.last_github_fetch)
    : '—';

  const outdatedCount = data.services.filter(s => s.is_up_to_date === false).length;
  updateFavicon(outdatedCount);
  document.title = outdatedCount > 0 ? `(${outdatedCount}) Version Monitor` : 'Version Monitor';
}

async function saveVersion(name, version) {
  await apiFetch(`/api/services/${encodeURIComponent(name)}/version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  showToast(`Saved version for ${name}`);
}

// ── Sorting ────────────────────────────────────────────────────────────────

function currentSort() {
  return localStorage.getItem(LS_SORT) || 'custom';
}

function saveCustomOrder(names) {
  customOrder = names;
  localStorage.setItem(LS_CUSTOM_ORDER, JSON.stringify(names));
}

function sortServices(services) {
  const mode = currentSort();
  if (mode === 'name') {
    return [...services].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (mode === 'status') {
    const rank = svc => svc.is_up_to_date === false ? 0 : svc.is_up_to_date === null ? 1 : 2;
    return [...services].sort((a, b) => rank(a) - rank(b));
  }
  if (mode === 'custom' && customOrder.length) {
    return [...services].sort((a, b) => {
      const ia = customOrder.indexOf(a.name);
      const ib = customOrder.indexOf(b.name);
      const ra = ia === -1 ? Infinity : ia;
      const rb = ib === -1 ? Infinity : ib;
      return ra - rb;
    });
  }
  return services; // default — API order
}

function applySortToGrid() {
  const grid = document.getElementById('services-grid');
  const sorted = sortServices(lastServices);
  for (const svc of sorted) {
    const card = grid.querySelector(`[data-name="${CSS.escape(svc.name)}"]`);
    if (card) grid.appendChild(card);
  }
}

// ── Card rendering ─────────────────────────────────────────────────────────

function renderCard(svc) {
  const grid = document.getElementById('services-grid');
  let card = grid.querySelector(`[data-name="${CSS.escape(svc.name)}"]`);
  const isNew = !card;

  if (isNew) {
    card = document.createElement('div');
    card.className = 'service-card';
    card.dataset.name = svc.name;
    grid.appendChild(card);
  }

  // Don't clobber an active inline edit
  const isEditing = card.querySelector('.version-input') !== null;

  const statusClass = svc.is_up_to_date === null ? 'unknown'
    : svc.is_up_to_date ? 'ok' : 'outdated';

  const installedHtml = buildInstalledVersionHtml(svc, isEditing);
  const latestText = escapeHtml(svc.latest_version ?? '—');
  const githubHtml = svc.has_github && configMeta[svc.name]?.github
    ? `<div class="card-github"><a href="https://github.com/${escapeHtml(configMeta[svc.name].github)}" target="_blank" rel="noopener">&#128279; ${escapeHtml(configMeta[svc.name].github)}</a></div>`
    : '';
  const errorHtml = svc.error
    ? `<div class="card-error">&#9888; ${escapeHtml(svc.error)}</div>`
    : '';

  card.innerHTML = `
    <div class="card-header">
      <span class="service-name">${escapeHtml(svc.name)}</span>
      <span class="status-dot ${statusClass}" title="${statusClass}"></span>
    </div>
    <div class="card-versions">
      <div class="version-row">
        <span class="version-label">Installed</span>
        ${installedHtml}
      </div>
      <div class="version-row">
        <span class="version-label">Latest</span>
        <span class="version-value">${latestText}</span>
      </div>
    </div>
    ${githubHtml}
    ${errorHtml}
  `;

  if (svc.is_manual) {
    attachEditListener(card, svc.name);
  }
}

function buildInstalledVersionHtml(svc, isEditing) {
  if (!svc.is_manual) {
    return `<span class="version-value">${escapeHtml(svc.installed_version ?? '—')}</span>`;
  }
  if (isEditing) {
    // Preserve the input — don't re-render
    return `<span class="version-value editable" data-service="${escapeHtml(svc.name)}">${escapeHtml(svc.installed_version ?? '')}</span>`;
  }
  const hasValue = svc.installed_version != null;
  return hasValue
    ? `<span class="version-value editable" data-service="${escapeHtml(svc.name)}" title="Click to edit">${escapeHtml(svc.installed_version)} ✎</span>`
    : `<span class="version-value editable placeholder" data-service="${escapeHtml(svc.name)}" title="Click to set version">✎ set version</span>`;
}

function attachEditListener(card, serviceName) {
  card.querySelectorAll('[data-service]').forEach(el => {
    el.addEventListener('click', () => startInlineEdit(el, serviceName));
  });
}

function startInlineEdit(el, serviceName) {
  if (el.tagName === 'INPUT') return;

  const currentValue = el.classList.contains('placeholder') ? '' : el.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'version-input';
  input.value = currentValue;
  input.dataset.service = serviceName;
  el.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;

  async function commitEdit() {
    if (saved) return;
    saved = true;
    const newVersion = input.value.trim();
    // Remove input immediately so renderCard sees isEditing=false and restores the ✎ icon
    input.remove();
    if (newVersion && newVersion !== currentValue) {
      try {
        await saveVersion(serviceName, newVersion);
      } catch (e) {
        showToast(`Failed to save: ${e.message}`, 'error');
      }
    }
    await loadServices();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') { saved = true; input.remove(); loadServices(); }
  });
  input.addEventListener('blur', commitEdit);
}

// ── Notify ─────────────────────────────────────────────────────────────────

async function triggerNotify() {
  const btn = document.getElementById('notify-btn');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = 'Sending…';
  try {
    const data = await apiFetch('/api/notify', { method: 'POST' });
    if (data.sent) {
      showToast(`Notification sent — ${data.outdated_count} update(s), ${data.error_count} failure(s)`);
    } else if (data.outdated_count === 0 && data.error_count === 0) {
      showToast('All services up to date — nothing to notify');
    } else {
      showToast(data.message || `Notification failed — ${data.outdated_count} update(s) pending`, 'error');
    }
  } catch (e) {
    showToast(`Notify failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function triggerRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  try {
    await apiFetch('/api/refresh', { method: 'POST' });
    await loadServices();
    showToast('GitHub versions refreshed');
  } catch (e) {
    showToast(`Refresh failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Settings modal ─────────────────────────────────────────────────────────

function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
  loadConfig().then(populateServicesTable).catch(console.error);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  hideServiceForm();
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(tabId).classList.add('active');
}

function populateServicesTable(configData) {
  // Keep configMeta in sync — stale configMeta causes services to be omitted from the next save payload
  configMeta = {};
  for (const svc of configData.services) {
    configMeta[svc.name] = svc;
  }

  const tbody = document.getElementById('services-table-body');
  tbody.innerHTML = '';

  // Show services in custom order if set, else config order
  const displayOrder = customOrder.length
    ? [...configData.services].sort((a, b) => {
        const ia = customOrder.indexOf(a.name);
        const ib = customOrder.indexOf(b.name);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      })
    : configData.services;

  for (const svc of displayOrder) {
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.name = svc.name;
    let sourceHtml;
    if (svc.has_mqtt) {
      sourceHtml = `<span class="badge">mqtt</span>`;
    } else if (svc.version_metric) {
      sourceHtml = `<span class="badge">metrics</span>`;
    } else if (svc.version_key) {
      sourceHtml = `<span class="badge">key</span>`;
    } else if (svc.version_template) {
      sourceHtml = `<span class="badge">template</span>`;
    } else if (svc.version_url) {
      sourceHtml = `<span class="badge">url</span>`;
    } else {
      sourceHtml = `<span class="badge manual">manual</span>`;
    }
    const hasAnyAuth = svc.has_basic_auth || svc.has_auth_header || svc.has_latest_basic_auth || svc.has_latest_auth_header;
    const authBadge = hasAnyAuth
      ? `<span title="Authentication configured" style="color:var(--text-muted);display:inline-flex;align-items:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>`
      : '';

    tr.innerHTML = `
      <td><span class="drag-handle" title="Drag to reorder">⠿</span></td>
      <td><strong>${escapeHtml(svc.name)}</strong></td>
      <td><div class="source-cell">${sourceHtml}${authBadge}</div></td>
      <td>
        <div class="td-actions">
          <button class="btn" data-action="edit" data-name="${escapeHtml(svc.name)}">Edit</button>
          <button class="btn btn-danger" data-action="delete" data-name="${escapeHtml(svc.name)}">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Drag-and-drop reordering
  let dragSrc = null;
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('dragstart', e => {
      dragSrc = tr;
      e.dataTransfer.effectAllowed = 'move';
    });
    tr.addEventListener('dragover', e => {
      e.preventDefault();
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      if (tr !== dragSrc) tr.classList.add('drag-over');
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', e => {
      e.preventDefault();
      tr.classList.remove('drag-over');
      if (!dragSrc || dragSrc === tr) return;
      const rows = [...tbody.querySelectorAll('tr')];
      const fromIdx = rows.indexOf(dragSrc);
      const toIdx = rows.indexOf(tr);
      if (fromIdx < toIdx) tr.after(dragSrc);
      else tr.before(dragSrc);
      const newOrder = [...tbody.querySelectorAll('tr')].map(r => r.dataset.name);
      saveCustomOrder(newOrder);
      if (currentSort() === 'custom') applySortToGrid();
    });
    tr.addEventListener('dragend', () => {
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    });
  });

  tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => openServiceForm(btn.dataset.name));
  });
  tbody.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteService(btn.dataset.name));
  });
}

// ── Service form ───────────────────────────────────────────────────────────

function showServiceForm() {
  document.getElementById('service-form').style.display = 'block';
  document.getElementById('add-service-btn').style.display = 'none';
}

function hideServiceForm() {
  document.getElementById('service-form').style.display = 'none';
  document.getElementById('add-service-btn').style.display = 'inline-flex';
  clearServiceForm();
  editingService = null;
}

function setAuthType(selectId, type) {
  const select = document.getElementById(selectId);
  select.value = type;
  const isVersion = selectId === 'sf-auth-type';
  const valueField = document.getElementById(isVersion ? 'sf-auth-value-field' : 'sf-latest-auth-value-field');
  const input = document.getElementById(isVersion ? 'sf-auth-value' : 'sf-latest-auth-value');
  const hint = document.getElementById(isVersion ? 'sf-auth-hint' : 'sf-latest-auth-hint');
  if (type === 'none') {
    valueField.style.display = 'none';
    input.value = '';
  } else if (type === 'basic') {
    valueField.style.display = 'block';
    input.placeholder = 'username:password';
    hint.textContent = 'HTTP Basic Auth credentials';
  } else {
    valueField.style.display = 'block';
    input.placeholder = 'Bearer <token>';
    hint.innerHTML = 'Raw <code>Authorization</code> header value, e.g. <code>Bearer mytoken</code>';
  }
}

function toggleLatestFields(show) {
  document.getElementById('sf-latest-fields').style.display = show ? 'flex' : 'none';
  document.getElementById('sf-use-latest-url').checked = show;
}

function clearServiceForm() {
  ['sf-name', 'sf-github', 'sf-version-url', 'sf-version-key', 'sf-version-template', 'sf-version-metric', 'sf-version-label', 'sf-version-regex', 'sf-auth-value', 'sf-latest-url', 'sf-latest-key', 'sf-latest-regex', 'sf-latest-auth-value', 'sf-mqtt-broker', 'sf-mqtt-port', 'sf-mqtt-topic', 'sf-mqtt-version-key', 'sf-mqtt-username', 'sf-mqtt-password', 'sf-mqtt-version-regex'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('sf-version-type').value = 'manual';
  toggleVersionTypeFields('manual');
  setAuthType('sf-auth-type', 'none');
  setAuthType('sf-latest-auth-type', 'none');
  toggleLatestFields(false);
}

function toggleVersionTypeFields(type) {
  const urlFields = document.getElementById('sf-url-fields');
  urlFields.style.display = (type === 'manual' || type === 'mqtt') ? 'none' : 'flex';
  document.getElementById('sf-mqtt-fields').style.display = type === 'mqtt' ? 'flex' : 'none';
  document.getElementById('sf-version-url').placeholder = type === 'metrics'
    ? 'http://192.168.1.10:8080/metrics'
    : 'http://192.168.1.10:3000/api/v1/version';
  document.getElementById('sf-key-field').style.display = type === 'key' ? 'block' : 'none';
  document.getElementById('sf-template-field').style.display = type === 'template' ? 'block' : 'none';
  document.getElementById('sf-metric-field').style.display = type === 'metrics' ? 'block' : 'none';
  document.getElementById('sf-metric-label-field').style.display = type === 'metrics' ? 'block' : 'none';
}

function openServiceForm(nameToEdit) {
  editingService = nameToEdit || null;
  document.getElementById('service-form-title').textContent = nameToEdit ? 'Edit Service' : 'Add Service';
  showServiceForm();

  if (nameToEdit) {
    const svc = configMeta[nameToEdit];
    if (!svc) return;
    document.getElementById('sf-name').value = svc.name;
    document.getElementById('sf-name').disabled = true;
    document.getElementById('sf-github').value = svc.github ?? '';
    document.getElementById('sf-version-url').value = svc.version_url ?? '';
    document.getElementById('sf-version-regex').value = svc.version_regex ?? '';
    if (svc.auth_header) {
      setAuthType('sf-auth-type', 'header');
      document.getElementById('sf-auth-value').value = svc.auth_header;
    } else if (svc.basic_auth) {
      setAuthType('sf-auth-type', 'basic');
      document.getElementById('sf-auth-value').value = svc.basic_auth;
    } else {
      setAuthType('sf-auth-type', 'none');
    }
    toggleLatestFields(!!(svc.latest_url || svc.latest_key || svc.latest_auth_header || svc.latest_basic_auth));
    document.getElementById('sf-latest-url').value = svc.latest_url ?? '';
    document.getElementById('sf-latest-key').value = svc.latest_key ?? '';
    document.getElementById('sf-latest-regex').value = svc.latest_regex ?? '';
    if (svc.latest_auth_header) {
      setAuthType('sf-latest-auth-type', 'header');
      document.getElementById('sf-latest-auth-value').value = svc.latest_auth_header;
    } else if (svc.latest_basic_auth) {
      setAuthType('sf-latest-auth-type', 'basic');
      document.getElementById('sf-latest-auth-value').value = svc.latest_basic_auth;
    } else {
      setAuthType('sf-latest-auth-type', 'none');
    }
    if (svc.mqtt_broker) {
      document.getElementById('sf-version-type').value = 'mqtt';
      document.getElementById('sf-mqtt-broker').value = svc.mqtt_broker ?? '';
      document.getElementById('sf-mqtt-port').value = svc.mqtt_port ?? '';
      document.getElementById('sf-mqtt-topic').value = svc.mqtt_topic ?? '';
      document.getElementById('sf-mqtt-version-key').value = svc.version_key ?? '';
      document.getElementById('sf-mqtt-username').value = svc.mqtt_username ?? '';
      document.getElementById('sf-mqtt-password').value = svc.mqtt_password ?? '';
      document.getElementById('sf-mqtt-version-regex').value = svc.version_regex ?? '';
      toggleVersionTypeFields('mqtt');
    } else if (!svc.version_url) {
      document.getElementById('sf-version-type').value = 'manual';
      toggleVersionTypeFields('manual');
    } else if (svc.version_metric) {
      document.getElementById('sf-version-type').value = 'metrics';
      document.getElementById('sf-version-metric').value = svc.version_metric;
      document.getElementById('sf-version-label').value = svc.version_label ?? '';
      toggleVersionTypeFields('metrics');
    } else if (svc.version_template) {
      document.getElementById('sf-version-type').value = 'template';
      document.getElementById('sf-version-template').value = svc.version_template;
      toggleVersionTypeFields('template');
    } else {
      document.getElementById('sf-version-type').value = 'key';
      document.getElementById('sf-version-key').value = svc.version_key ?? '';
      toggleVersionTypeFields('key');
    }
  } else {
    document.getElementById('sf-name').disabled = false;
    clearServiceForm();
  }
}

async function saveServiceForm() {
  const name = document.getElementById('sf-name').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }

  const github = document.getElementById('sf-github').value.trim() || null;
  const vtype = document.getElementById('sf-version-type').value;
  const version_url = vtype === 'manual' ? null : (document.getElementById('sf-version-url').value.trim() || null);
  const version_key = vtype === 'key' && version_url
    ? (document.getElementById('sf-version-key').value.trim() || null)
    : null;
  const version_template = vtype === 'template' && version_url
    ? (document.getElementById('sf-version-template').value.trim() || null)
    : null;
  const version_metric = vtype === 'metrics' && version_url
    ? (document.getElementById('sf-version-metric').value.trim() || null)
    : null;
  const version_label = vtype === 'metrics' && version_url
    ? (document.getElementById('sf-version-label').value.trim() || null)
    : null;
  const version_regex = vtype !== 'manual'
    ? (document.getElementById('sf-version-regex').value.trim() || null)
    : null;
  const mqtt_broker = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-broker').value.trim() || null) : null;
  const mqtt_port_raw = vtype === 'mqtt' ? parseInt(document.getElementById('sf-mqtt-port').value.trim(), 10) : NaN;
  const mqtt_port = !isNaN(mqtt_port_raw) ? mqtt_port_raw : null;
  const mqtt_topic = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-topic').value.trim() || null) : null;
  const mqtt_version_key = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-version-key').value.trim() || null) : null;
  const mqtt_username = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-username').value.trim() || null) : null;
  const mqtt_password = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-password').value.trim() || null) : null;
  const mqtt_version_regex = vtype === 'mqtt' ? (document.getElementById('sf-mqtt-version-regex').value.trim() || null) : null;

  const latest_url = document.getElementById('sf-latest-url').value.trim() || null;
  const latest_key = latest_url ? (document.getElementById('sf-latest-key').value.trim() || null) : null;
  const latest_regex = document.getElementById('sf-latest-regex').value.trim() || null;
  const authType = document.getElementById('sf-auth-type').value;
  const authValue = document.getElementById('sf-auth-value').value.trim() || null;
  const basic_auth = vtype !== 'manual' && authType === 'basic' ? authValue : null;
  const auth_header = vtype !== 'manual' && authType === 'header' ? authValue : null;
  const latestAuthType = document.getElementById('sf-latest-auth-type').value;
  const latestAuthValue = document.getElementById('sf-latest-auth-value').value.trim() || null;
  const latest_basic_auth = latest_url && latestAuthType === 'basic' ? latestAuthValue : null;
  const latest_auth_header = latest_url && latestAuthType === 'header' ? latestAuthValue : null;

  const newSvc = { name, ...(github && { github }), ...(version_url && { version_url }),
    ...(version_key && { version_key }), ...(version_template && { version_template }),
    ...(version_metric && { version_metric }), ...(version_label && { version_label }),
    ...(version_regex && { version_regex }),
    ...(mqtt_broker && { mqtt_broker }),
    ...(mqtt_port && { mqtt_port }),
    ...(mqtt_topic && { mqtt_topic }),
    ...(mqtt_version_key && { version_key: mqtt_version_key }),
    ...(mqtt_username && { mqtt_username }),
    ...(mqtt_password && { mqtt_password }),
    ...(mqtt_version_regex && { version_regex: mqtt_version_regex }),
    ...(latest_url && { latest_url }),
    ...(latest_key && { latest_key }),
    ...(latest_regex && { latest_regex }),
    ...(basic_auth && { basic_auth }),
    ...(auth_header && { auth_header }),
    ...(latest_basic_auth && { latest_basic_auth }),
    ...(latest_auth_header && { latest_auth_header }) };

  // Build updated list
  let services = Object.values(configMeta).map(s => ({
    name: s.name,
    ...(s.github && { github: s.github }),
    ...(s.version_url && { version_url: s.version_url }),
    ...(s.version_key && { version_key: s.version_key }),
    ...(s.version_template && { version_template: s.version_template }),
    ...(s.version_metric && { version_metric: s.version_metric }),
    ...(s.version_label && { version_label: s.version_label }),
    ...(s.version_regex && { version_regex: s.version_regex }),
    ...(s.mqtt_broker && { mqtt_broker: s.mqtt_broker }),
    ...(s.mqtt_port && { mqtt_port: s.mqtt_port }),
    ...(s.mqtt_topic && { mqtt_topic: s.mqtt_topic }),
    ...(s.mqtt_username && { mqtt_username: s.mqtt_username }),
    ...(s.mqtt_password && { mqtt_password: s.mqtt_password }),
    ...(s.latest_url && { latest_url: s.latest_url }),
    ...(s.latest_key && { latest_key: s.latest_key }),
    ...(s.latest_regex && { latest_regex: s.latest_regex }),
    ...(s.latest_basic_auth && { latest_basic_auth: s.latest_basic_auth }),
    ...(s.latest_auth_header && { latest_auth_header: s.latest_auth_header }),
  }));

  if (editingService) {
    services = services.map(s => s.name === editingService ? newSvc : s);
  } else {
    if (services.some(s => s.name === name)) {
      showToast(`Service "${name}" already exists`, 'error');
      return;
    }
    services.push(newSvc);
  }

  try {
    const result = await apiFetch('/api/config/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services }),
    });
    showToast(editingService ? 'Service updated' : 'Service added');
    populateServicesTable(result);
    hideServiceForm();
    await loadServices();
  } catch (e) {
    showToast(`Failed to save: ${e.message}`, 'error');
  }
}

async function deleteService(name) {
  if (!confirm(`Delete service "${name}"?`)) return;
  try {
    const result = await apiFetch(`/api/config/services/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast(`Deleted ${name}`);
    populateServicesTable(result);
    await loadServices();
  } catch (e) {
    showToast(`Failed to delete: ${e.message}`, 'error');
  }
}

// ── App settings save ──────────────────────────────────────────────────────

let pendingRestoreFile = null;

function toggleBackupPopover(e) {
  e.stopPropagation();
  document.getElementById('restore-popover').classList.remove('open');
  document.getElementById('backup-popover').classList.toggle('open');
}

function toggleRestorePopover(e) {
  e.stopPropagation();
  document.getElementById('backup-popover').classList.remove('open');
  document.getElementById('restore-popover').classList.toggle('open');
}

async function downloadBackup() {
  const includeSecrets = document.getElementById('backup-secrets-cb').checked;
  document.getElementById('backup-popover').classList.remove('open');
  try {
    const res = await fetch(`/api/backup?include_secrets=${includeSecrets}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'version-monitor-backup.json';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded');
  } catch (e) {
    showToast(`Backup failed: ${e.message}`, 'error');
  }
}

async function restoreBackup() {
  if (!pendingRestoreFile) return;
  const file = pendingRestoreFile;
  document.getElementById('restore-popover').classList.remove('open');
  pendingRestoreFile = null;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await apiFetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    showToast('Restore complete');
    const configData = await apiFetch('/api/config');
    populateServicesTable(configData);
    document.getElementById('setting-interval').value = configData.settings.github_check_interval_minutes;
    await loadServices();
  } catch (e) {
    showToast(`Restore failed: ${e.message}`, 'error');
  }
}

async function saveAppSettings() {
  const intervalVal = parseInt(document.getElementById('setting-interval').value, 10);
  if (isNaN(intervalVal) || intervalVal < 0) {
    showToast('Interval must be 0 or greater', 'error');
    return;
  }
  const telegramToken = document.getElementById('setting-telegram-token').value.trim() || null;
  const telegramChatId = document.getElementById('setting-telegram-chat-id').value.trim() || null;
  const notifyCron = document.getElementById('setting-notify-cron').value.trim() || null;
  try {
    await apiFetch('/api/config/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_check_interval_minutes: intervalVal,
        notify_cron: notifyCron,
        ...(telegramToken !== null && { telegram_bot_token: telegramToken }),
        ...(telegramChatId !== null && { telegram_chat_id: telegramChatId }),
      }),
    });
    await loadConfig();
    showToast(`Settings saved`);
  } catch (e) {
    showToast(`Failed to save: ${e.message}`, 'error');
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Restore saved sort
  const savedSort = localStorage.getItem(LS_SORT) || 'custom';
  document.getElementById('sort-select').value = savedSort;

  try {
    const health = await apiFetch('/health');
    const el = document.getElementById('app-version');
    if (el && health.version) el.textContent = `v${health.version}`;
  } catch { /* non-critical */ }

  try {
    await loadConfig();
    await loadServices();
  } catch (e) {
    showToast(`Load failed: ${e.message}`, 'error');
  }

  setInterval(async () => {
    try { await loadServices(); } catch { /* silent */ }
  }, REFRESH_INTERVAL);

  document.getElementById('notify-btn').addEventListener('click', triggerNotify);
  document.getElementById('refresh-btn').addEventListener('click', triggerRefresh);
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    localStorage.setItem(LS_SORT, e.target.value);
    applySortToGrid();
  });

  document.getElementById('add-service-btn').addEventListener('click', () => openServiceForm(null));
  document.getElementById('sf-cancel').addEventListener('click', hideServiceForm);
  document.getElementById('sf-save').addEventListener('click', saveServiceForm);

  document.getElementById('sf-version-type').addEventListener('change', e => {
    toggleVersionTypeFields(e.target.value);
  });

  document.getElementById('sf-auth-type').addEventListener('change', e => {
    setAuthType('sf-auth-type', e.target.value);
  });

  document.getElementById('sf-latest-auth-type').addEventListener('change', e => {
    setAuthType('sf-latest-auth-type', e.target.value);
  });

  document.getElementById('sf-use-latest-url').addEventListener('change', e => {
    toggleLatestFields(e.target.checked);
  });

  document.getElementById('save-settings-btn').addEventListener('click', saveAppSettings);
  document.querySelectorAll('.reveal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const isRevealed = input.type === 'text';
      input.type = isRevealed ? 'password' : 'text';
      btn.classList.toggle('active', !isRevealed);
    });
  });

  document.getElementById('backup-btn').addEventListener('click', toggleBackupPopover);
  document.getElementById('backup-download-btn').addEventListener('click', downloadBackup);
  document.getElementById('restore-btn').addEventListener('click', toggleRestorePopover);
  document.getElementById('restore-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    pendingRestoreFile = file;
    const nameEl = document.getElementById('restore-filename');
    nameEl.textContent = file.name;
    nameEl.style.display = 'block';
    document.getElementById('restore-confirm-btn').disabled = false;
    e.target.value = '';
  });
  document.getElementById('restore-confirm-btn').addEventListener('click', restoreBackup);
  document.addEventListener('click', e => {
    for (const id of ['backup-popover', 'restore-popover']) {
      const popover = document.getElementById(id);
      if (popover.classList.contains('open') && !popover.parentElement.contains(e.target)) {
        popover.classList.remove('open');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
