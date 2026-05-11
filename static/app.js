'use strict';

const REFRESH_INTERVAL = 60_000;

let configMeta = {}; // name → { has_version_url, has_github, github, ... }
let editingService = null; // name of service being edited in the form, or null for add

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

  // Render each service
  for (const svc of data.services) {
    renderCard(svc);
  }

  document.getElementById('last-updated').textContent = formatDate(data.last_updated);
  document.getElementById('last-github-fetch').textContent = data.last_github_fetch
    ? formatDate(data.last_github_fetch)
    : '—';
}

async function saveVersion(name, version) {
  await apiFetch(`/api/services/${encodeURIComponent(name)}/version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  showToast(`Saved version for ${name}`);
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
    } else {
      showToast('All services up to date — nothing to notify');
    }
  } catch (e) {
    showToast(`Notify failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
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

  for (const svc of configData.services) {
    const tr = document.createElement('tr');
    const versionSource = svc.version_key
      ? `key: <code>${escapeHtml(svc.version_key)}</code>`
      : svc.version_template
        ? `tmpl: <code>${escapeHtml(svc.version_template)}</code>`
        : svc.version_url
          ? `url only`
          : `<span class="badge manual">manual</span>`;
    const authBadge = svc.has_basic_auth ? ` <span class="badge" title="Basic auth configured">&#128274;</span>` : '';

    tr.innerHTML = `
      <td><strong>${escapeHtml(svc.name)}</strong></td>
      <td class="text-muted">${escapeHtml(svc.github ?? '—')}</td>
      <td>${versionSource}${authBadge}</td>
      <td>
        <div class="td-actions">
          <button class="btn" data-action="edit" data-name="${escapeHtml(svc.name)}">Edit</button>
          <button class="btn btn-danger" data-action="delete" data-name="${escapeHtml(svc.name)}">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

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

function clearServiceForm() {
  ['sf-name', 'sf-github', 'sf-version-url', 'sf-version-key', 'sf-version-template', 'sf-basic-auth'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('sf-version-type').value = 'manual';
  toggleVersionTypeFields('manual');
}

function toggleVersionTypeFields(type) {
  const urlFields = document.getElementById('sf-url-fields');
  urlFields.style.display = type === 'manual' ? 'none' : 'flex';
  document.getElementById('sf-key-field').style.display = type === 'key' ? 'block' : 'none';
  document.getElementById('sf-template-field').style.display = type === 'template' ? 'block' : 'none';
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
    document.getElementById('sf-basic-auth').value = '';
    if (!svc.version_url) {
      document.getElementById('sf-version-type').value = 'manual';
      toggleVersionTypeFields('manual');
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
  const basic_auth = vtype === 'manual' ? null : (document.getElementById('sf-basic-auth').value.trim() || null);

  const newSvc = { name, ...(github && { github }), ...(version_url && { version_url }),
    ...(version_key && { version_key }), ...(version_template && { version_template }),
    ...(basic_auth && { basic_auth }) };

  // Build updated list
  let services = Object.values(configMeta).map(s => ({
    name: s.name,
    ...(s.github && { github: s.github }),
    ...(s.version_url && { version_url: s.version_url }),
    ...(s.version_key && { version_key: s.version_key }),
    ...(s.version_template && { version_template: s.version_template }),
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
  try {
    await apiFetch('/api/config/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github_check_interval_minutes: intervalVal }),
    });
    showToast(`Settings saved — interval: ${intervalVal === 0 ? 'disabled' : intervalVal + ' min'}`);
  } catch (e) {
    showToast(`Failed to save: ${e.message}`, 'error');
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
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
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('add-service-btn').addEventListener('click', () => openServiceForm(null));
  document.getElementById('sf-cancel').addEventListener('click', hideServiceForm);
  document.getElementById('sf-save').addEventListener('click', saveServiceForm);

  document.getElementById('sf-version-type').addEventListener('change', e => {
    toggleVersionTypeFields(e.target.value);
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
