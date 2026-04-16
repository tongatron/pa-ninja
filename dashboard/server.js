'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { initDb, getDb, getSites, getRuns, getResults,
        getLibretto, getLatestCarriera } = require('../core/db');

const PORT = process.env.PORT || 3001;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init + seed ────────────────────────────────────────────────────────────

const db = initDb();

// Seed siti iniziali se la tabella è vuota
const siteCount = db.prepare('SELECT COUNT(*) AS cnt FROM sites').get().cnt;
if (siteCount === 0) {
  db.prepare(`INSERT INTO sites (name, url, module_path, auth_type, enabled) VALUES (?, ?, ?, ?, ?)`)
    .run('Lavoro Piemonte',
         'https://pslp.regione.piemonte.it/pslpwcl/pslpfcweb/consulta-annunci/profili-ricercati',
         'lavoro-piemonte', 'none', 1);
  db.prepare(`INSERT INTO sites (name, url, module_path, auth_type, enabled) VALUES (?, ?, ?, ?, ?)`)
    .run('ESSE3 UniTo',
         'https://esse3.unito.it/auth/studente/HomePageStudente.do',
         'esse3-unito', 'spid', 1);
  console.log('Seeded initial sites: Lavoro Piemonte, ESSE3 UniTo');
} else {
  // Aggiungi ESSE3 UniTo se non esiste ancora
  const hasEsse3 = db.prepare(`SELECT id FROM sites WHERE module_path = 'esse3-unito'`).get();
  if (!hasEsse3) {
    db.prepare(`INSERT INTO sites (name, url, module_path, auth_type, enabled) VALUES (?, ?, ?, ?, ?)`)
      .run('ESSE3 UniTo',
           'https://esse3.unito.it/auth/studente/HomePageStudente.do',
           'esse3-unito', 'spid', 1);
    console.log('Seeded site: ESSE3 UniTo');
  }
}

// Fix stale 'running' runs from previous sessions
db.prepare(`UPDATE runs SET status='failed', error='Interrotta (riavvio server)', finished_at=datetime('now') WHERE status='running'`).run();

