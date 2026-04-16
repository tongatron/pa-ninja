'use strict';

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const get = (path) => api('GET', path);
const post = (path, body) => api('POST', path, body);
const put = (path, body) => api('PUT', path, body);
const del = (path) => api('DELETE', path);

// ── Navigation ────────────────────────────────────────────────────────────────

let currentSection = 'sites';

function navigate(section, modulePath) {
  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-link, .nav-job').forEach(el => el.classList.remove('active'));

  const sectionEl = document.getElementById(`section-${section}`);
  if (sectionEl) sectionEl.classList.add('active');

  if (modulePath) {
    const jobEl = document.querySelector(`.nav-job[data-module="${modulePath}"]`);
    if (jobEl) jobEl.classList.add('active');
  } else {
    const linkEl = document.querySelector(`.nav-link[data-section="${section}"]`);
    if (linkEl) linkEl.classList.add('active');
  }

  currentSection = section;

  if (section === 'dashboard') loadDashboard();
  else if (section === 'sites')    { loadSites(); }
  else if (section === 'results')  { loadResultsFilters(modulePath); loadResults(); }
  else if (section === 'messages') loadMessages(modulePath);
  else if (section === 'sessions') loadSessions();
  else if (section === 'info')     loadInfo(modulePath);
  else if (section === 'admin')    loadAdmin();
  else if (section === 'spese') loadSpese();
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    navigate(link.dataset.section);
  });
});

document.querySelectorAll('.nav-job').forEach(job => {
  job.addEventListener('click', e => {
    e.preventDefault();
    navigate(job.dataset.section, job.dataset.module);
  });
});

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '-';
  return str.slice(0, 10);
}

function parseUtc(str) {
  // SQLite datetime('now') restituisce UTC senza suffisso 'Z'.
  // Aggiungiamo 'Z' per evitare che il browser lo interpreti come ora locale.
  if (!str) return NaN;
  return new Date(str.trim().replace(' ', 'T') + 'Z').getTime();
}

