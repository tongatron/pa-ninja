'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { initDb, getDb, getSites, getRuns, getResults } = require('../core/db');

const PORT = process.env.PORT || 3001;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init + seed ────────────────────────────────────────────────────────────

const db = initDb();

// Seed lavoro-piemonte if sites table is empty
const siteCount = db.prepare('SELECT COUNT(*) AS cnt FROM sites').get().cnt;
if (siteCount === 0) {
  db.prepare(`
    INSERT INTO sites (name, url, module_path, schedule, auth_type, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'Lavoro Piemonte',
    'https://pslp.regione.piemonte.it/pslpwcl/pslpfcweb/consulta-annunci/profili-ricercati',
    'lavoro-piemonte',
    '0 8,14 * * *',
    'none',
    1
  );
  console.log('Seeded initial site: Lavoro Piemonte');
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
    const { name, url, modulePath, schedule, authType } = req.body;
    if (!name || !url || !modulePath) {
      return res.status(400).json({ error: 'name, url, modulePath are required' });
    }
    const result = db.prepare(`
      INSERT INTO sites (name, url, module_path, schedule, auth_type, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(name, url, modulePath, schedule || null, authType || 'none');
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
    const { name, url, modulePath, schedule, authType, enabled } = req.body;
    db.prepare(`
      UPDATE sites SET
        name        = COALESCE(?, name),
        url         = COALESCE(?, url),
        module_path = COALESCE(?, module_path),
        schedule    = COALESCE(?, schedule),
        auth_type   = COALESCE(?, auth_type),
        enabled     = COALESCE(?, enabled)
      WHERE id = ?
    `).run(name, url, modulePath, schedule, authType, enabled != null ? Number(enabled) : null, id);
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
        const result = await runSite(db, site);
        activeRuns.set(runId, {
          status: result.success ? 'ok' : 'error',
          siteId,
          totalResults: result.totalResults,
          newResults: result.newResults,
          error: result.error || null,
        });
      } catch (err) {
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
          const result = await runSite(db, site);
          activeRuns.set(runId, {
            status: result.success ? 'ok' : 'error',
            siteId: site.id,
            totalResults: result.totalResults,
            newResults: result.newResults,
            error: result.error || null,
          });
        } catch (err) {
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
    const { siteId, province, keyword, expiresAfter, page, limit } = req.query;
    const result = getResults({
      siteId: siteId ? Number(siteId) : undefined,
      province: province || undefined,
      keyword: keyword || undefined,
      expiresAfter: expiresAfter || undefined,
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

// GET /api/sessions
app.get('/api/sessions', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id AS site_id, s.name AS site_name, se.saved_at
      FROM sites s
      LEFT JOIN sessions se ON se.site_id = s.id
      WHERE s.auth_type != 'none'
      ORDER BY s.name
    `).all();
    res.json(rows);
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
    res.json({ activeSites, lastRun, newToday, totalResults });
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