// ── In-memory run status tracking ─────────────────────────────────────────────
// runId -> { status, siteId, startedAt, error? }
const activeRuns = new Map();

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/sites
app.get('/api/sites', (req, res) => {
  try {
    res.json(getSites());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sites
app.post('/api/sites', (req, res) => {
  try {
    const { name, url, modulePath, authType } = req.body;
    if (!name || !url || !modulePath) {
      return res.status(400).json({ error: 'name, url, modulePath are required' });
    }
    const result = db.prepare(`
      INSERT INTO sites (name, url, module_path, auth_type, enabled)
      VALUES (?, ?, ?, ?, 1)
    `).run(name, url, modulePath, authType || 'none');
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sites/:id
app.put('/api/sites/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, url, modulePath, authType, enabled } = req.body;
    db.prepare(`
      UPDATE sites SET
        name        = COALESCE(?, name),
        url         = COALESCE(?, url),
        module_path = COALESCE(?, module_path),
        auth_type   = COALESCE(?, auth_type),
        enabled     = COALESCE(?, enabled)
      WHERE id = ?
    `).run(name, url, modulePath, authType, enabled != null ? Number(enabled) : null, id);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sites/:id
app.delete('/api/sites/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sites/:id/runs
app.get('/api/sites/:id/runs', (req, res) => {
  try {
    const runs = getRuns(Number(req.params.id));
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sites/:id/run  — launch manual run (async)
app.post('/api/sites/:id/run', async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Create pending run record
    const runId = db.prepare(`
      INSERT INTO runs (site_id, started_at, status)
      VALUES (?, datetime('now'), 'running')
    `).run(siteId).lastInsertRowid;

    activeRuns.set(runId, { status: 'running', siteId, startedAt: new Date().toISOString() });
    res.status(202).json({ runId, status: 'running' });

    // Run async (fire-and-forget)
    setImmediate(async () => {
      try {
        const { runSite } = require('../core/runner');
        const result = await runSite(db, site, runId);
        activeRuns.set(runId, {
          status: result.success ? 'ok' : 'error',
          siteId,
          totalResults: result.totalResults,
          newResults: result.newResults,
          error: result.error || null,
        });
      } catch (err) {
        // Ensure DB run record is also marked failed (e.g. session missing before run insert)
        db.prepare(`UPDATE runs SET status='error', error=?, finished_at=datetime('now') WHERE id=? AND status='running'`)
          .run(err.message, runId);
        activeRuns.set(runId, { status: 'error', siteId, error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/run-all — launch all sites
app.post('/api/run-all', async (req, res) => {
  try {
    const sites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all();
    if (sites.length === 0) return res.status(200).json({ message: 'No enabled sites' });

    const runIds = [];
    for (const site of sites) {
      const runId = db.prepare(`
        INSERT INTO runs (site_id, started_at, status)
        VALUES (?, datetime('now'), 'running')
      `).run(site.id).lastInsertRowid;
      runIds.push(runId);
      activeRuns.set(runId, { status: 'running', siteId: site.id });
    }

    res.status(202).json({ runIds, status: 'running' });

    setImmediate(async () => {
      const { runSite } = require('../core/runner');
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        const runId = runIds[i];
        try {
          const result = await runSite(db, site, runId);
          activeRuns.set(runId, {
            status: result.success ? 'ok' : 'error',
            siteId: site.id,
            totalResults: result.totalResults,
            newResults: result.newResults,
            error: result.error || null,
          });
        } catch (err) {
          db.prepare(`UPDATE runs SET status='error', error=?, finished_at=datetime('now') WHERE id=? AND status='running'`)
            .run(err.message, runId);
          activeRuns.set(runId, { status: 'error', siteId: site.id, error: err.message });
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/:runId/status
app.get('/api/runs/:runId/status', (req, res) => {
  try {
    const runId = Number(req.params.runId);
    // Check in-memory first (may be more up-to-date for active runs)
    if (activeRuns.has(runId)) {
      return res.json({ runId, ...activeRuns.get(runId) });
    }
    // Fall back to DB
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/results
app.get('/api/results', (req, res) => {
  try {
    const { siteId, province, keyword, expiresAfter, newOnly, page, limit } = req.query;
    const result = getResults({
      siteId: siteId ? Number(siteId) : undefined,
      province: province || undefined,
      keyword: keyword || undefined,
      expiresAfter: expiresAfter || undefined,
      newOnly: newOnly === 'true',
      page: page ? Number(page) : 1,
      limit: limit ? Math.min(Number(limit), 200) : 50,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/results/provinces
app.get('/api/results/provinces', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT DISTINCT province FROM results WHERE province IS NOT NULL ORDER BY province'
    ).all();
    res.json(rows.map(r => r.province));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sites/:id/login — launch SPID login (Playwright headful)
app.post('/api/sites/:id/login', (req, res) => {
  try {
    const siteId = Number(req.params.id);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    res.status(202).json({
      message: 'SPID login started. A browser window will open. Complete the login there.',
      instructions: `Run: node core/session.js login --site "${site.name}"`
    });

    // Launch async
    setImmediate(async () => {
      try {
        const { login } = require('../core/session');
        await login(site.name);
        console.log(`SPID login completed for ${site.name}`);
      } catch (err) {
        console.error(`SPID login failed for ${site.name}:`, err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages — messaggi PiemonteTu
app.get('/api/messages', (req, res) => {
  try {
    const { unread, sender, keyword, newOnly } = req.query;

    const site = db.prepare("SELECT id FROM sites WHERE module_path = 'piemonte-tu-messaggi'").get();
    if (!site) return res.json([]);

    const rows = db.prepare(`
      SELECT *,
        CASE WHEN first_seen_at >= (
          SELECT started_at FROM runs
          WHERE site_id = ? AND status = 'ok'
          ORDER BY started_at DESC LIMIT 1
        ) THEN 1 ELSE 0 END AS is_new
      FROM results
      WHERE site_id = ?
      ORDER BY is_new DESC, last_seen_at DESC
    `).all(site.id, site.id);

    let messages = rows.map(r => {
      let raw = {};
      try { raw = JSON.parse(r.raw_json || '{}'); } catch {}
      return { ...r, raw };
    });

    if (unread === 'true')  messages = messages.filter(m => !m.raw.read_at);
    if (unread === 'false') messages = messages.filter(m =>  !!m.raw.read_at);
    if (newOnly === 'true') messages = messages.filter(m => m.is_new);
    if (sender) {
      const s = sender.toLowerCase();
      messages = messages.filter(m => (m.raw.sender || '').toLowerCase().includes(s));
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      messages = messages.filter(m =>
        (m.raw.title || '').toLowerCase().includes(kw) ||
        (m.raw.body  || '').toLowerCase().includes(kw)
      );
    }

    res.json(messages.map(m => ({
      id:             m.id,
      external_id:    m.external_id,
      title:          m.raw.title   || m.title || '(senza titolo)',
      body:           m.raw.body    || '',
      sender:         m.raw.sender  || '',
      tag:            m.raw.tag     || '',
      timestamp:      m.raw.timestamp    || '',
      read_at:        m.raw.read_at      || null,
      call_to_action: m.raw.call_to_action || null,
      first_seen_at:  m.first_seen_at,
      is_new:         m.is_new === 1,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: enrich session row ────────────────────────────────────────────────

function enrichSession(r) {
  let loginUrl = null;
  try {
    const modPath = path.join(__dirname, '..', 'sites', `${r.module_path}.js`);
    const mod = require(modPath);
    loginUrl = mod.meta?.loginUrl || null;
  } catch {}

  let status = 'none';
  let sessionAgeHours = null;
  let cookieCount = 0;

  if (r.saved_at) {
    // SQLite datetime('now') = UTC senza 'Z' → aggiunge Z per parsing corretto
    const ageMs = Date.now() - new Date(r.saved_at.replace(' ', 'T') + 'Z').getTime();
    sessionAgeHours = Math.round(ageMs / 360000) / 10;
    if (r.cookies) { try { cookieCount = JSON.parse(r.cookies).length; } catch {} }
    if (sessionAgeHours < 0.5)    status = 'fresh';    // < 30 min
    else if (sessionAgeHours < 2) status = 'ok';       // < 2h
    else if (sessionAgeHours < 8) status = 'warning';  // < 8h
    else                          status = 'expired';
  }

  return {
    site_id:           r.site_id,
    site_name:         r.site_name,
    module_path:       r.module_path,
    auth_type:         r.auth_type,
    login_url:         loginUrl,
    saved_at:          r.saved_at || null,
    session_age_hours: sessionAgeHours,
    cookie_count:      cookieCount,
    status,
  };
}

// GET /api/sessions
app.get('/api/sessions', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id AS site_id, s.name AS site_name, s.module_path,
             s.auth_type, se.saved_at, se.cookies
      FROM sites s
      LEFT JOIN sessions se ON se.site_id = s.id
      WHERE s.auth_type != 'none'
      ORDER BY s.name
    `).all();
    res.json(rows.map(enrichSession));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:siteId — per polling dopo login
app.get('/api/sessions/:siteId', (req, res) => {
  try {
    const siteId = Number(req.params.siteId);
    const row = db.prepare(`
      SELECT s.id AS site_id, s.name AS site_name, s.module_path,
             s.auth_type, se.saved_at, se.cookies
      FROM sites s
      LEFT JOIN sessions se ON se.site_id = s.id
      WHERE s.id = ?
    `).get(siteId);
    if (!row) return res.status(404).json({ error: 'Site not found' });
    res.json(enrichSession(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UniTo endpoints ───────────────────────────────────────────────────────────

// GET /api/unito/libretto
app.get('/api/unito/libretto', (req, res) => {
  try {
    const exams = getLibretto();
    res.json({ exams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/unito/carriera
app.get('/api/unito/carriera', (req, res) => {
  try {
    const carriera = getLatestCarriera();
    res.json(carriera || { data: {}, scraped_at: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats endpoint for dashboard ──────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const activeSites = db.prepare('SELECT COUNT(*) AS cnt FROM sites WHERE enabled = 1').get().cnt;
    const lastRun = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
    const newToday = db.prepare(`
      SELECT COUNT(*) AS cnt FROM results
      WHERE first_seen_at >= date('now')
    `).get().cnt;
    const totalResults = db.prepare('SELECT COUNT(*) AS cnt FROM results').get().cnt;

    // SPID sites that have no session or session older than 8h
    const spidSites = db.prepare(`
      SELECT s.id, s.name, se.saved_at
      FROM sites s
      LEFT JOIN sessions se ON se.site_id = s.id
      WHERE s.auth_type != 'none' AND s.enabled = 1
    `).all();
    const spidNeedAuth = spidSites.filter(s => {
      if (!s.saved_at) return true;
      // SQLite datetime('now') è UTC senza 'Z' → aggiunge Z per parsing corretto
      const ageHours = (Date.now() - new Date(s.saved_at.replace(' ', 'T') + 'Z').getTime()) / 3600000;
      return ageHours >= 8;
    });

    res.json({ activeSites, lastRun, newToday, totalResults, spidNeedAuth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agents ────────────────────────────────────────────────────────────────────

// GET /api/agents — lista agenti da sites/*.json
app.get('/api/agents', (req, res) => {
  try {
    const sitesDir = path.join(__dirname, '..', 'sites');
    const files = fs.readdirSync(sitesDir).filter(f => f.endsWith('.json'));
    const agents = files.map(f => {
      try {
        const agent = JSON.parse(fs.readFileSync(path.join(sitesDir, f), 'utf8'));
        agent._key = f.replace('.json', '');
        return agent;
      } catch { return null; }
    }).filter(Boolean);
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/import — salva un nuovo agente in sites/
app.post('/api/agents/import', (req, res) => {
  try {
    const agent = req.body;
    if (!agent || !agent.service || !Array.isArray(agent.jobs)) {
      return res.status(400).json({ error: 'Formato non valido: mancano service o jobs' });
    }
    const rawKey = agent._key || agent.service.toLowerCase()
      .replace(/[àáâ]/g, 'a').replace(/[èéê]/g, 'e')
      .replace(/[ìíî]/g, 'i').replace(/[òóô]/g, 'o').replace(/[ùúû]/g, 'u')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const sitesDir = path.join(__dirname, '..', 'sites');
    const filePath = path.resolve(sitesDir, `${rawKey}.json`);
    if (!filePath.startsWith(path.resolve(sitesDir))) {
      return res.status(400).json({ error: 'Nome non valido' });
    }
    const { _key, ...clean } = agent;
    fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), 'utf8');
    res.json({ ok: true, key: rawKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/agents/:key — elimina un agente da sites/
app.delete('/api/agents/:key', (req, res) => {
  try {
    const key = req.params.key.replace(/[^a-z0-9-]/g, '');
    const sitesDir = path.join(__dirname, '..', 'sites');
    const filePath = path.resolve(sitesDir, `${key}.json`);
    if (!filePath.startsWith(path.resolve(sitesDir)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Agente non trovato' });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`PA-Scraping dashboard running at http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORT} già in uso.\nChiudi l'altro processo con:\n  pkill -f "node dashboard/server.js"\noppure usa una porta diversa:\n  PORT=3002 npm start\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