function timeAgo(str) {
  if (!str) return '-';
  const diff = Date.now() - parseUtc(str);
  if (isNaN(diff)) return '-';
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'appena ora';
  if (mins < 60) return `${mins}m fa`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h fa`;
  return `${Math.floor(hrs / 24)}g fa`;
}

function statusBadge(status) {
  if (!status) return `<span class="badge badge-none">-</span>`;
  const map = { ok: 'badge-ok', error: 'badge-error', running: 'badge-running' };
  return `<span class="badge ${map[status] || 'badge-none'}">${esc(status)}</span>`;
}

function authBadge(authType) {
  if (authType === 'spid') return `<span class="badge badge-spid">SPID</span>`;
  if (authType === 'basic') return `<span class="badge badge-none">Basic</span>`;
  return `<span class="badge badge-none">Nessuna</span>`;
}

function showAlert(el, type, message) {
  el.className = `alert alert-${type}`;
  el.textContent = message;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const stats = await get('/api/stats');
    document.getElementById('stat-sites').textContent = stats.activeSites;
    document.getElementById('stat-total').textContent = stats.totalResults.toLocaleString();
    document.getElementById('stat-new-today').textContent = stats.newToday;
    document.getElementById('stat-last-run').textContent =
      stats.lastRun ? timeAgo(stats.lastRun.started_at) : '-';

    // SPID alert panel
    const panel = document.getElementById('spid-alert-panel');
    const need = stats.spidNeedAuth || [];
    if (need.length > 0) {
      panel.classList.remove('hidden');
      panel.innerHTML = `
        <div class="spid-alert-icon">🔐</div>
        <div class="spid-alert-body">
          <strong>${need.length === 1 ? '1 sito richiede' : `${need.length} siti richiedono`} autenticazione SPID</strong>
          <div class="spid-alert-list">${need.map(s => `<span>${esc(s.name)}</span>`).join('')}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="navigate('sessions')">Vai agli Accessi →</button>
      `;
    } else {
      panel.classList.add('hidden');
    }
    updateSpidAlert(need.length);
  } catch (err) {
    console.error('loadDashboard:', err);
  }
}

function updateSpidAlert(count) {
  const dot = document.getElementById('nav-spid-alert');
  if (count === undefined) {
    // called without count → re-fetch
    get('/api/stats').then(s => updateSpidAlert((s.spidNeedAuth || []).length)).catch(() => {});
    return;
  }
  if (count > 0) {
    dot.textContent = count;
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

document.getElementById('btn-run-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-all');
  const statusEl = document.getElementById('run-all-status');
  btn.disabled = true;
  btn.textContent = 'In esecuzione...';
  showAlert(statusEl, 'info', 'Avvio di tutti i siti in corso...');

  try {
    const result = await post('/api/run-all');
    showAlert(statusEl, 'info', `Run avviate (IDs: ${result.runIds.join(', ')}). I risultati saranno disponibili a breve.`);

    // Poll until all done
    if (result.runIds && result.runIds.length > 0) {
      pollRunStatus(result.runIds, statusEl, () => {
        btn.disabled = false;
        btn.textContent = '▶ Esegui tutti ora';
        loadSites();
      });
    } else {
      btn.disabled = false;
      btn.textContent = '▶ Esegui tutti ora';
    }
  } catch (err) {
    showAlert(statusEl, 'error', `Errore: ${err.message}`);
    btn.disabled = false;
    btn.textContent = '▶ Esegui tutti ora';
  }
});

async function pollRunStatus(runIds, statusEl, onComplete) {
  const pending = new Set(runIds);
  const results = {};

  const check = async () => {
    for (const runId of [...pending]) {
      try {
        const status = await get(`/api/runs/${runId}/status`);
        if (status.status !== 'running') {
          pending.delete(runId);
          results[runId] = status;
        }
      } catch {
        pending.delete(runId);
      }
    }

    if (pending.size === 0) {
      const errors = Object.values(results).filter(r => r.status === 'error');
      if (errors.length === 0) {
        showAlert(statusEl, 'success', `Tutte le run completate con successo!`);
      } else {
        showAlert(statusEl, 'error', `${errors.length} run con errori. Controlla la sezione Siti.`);
      }
      if (onComplete) onComplete();
    } else {
      setTimeout(check, 2000);
    }
  };

  setTimeout(check, 2000);
}

// ── Sites / Dashboard ─────────────────────────────────────────────────────────

// Raggruppamento servizi: ogni servizio raggruppa uno o più site (job)
const SERVICE_GROUPS = [
  { key: 'piemonte-tu',    name: 'Piemonte Tu',        icon: '✉️',  patterns: ['piemonte-tu'] },
  { key: 'lavoro-piemonte',name: 'Lavoro Piemonte',    icon: '🏢',  patterns: ['lavoro-piemonte'] },
  { key: 'inps',           name: 'INPS',                icon: '🏛️', patterns: ['inps'] },
  { key: 'ader',           name: 'AdE Riscossione',     icon: '🏦',  patterns: ['ader'] },
];

const JOB_LABELS = {
  'lavoro-piemonte':          'Annunci di lavoro',
  'lavoro-piemonte-documenti':'Documenti',
  'piemonte-tu-messaggi':     'Messaggi',
  'inps-dati':                'I miei dati',
  'inps-notifiche':           'Centro notifiche INPS',
  'inps-nes':                 'NES',
  'inps-domande':             'Consultazione domande',
  'inps-isee':                'ISEE dichiarazioni',
  'ader-saldati':             'Saldati',
};

let sitesData = [];

async function loadSites() {
  const grid = document.getElementById('services-grid');
  grid.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';
  try {
    const [sites, sessions] = await Promise.all([
      get('/api/sites'),
      get('/api/sessions'),
    ]);
    sitesData = sites;
    renderServiceCards(sites, sessions);
    renderSessionsGrid(sessions);
    updateSpidAlert((sessions || []).filter(s => s.status === 'expired' || s.status === 'none').length);
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--color-danger);padding:24px">Errore: ${esc(err.message)}</div>`;
  }
}

function renderSessionsGrid(sessions) {
  const grid = document.getElementById('sessions-grid');
  if (!grid) return;
  if (!sessions || sessions.length === 0) {
    grid.innerHTML = '<div style="padding:24px;text-align:center;color:var(--color-text-muted)">Nessun sito con autenticazione configurato</div>';
    return;
  }
  grid.innerHTML = sessions.map(s => renderSessionCard(s)).join('');
}

function renderServiceCards(sites, sessions) {
  const grid = document.getElementById('services-grid');
  const assigned = new Set();
  const cards = [];

  for (const group of SERVICE_GROUPS) {
    const groupSites = sites.filter(s =>
      group.patterns.some(p => s.module_path.startsWith(p))
    );
    if (groupSites.length === 0) continue;
    groupSites.forEach(s => assigned.add(s.id));

    // Sessione SPID per questo gruppo (se almeno un sito ha auth)
    const spidSite = groupSites.find(s => s.auth_type !== 'none');
    const session  = spidSite ? sessions.find(se => se.site_id === spidSite.id) : null;

    cards.push(renderServiceCard(group, groupSites, session));
  }

  // Siti non assegnati a nessun gruppo
  const others = sites.filter(s => !assigned.has(s.id));
  if (others.length > 0) {
    cards.push(renderServiceCard(
      { key: 'other', name: 'Altri', icon: '🌐', patterns: [] },
      others, null
    ));
  }

  grid.innerHTML = cards.length
    ? cards.join('')
    : '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Nessun servizio configurato</div>';
}

function renderServiceCard(group, groupSites, session) {
  // Intestazione SPID (se presente)
  let spidHtml = '';
  if (session) {
    const ST = SESSION_STATUS[session.status] || SESSION_STATUS.none;
    const isOk = session.status === 'fresh' || session.status === 'ok';
    spidHtml = `
      <div class="svc-spid">
        <span class="sess-status-dot ${ST.cls}" style="font-size:10px">●</span>
        <span class="svc-spid-label">${isOk ? (session.saved_at ? timeAgo(session.saved_at) : 'Autenticato') : ST.label}</span>
        <button class="btn btn-sm ${isOk ? 'btn-ghost' : 'btn-primary'}"
          onclick="loginFromSite(${session.site_id}, '${esc(session.site_name)}', '${esc(session.login_url || '')}')">
          🔑 ${session.saved_at ? 'Rinnova' : 'Accedi'}
        </button>
      </div>`;
  }

  // Righe job
  const jobsHtml = groupSites.map(site => {
    const lr  = site.last_run;
    const lok = site.last_ok_run;
    const label = JOB_LABELS[site.module_path] || site.name;
    const statusHtml = lr ? statusBadge(lr.status) : '<span class="badge badge-none">mai</span>';
    const timeHtml   = lok
      ? `<span class="job-time">${timeAgo(lok.started_at)}</span>`
      : (lr ? '<span class="job-time" style="color:var(--color-text-dim)">mai ok</span>' : '<span class="job-time">-</span>');
    const disabledBadge = site.enabled ? '' : ' <span class="badge badge-none" style="font-size:10px">off</span>';

    return `
      <div class="job-row">
        <span class="job-name">${esc(label)}${disabledBadge}</span>
        <span class="job-status-wrap">${statusHtml}${timeHtml}</span>
        <div class="job-actions">
          <button class="btn btn-icon btn-secondary" title="Esegui" onclick="runSite(${site.id})">&#9654;</button>
          <button class="btn btn-icon btn-ghost"      title="Modifica" onclick="editSite(${site.id})">&#9998;</button>
          <button class="btn btn-icon btn-danger"     title="Elimina"  onclick="deleteSite(${site.id}, '${esc(site.name)}')">&#128465;</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="service-card">
      <div class="svc-header">
        <span class="svc-icon">${group.icon}</span>
        <h2 class="svc-name">${esc(group.name)}</h2>
        ${spidHtml}
      </div>
      <div class="svc-jobs">${jobsHtml}</div>
    </div>`;
}

async function runSite(siteId) {
  try {
    const result = await post(`/api/sites/${siteId}/run`);
    setTimeout(() => { if (currentSection === 'sites') loadSites(); }, 3000);
  } catch (err) {
    alert(`Errore nell'avvio della run: ${err.message}`);
  }
}

async function runSite(siteId) {
  try {
    const result = await post(`/api/sites/${siteId}/run`);
    alert(`Run avviata (ID: ${result.runId}). Ricarica la pagina tra qualche istante per vedere i risultati.`);
    // Refresh after 3 seconds
    setTimeout(() => { if (currentSection === 'sites') loadSites(); }, 3000);
  } catch (err) {
    alert(`Errore nell'avvio della run: ${err.message}`);
  }
}

async function loginFromSite(siteId, siteName, loginUrl) {
  if (siteName && loginUrl !== undefined) {
    startLogin(siteId, siteName, loginUrl);
    return;
  }
  try {
    const s = await get(`/api/sessions/${siteId}`);
    startLogin(s.site_id, s.site_name, s.login_url || '');
  } catch {}
}

async function deleteSite(siteId, name) {
  if (!confirm(`Eliminare il sito "${name}"? Tutti i dati associati saranno cancellati.`)) return;
  try {
    await del(`/api/sites/${siteId}`);
    await loadSites();
  } catch (err) {
    alert(`Errore: ${err.message}`);
  }
}

// ── Site modal ────────────────────────────────────────────────────────────────

const siteModal = document.getElementById('site-modal');

function openSiteModal(site = null) {
  document.getElementById('modal-title').textContent = site ? 'Modifica sito' : 'Aggiungi sito';
  document.getElementById('site-id').value = site ? site.id : '';
  document.getElementById('site-name').value = site ? site.name : '';
  document.getElementById('site-url').value = site ? site.url : '';
  document.getElementById('site-module').value = site ? site.module_path : '';
  document.getElementById('site-auth').value = site ? (site.auth_type || 'none') : 'none';
  document.getElementById('site-enabled').checked = site ? !!site.enabled : true;
  siteModal.classList.remove('hidden');
}

function closeSiteModal() {
  siteModal.classList.add('hidden');
}

document.getElementById('btn-add-site').addEventListener('click', () => openSiteModal());
document.getElementById('modal-close').addEventListener('click', closeSiteModal);
document.getElementById('modal-cancel').addEventListener('click', closeSiteModal);
siteModal.addEventListener('click', e => { if (e.target === siteModal) closeSiteModal(); });

function editSite(siteId) {
  const site = sitesData.find(s => s.id === siteId);
  if (site) openSiteModal(site);
}

document.getElementById('site-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('site-id').value;
  const payload = {
    name:       document.getElementById('site-name').value,
    url:        document.getElementById('site-url').value,
    modulePath: document.getElementById('site-module').value,
    authType:   document.getElementById('site-auth').value,
    enabled:    document.getElementById('site-enabled').checked ? 1 : 0,
  };
  try {
    if (id) {
      await put(`/api/sites/${id}`, payload);
    } else {
      await post('/api/sites', payload);
    }
    closeSiteModal();
    await loadSites();
  } catch (err) {
    alert(`Errore nel salvataggio: ${err.message}`);
  }
});

// ── Results ───────────────────────────────────────────────────────────────────

let resultsPage = 1;
let resultsTotalPages = 1;

async function loadResultsFilters(preSelectModule) {
  try {
    const [sites, provinces] = await Promise.all([
      get('/api/sites'),
      get('/api/results/provinces'),
    ]);

    const siteSelect = document.getElementById('filter-site');
    // Pre-seleziona il sito se navigazione da job specifico
    const preId = preSelectModule
      ? (sites.find(s => s.module_path === preSelectModule)?.id || '')
      : '';
    const currentSite = preId || siteSelect.value;
    siteSelect.innerHTML = '<option value="">Tutti i siti</option>' +
      sites.map(s => `<option value="${s.id}" ${String(s.id) === String(currentSite) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

    const provSelect = document.getElementById('filter-province');
    const currentProv = provSelect.value;
    provSelect.innerHTML = '<option value="">Tutte le province</option>' +
      provinces.map(p => `<option value="${esc(p)}" ${p === currentProv ? 'selected' : ''}>${esc(p)}</option>`).join('');
  } catch (err) {
    console.error('loadResultsFilters:', err);
  }
}

async function loadResults(page = 1) {
  resultsPage = page;
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Caricamento...</td></tr>';

  const params = new URLSearchParams();
  params.set('page', page);
  params.set('limit', 50);

  const siteId  = document.getElementById('filter-site').value;
  const province = document.getElementById('filter-province').value;
  const keyword  = document.getElementById('filter-keyword').value.trim();
  const expires  = document.getElementById('filter-expires').value;
  const newOnly  = document.getElementById('filter-new-only').checked;

  if (siteId)  params.set('siteId', siteId);
  if (province) params.set('province', province);
  if (keyword) params.set('keyword', keyword);
  if (expires) params.set('expiresAfter', expires);
  if (newOnly) params.set('newOnly', 'true');

  try {
    const data = await get(`/api/results?${params}`);
    resultsTotalPages = Math.ceil(data.total / data.limit) || 1;

    if (data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading">Nessun risultato trovato</td></tr>';
    } else {
      tbody.innerHTML = data.rows.map(r => `
        <tr class="clickable${r.is_new ? ' row-new' : ''}" onclick="showResultDetail(${esc(JSON.stringify(JSON.stringify(r)))})">
          <td>${r.is_new ? '<span class="badge badge-new">NUOVO</span> ' : ''}${esc(r.title || '-')}</td>
          <td>${esc(r.organization || '-')}</td>
          <td>${esc(r.location || '-')}</td>
          <td>${esc(r.province || '-')}</td>
          <td>${esc(r.contract_type || '-')}</td>
          <td>${formatDate(r.expires_at)}</td>
        </tr>
      `).join('');
    }

    renderPagination(data.total, data.limit, page);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading">Errore: ${esc(err.message)}</td></tr>`;
  }
}

function renderPagination(total, limit, currentPage) {
  const totalPages = Math.ceil(total / limit) || 1;
  const container = document.getElementById('results-pagination');

  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  const start = Math.max(1, currentPage - 3);
  const end = Math.min(totalPages, currentPage + 3);

  if (currentPage > 1) html += `<button class="page-btn" onclick="loadResults(${currentPage - 1})">&laquo;</button>`;
  for (let p = start; p <= end; p++) {
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="loadResults(${p})">${p}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="page-btn" onclick="loadResults(${currentPage + 1})">&raquo;</button>`;

  container.innerHTML = `<span style="color:var(--color-text-muted);font-size:12px">${total.toLocaleString()} risultati</span> ` + html;
}

document.getElementById('btn-search').addEventListener('click', () => loadResults(1));
document.getElementById('btn-reset-filters').addEventListener('click', () => {
  document.getElementById('filter-site').value = '';
  document.getElementById('filter-province').value = '';
  document.getElementById('filter-keyword').value = '';
  document.getElementById('filter-expires').value = '';
  document.getElementById('filter-new-only').checked = false;
  loadResults(1);
});
document.getElementById('filter-keyword').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadResults(1);
});

// ── Result detail modal ───────────────────────────────────────────────────────

const resultModal = document.getElementById('result-modal');

function showResultDetail(jsonStr) {
  const r = JSON.parse(jsonStr);

  document.getElementById('result-modal-title').textContent = r.title || 'Dettaglio annuncio';

  let rawPretty = '';
  try { rawPretty = JSON.stringify(JSON.parse(r.raw_json), null, 2); }
  catch { rawPretty = r.raw_json || ''; }

  document.getElementById('result-modal-body').innerHTML = `
    <div class="result-detail-grid">
      <div class="result-detail-item"><label>Titolo</label><span>${esc(r.title || '-')}</span></div>
      <div class="result-detail-item"><label>Organizzazione</label><span>${esc(r.organization || '-')}</span></div>
      <div class="result-detail-item"><label>Sede</label><span>${esc(r.location || '-')}</span></div>
      <div class="result-detail-item"><label>Provincia</label><span>${esc(r.province || '-')}</span></div>
      <div class="result-detail-item"><label>Contratto</label><span>${esc(r.contract_type || '-')}</span></div>
      <div class="result-detail-item"><label>Scadenza</label><span>${formatDate(r.expires_at)}</span></div>
      <div class="result-detail-item"><label>Prima vista</label><span>${formatDate(r.first_seen_at)}</span></div>
      <div class="result-detail-item"><label>Ultima vista</label><span>${formatDate(r.last_seen_at)}</span></div>
    </div>
    <label style="display:block;font-size:11px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Dati originali (JSON)</label>
    <div class="raw-json-block">${esc(rawPretty)}</div>
  `;

  resultModal.classList.remove('hidden');
}

document.getElementById('result-modal-close').addEventListener('click', () => {
  resultModal.classList.add('hidden');
});
resultModal.addEventListener('click', e => {
  if (e.target === resultModal) resultModal.classList.add('hidden');
});

// ── Messages ──────────────────────────────────────────────────────────────────

let _currentMsgModule = null;

async function loadMessages(modulePath) {
  if (modulePath) _currentMsgModule = modulePath;
  const grid = document.getElementById('messages-grid');
  const countEl = document.getElementById('msg-count');
  const titleEl = document.getElementById('messages-section-title');
  if (titleEl && _currentMsgModule) {
    titleEl.textContent = '✉️ ' + (JOB_LABELS[_currentMsgModule] || _currentMsgModule);
  }
  grid.innerHTML = '<div class="loading" style="padding:32px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';
  countEl.textContent = '';

  const params = new URLSearchParams();
  const unread  = document.getElementById('msg-filter-unread').value;
  const sender  = document.getElementById('msg-filter-sender').value.trim();
  const keyword = document.getElementById('msg-filter-keyword').value.trim();
  const newOnly = document.getElementById('msg-filter-new-only').checked;
  if (unread)  params.set('unread', unread);
  if (sender)  params.set('sender', sender);
  if (keyword) params.set('keyword', keyword);
  if (newOnly) params.set('newOnly', 'true');
  if (_currentMsgModule) params.set('module', _currentMsgModule);

  try {
    const messages = await get(`/api/messages?${params}`);

    if (messages.length === 0) {
      grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--color-text-muted)">Nessun messaggio trovato</div>';
      countEl.textContent = '';
      return;
    }

    const unreadCount = messages.filter(m => !m.read_at).length;
    const newCount    = messages.filter(m => m.is_new).length;
    countEl.textContent = `${messages.length} messaggi`
      + (unreadCount ? ` · ${unreadCount} non letti` : '')
      + (newCount    ? ` · ${newCount} nuovi` : '');

    grid.innerHTML = messages.map(m => {
      const isUnread = !m.read_at;
      const tags = (m.tag || '').split(',').map(t => t.trim()).filter(Boolean);
      const bodyPreview = (m.body || '').replace(/<[^>]+>/g, '').trim();
      return `
        <div class="message-card ${isUnread ? 'unread' : ''}${m.is_new ? ' msg-new' : ''}" onclick="showMessageDetail(${esc(JSON.stringify(JSON.stringify(m)))})">
          <div class="message-card-header">
            <div class="message-card-title">
              ${m.is_new ? '<span class="badge badge-new">NUOVO</span> ' : ''}${esc(m.title)}
            </div>
            ${isUnread ? '<div class="message-unread-dot" title="Non letto"></div>' : ''}
          </div>
          <div class="message-card-meta">
            ${m.sender ? `<span class="message-sender">${esc(m.sender)}</span>` : ''}
            <span class="message-time">${m.timestamp ? timeAgo(m.timestamp) : formatDate(m.first_seen_at)}</span>
          </div>
          ${tags.length ? `<div class="message-tags">${tags.map(t => `<span class="message-tag">${esc(t)}</span>`).join('')}</div>` : ''}
          ${bodyPreview ? `<div class="message-body-preview">${esc(bodyPreview)}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="padding:32px;text-align:center;color:var(--color-danger)">Errore: ${esc(err.message)}</div>`;
  }
}

document.getElementById('btn-msg-search').addEventListener('click', () => loadMessages());
document.getElementById('btn-msg-reset').addEventListener('click', () => {
  document.getElementById('msg-filter-unread').value = '';
  document.getElementById('msg-filter-sender').value = '';
  document.getElementById('msg-filter-keyword').value = '';
  document.getElementById('msg-filter-new-only').checked = false;
  loadMessages();
});
document.getElementById('msg-filter-keyword').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadMessages();
});

// ── Message detail modal ──────────────────────────────────────────────────────

const msgModal = document.getElementById('msg-modal');

function showMessageDetail(jsonStr) {
  const m = JSON.parse(jsonStr);
  document.getElementById('msg-modal-title').textContent = m.title || 'Messaggio';

  const tags = (m.tag || '').split(',').map(t => t.trim()).filter(Boolean);
  const bodyHtml = (m.body || '').replace(/<[^>]+>/g, '').trim();

  document.getElementById('msg-modal-body').innerHTML = `
    <div class="message-card-meta" style="margin-bottom:14px">
      ${m.sender ? `<span class="message-sender">${esc(m.sender)}</span>` : ''}
      <span class="message-time">${m.timestamp ? new Date(m.timestamp).toLocaleString('it-IT') : '-'}</span>
      ${m.read_at
        ? `<span class="badge badge-none">Letto: ${new Date(m.read_at).toLocaleString('it-IT')}</span>`
        : `<span class="badge badge-running">Non letto</span>`}
    </div>
    ${tags.length ? `<div class="message-tags" style="margin-bottom:14px">${tags.map(t => `<span class="message-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${bodyHtml ? `<div class="message-detail-body">${esc(bodyHtml)}</div>` : '<p style="color:var(--color-text-muted);font-size:13px">(nessun testo)</p>'}
    ${m.call_to_action ? `<div class="message-cta"><a href="${esc(m.call_to_action)}" target="_blank" rel="noopener">→ Apri link</a></div>` : ''}
  `;

  msgModal.classList.remove('hidden');
}

document.getElementById('msg-modal-close').addEventListener('click', () => {
  msgModal.classList.add('hidden');
});
msgModal.addEventListener('click', e => {
  if (e.target === msgModal) msgModal.classList.add('hidden');
});

// ── Spese Mediche ─────────────────────────────────────────────────────────────

async function loadSpese() {
  const grid = document.getElementById('spese-years-grid');
  const currentYearEl = document.getElementById('spese-current-year');
  grid.innerHTML = '<div class="loading" style="padding:32px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';
  currentYearEl.innerHTML = '';

  try {
    const data = await get('/api/spese');

    if (!data.length) {
      grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--color-text-muted)">Nessun dato. Aggiungi il sito "Spese Mediche" ed eseguilo.</div>';
      return;
    }

    const currentYear = String(new Date().getFullYear());

    // Year cards
    grid.innerHTML = data.map(s => {
      const isCurrent = s.year === currentYear;
      return `
        <div class="spese-year-card ${isCurrent ? 'spese-year-current' : ''}">
          <div class="spese-year-label">${isCurrent ? '📅 Anno in corso' : ''}</div>
          <div class="spese-year-number">${esc(s.year)}</div>
          <div class="spese-year-total">${esc(s.total || '—')}</div>
          <div class="spese-year-meta">Aggiornato ${s.scrapedAt ? timeAgo(s.scrapedAt) : '—'}</div>
          <div class="spese-year-actions">
            ${s.xlsFilename
              ? `<a class="btn btn-primary btn-sm" href="/api/spese/file/${encodeURIComponent(s.xlsFilename)}" download>⬇ Scarica XLS</a>`
              : '<span style="font-size:11px;color:var(--color-text-dim)">XLS non disponibile</span>'}
          </div>
        </div>`;
    }).join('');

    // Current year table
    const current = data.find(s => s.year === currentYear);
    if (current && current.rows && current.rows.length > 0) {
      currentYearEl.innerHTML = `
        <h2 class="spese-table-title">Dettaglio spese ${currentYear}</h2>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>Erogatore</th>
              <th>Tipologia</th>
              <th>Importo</th>
              <th>Data emissione</th>
              <th>Data pagamento</th>
            </tr></thead>
            <tbody>
              ${current.rows.map(r => `<tr>${r.slice(0,5).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--color-danger);padding:24px">Errore: ${esc(err.message)}</div>`;
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const SESSION_STATUS = {
  fresh:   { cls: 'sess-fresh',   dot: '●', label: 'Appena autenticato' },
  ok:      { cls: 'sess-ok',      dot: '●', label: 'Autenticato' },
  warning: { cls: 'sess-warning', dot: '●', label: 'Sessione datata' },
  expired: { cls: 'sess-expired', dot: '●', label: 'Probabilmente scaduta' },
  none:    { cls: 'sess-none',    dot: '○', label: 'Non autenticato' },
};

async function loadSessions() {
  const grid = document.getElementById('sessions-grid');
  grid.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';
  try {
    const sessions = await get('/api/sessions');
    if (sessions.length === 0) {
      grid.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Nessun sito con autenticazione configurato</div>';
      return;
    }
    grid.innerHTML = sessions.map(s => renderSessionCard(s)).join('');
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--color-danger);padding:24px">Errore: ${esc(err.message)}</div>`;
  }
}

function renderSessionCard(s) {
  const st = SESSION_STATUS[s.status] || SESSION_STATUS.none;
  const loginBtnLabel = s.saved_at ? '🔑 Rinnova accesso' : '🔑 Accedi con SPID';

  let metaHtml = '';
  if (s.saved_at) {
    metaHtml = `
      <div class="sess-meta">
        <span>Ultimo accesso: <strong>${timeAgo(s.saved_at)}</strong></span>
        <span class="sess-meta-sep">·</span>
        <span>${s.cookie_count} cookie salvati</span>
      </div>`;
    if (s.status === 'warning' || s.status === 'expired') {
      metaHtml += `<div class="sess-hint">Le sessioni SPID durano circa 1 ora. Potrebbe essere necessario rinnovare.</div>`;
    }
  } else {
    metaHtml = '<div class="sess-meta">Nessuna sessione salvata</div>';
  }

  return `
    <div class="session-card ${st.cls}" id="sess-card-${s.site_id}">
      <div class="sess-card-top">
        <span class="sess-status-dot ${st.cls}">${st.dot}</span>
        <span class="sess-status-label">${st.label}</span>
        <span class="badge badge-spid" style="margin-left:auto">${esc(s.auth_type.toUpperCase())}</span>
      </div>
      <div class="sess-name">${esc(s.site_name)}</div>
      ${s.login_url ? `<div class="sess-url">${esc(s.login_url)}</div>` : ''}
      ${metaHtml}
      <div class="sess-actions">
        <button class="btn btn-primary btn-sm" onclick="startLogin(${s.site_id}, '${esc(s.site_name)}', '${esc(s.login_url || '')}')">
          ${loginBtnLabel}
        </button>
        ${s.login_url ? `<a class="btn btn-ghost btn-sm" href="${esc(s.login_url)}" target="_blank" rel="noopener" title="Apri il sito nel browser">↗ Apri sito</a>` : ''}
      </div>
    </div>`;
}

// ── Login flow with polling ───────────────────────────────────────────────────

let loginPollInterval = null;
let loginActiveSiteId = null;

async function startLogin(siteId, siteName, loginUrl) {
  // Prevent double-login
  if (loginPollInterval) {
    if (!confirm(`Login già in corso. Interrompere l'attesa per "${siteName}"?`)) return;
    stopLoginPoll();
  }

  loginActiveSiteId = siteId;
  showLoginBanner(siteName);

  // Record current saved_at before triggering login
  let prevSavedAt = null;
  try {
    const cur = await get(`/api/sessions/${siteId}`);
    prevSavedAt = cur.saved_at;
  } catch {}

  // Trigger Playwright login (fire-and-forget on server)
  try {
    await post(`/api/sites/${siteId}/login`);
  } catch (err) {
    hideLoginBanner();
    alert(`Errore nell'avvio del login: ${err.message}`);
    return;
  }

  // Poll until saved_at changes (max 7 minutes)
  let attempts = 0;
  let consecutiveErrors = 0;
  loginPollInterval = setInterval(async () => {
    attempts++;
    if (attempts > 210) { // 7 min @ 2s
      stopLoginPoll();
      hideLoginBanner();
      alert('⏱ Timeout: il login non è stato completato entro 7 minuti.');
      return;
    }
    try {
      const s = await get(`/api/sessions/${siteId}`);
      consecutiveErrors = 0;
      if (s.saved_at && s.saved_at !== prevSavedAt) {
        stopLoginPoll();
        hideLoginBanner(true);
        // Aggiorna la card nella pagina Accessi SPID
        if (typeof loadSessions === 'function' && document.getElementById('section-sessions')?.classList.contains('active')) {
          loadSessions();
        } else {
          const card = document.getElementById(`sess-card-${siteId}`);
          if (card) card.outerHTML = renderSessionCard(s);
        }
        updateSpidAlert();
      }
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) { // 10s of consecutive errors → give up
        stopLoginPoll();
        hideLoginBanner();
      }
    }
  }, 2000);
}

function stopLoginPoll() {
  if (loginPollInterval) { clearInterval(loginPollInterval); loginPollInterval = null; }
  loginActiveSiteId = null;
}

function showLoginBanner(siteName) {
  document.getElementById('login-banner-site').textContent = `Login SPID — ${siteName}`;
  document.getElementById('login-banner').classList.remove('hidden');
}

function hideLoginBanner(success = false) {
  const banner = document.getElementById('login-banner');
  if (success) {
    banner.classList.add('login-banner-success');
    setTimeout(() => {
      banner.classList.remove('login-banner-success');
      banner.classList.add('hidden');
    }, 3000);
  } else {
    banner.classList.add('hidden');
  }
}

document.getElementById('login-banner-cancel').addEventListener('click', () => {
  stopLoginPoll();
  hideLoginBanner();
});

// ── Info (chiave-valore) ──────────────────────────────────────────────────────

let _infoModule = null;

document.getElementById('btn-info-refresh').addEventListener('click', () => loadInfo(_infoModule, true));

async function loadInfo(modulePath, force = false) {
  _infoModule = modulePath;
  const grid  = document.getElementById('info-grid');
  const title = document.getElementById('info-section-title');

  // Aggiorna titolo con il label del job
  title.textContent = JOB_LABELS[modulePath] || modulePath || 'Informazioni';

  grid.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';

  try {
    const sites = await get('/api/sites');
    const site  = sites.find(s => s.module_path === modulePath);
    if (!site) {
      grid.innerHTML = '<div style="padding:24px;color:var(--color-text-muted)">Sito non trovato.</div>';
      return;
    }

    // Leggi i risultati grezzi via endpoint standard
    const data = await get(`/api/results?siteId=${site.id}&limit=200`);
    const rows = data.results || [];

    if (!rows.length) {
      grid.innerHTML = '<div style="padding:24px;color:var(--color-text-muted)">Nessun dato — esegui il job prima.</div>';
      return;
    }

    // Raggruppa per sezione (campo "section" nel rawJson)
    const sections = {};
    for (const row of rows) {
      let raw = {};
      try { raw = JSON.parse(row.raw_json || '{}'); } catch {}
      const section = raw.section || 'Dati';
      if (!sections[section]) sections[section] = [];

      const key   = raw.key   || row.title   || row.external_id;
      const value = raw.value || raw.text    || '';
      if (key && !key.startsWith('_')) sections[section].push({ key, value });
    }

    grid.innerHTML = Object.entries(sections).map(([sec, items]) => `
      <div class="info-kv-section">
        <h3 class="info-kv-heading">${esc(sec.charAt(0).toUpperCase() + sec.slice(1))}</h3>
        <div class="info-kv-cards">
          ${items.map(({ key, value }) => `
            <div class="info-kv-card">
              <div class="info-kv-label">${esc(key)}</div>
              <div class="info-kv-value">${esc(value)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

  } catch (err) {
    grid.innerHTML = `<div style="color:var(--color-danger);padding:24px">Errore: ${esc(err.message)}</div>`;
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

async function loadAdmin() {
  const grid = document.getElementById('admin-agents-grid');
  grid.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--color-text-muted)">Caricamento...</div>';
  try {
    const agents = await get('/api/agents');
    if (!agents.length) {
      grid.innerHTML = '<div style="padding:24px;color:var(--color-text-muted)">Nessun agente trovato.</div>';
      return;
    }
    grid.innerHTML = agents.map(agent => `
      <div class="admin-agent-card">
        <div class="admin-agent-header">
          <span class="admin-agent-icon">${agent.icon}</span>
          <div class="admin-agent-info">
            <div class="admin-agent-name">${esc(agent.service)}</div>
            <div class="admin-agent-meta">${agent.jobs.length} job${agent.jobs.length !== 1 ? 's' : ''}${agent.auth_type === 'spid' ? ' · SPID' : ''}</div>
          </div>
          <div class="admin-agent-actions">
            <button class="btn btn-sm btn-secondary" onclick="exportAgent('${esc(agent._key)}')">⬇ Esporta</button>
            <button class="btn btn-sm btn-danger"    onclick="deleteAgent('${esc(agent._key)}', '${esc(agent.service)}')">🗑</button>
          </div>
        </div>
        <ul class="admin-job-list">
          ${agent.jobs.map(job => `
            <li class="admin-job-item">
              <span class="admin-job-label">${esc(job.label)}</span>
              <span class="admin-job-type badge badge-none">${job.view?.type || '-'}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--color-danger);padding:24px">Errore: ${esc(err.message)}</div>`;
  }
}

async function exportAgent(key) {
  try {
    const agents = await get('/api/agents');
    const agent = agents.find(a => a._key === key);
    if (!agent) { alert('Agente non trovato'); return; }
    const { _key, ...clean } = agent;
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${key}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Errore esportazione: ${err.message}`);
  }
}

async function deleteAgent(key, name) {
  if (!confirm(`Eliminare l'agente "${name}"? Il file sites/${key}.json verrà rimosso.`)) return;
  try {
    await del(`/api/agents/${key}`);
    loadAdmin();
  } catch (err) {
    alert(`Errore: ${err.message}`);
  }
}

document.getElementById('btn-import-agent').addEventListener('click', () => {
  document.getElementById('input-import-agent').click();
});

document.getElementById('input-import-agent').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('admin-import-status');
  e.target.value = '';
  try {
    const agent = JSON.parse(await file.text());
    if (!agent.service || !Array.isArray(agent.jobs)) {
      showAlert(statusEl, 'error', 'File non valido: deve avere "service" e "jobs".');
      return;
    }
    await post('/api/agents/import', agent);
    showAlert(statusEl, 'success', `Agente "${agent.service}" importato.`);
    loadAdmin();
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  } catch (err) {
    showAlert(statusEl, 'error', `Errore importazione: ${err.message}`);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

navigate('sites');
