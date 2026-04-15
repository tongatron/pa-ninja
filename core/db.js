'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'pa-scraping.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      url         TEXT NOT NULL,
      module_path TEXT NOT NULL,
      schedule    TEXT,
      auth_type   TEXT DEFAULT 'none',
      enabled     INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      started_at    TEXT DEFAULT (datetime('now')),
      finished_at   TEXT,
      status        TEXT DEFAULT 'running',
      total_results INTEGER DEFAULT 0,
      new_results   INTEGER DEFAULT 0,
      error         TEXT
    );

    CREATE TABLE IF NOT EXISTS results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      run_id        INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      external_id   TEXT NOT NULL,
      title         TEXT,
      organization  TEXT,
      location      TEXT,
      province      TEXT,
      contract_type TEXT,
      expires_at    TEXT,
      raw_json      TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(site_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      site_id   INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      cookies   TEXT NOT NULL,
      saved_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Migrazione: storage_state in sessions ─────────────────────────────────
  try { db.exec('ALTER TABLE sessions ADD COLUMN storage_state TEXT'); } catch {}

  // ── Migrazione: tabelle UniTo ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS unito_libretto (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      codice     TEXT,
      materia    TEXT NOT NULL,
      cfu        INTEGER,
      voto       TEXT,
      data_esame TEXT,
      stato      TEXT,
      settore    TEXT,
      raw_json   TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen  TEXT DEFAULT (datetime('now')),
      UNIQUE(materia, cfu)
    );

    CREATE TABLE IF NOT EXISTS unito_carriera (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scraped_at TEXT DEFAULT (datetime('now')),
      data_json  TEXT NOT NULL
    );
  `);

  return db;
}

/**
 * Upsert a single result record.
 * Returns { isNew: boolean }
 */
function upsertResult(siteId, runId, item) {
  const db = getDb();

  const existing = db.prepare(
    'SELECT id FROM results WHERE site_id = ? AND external_id = ?'
  ).get(siteId, String(item.externalId));

  if (existing) {
    db.prepare(`
      UPDATE results SET
        run_id        = ?,
        title         = ?,
        organization  = ?,
        location      = ?,
        province      = ?,
        contract_type = ?,
        expires_at    = ?,
        raw_json      = ?,
        last_seen_at  = datetime('now')
      WHERE site_id = ? AND external_id = ?
    `).run(
      runId,
      item.title || null,
      item.organization || null,
      item.location || null,
      item.province || null,
      item.contractType || null,
      item.expiresAt || null,
      item.rawJson || null,
      siteId,
      String(item.externalId)
    );
    return { isNew: false };
  } else {
    db.prepare(`
      INSERT INTO results
        (site_id, run_id, external_id, title, organization, location, province, contract_type, expires_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      siteId,
      runId,
      String(item.externalId),
      item.title || null,
      item.organization || null,
      item.location || null,
      item.province || null,
      item.contractType || null,
      item.expiresAt || null,
      item.rawJson || null
    );
    return { isNew: true };
  }
}

function getSites() {
  const db = getDb();
  const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
  const lastRunStmt = db.prepare(`
    SELECT * FROM runs
    WHERE site_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const lastOkRunStmt = db.prepare(`
    SELECT * FROM runs
    WHERE site_id = ? AND status = 'ok'
    ORDER BY started_at DESC
    LIMIT 1
  `);
  return sites.map(s => ({
    ...s,
    last_run:    lastRunStmt.get(s.id)   || null,
    last_ok_run: lastOkRunStmt.get(s.id) || null,
  }));
}

function getRuns(siteId) {
  const db = getDb();
  if (siteId) {
    return db.prepare(
      'SELECT * FROM runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 50'
    ).all(siteId);
  }
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100').all();
}

// Subquery: 1 if result appeared for the first time in the most recent completed run for its site
const IS_NEW_EXPR = `
  CASE WHEN r.first_seen_at >= (
    SELECT started_at FROM runs
    WHERE site_id = r.site_id AND status = 'ok'
    ORDER BY started_at DESC LIMIT 1
  ) THEN 1 ELSE 0 END
`.trim();

/**
 * Get results with optional filters.
 * filters: { siteId, province, keyword, expiresAfter, newOnly, page, limit }
 */
function getResults(filters = {}) {
  const db = getDb();
  const { siteId, province, keyword, expiresAfter, newOnly, page = 1, limit = 50 } = filters;

  const conditions = [];
  const params = [];

  if (siteId) { conditions.push('r.site_id = ?'); params.push(siteId); }
  if (province) { conditions.push('UPPER(r.province) = UPPER(?)'); params.push(province); }
  if (keyword) {
    conditions.push('(r.title LIKE ? OR r.organization LIKE ? OR r.location LIKE ?)');
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }
  if (expiresAfter) { conditions.push('r.expires_at >= ?'); params.push(expiresAfter); }
  if (newOnly) { conditions.push(`(${IS_NEW_EXPR}) = 1`); }

  // Escludi sempre i siti con sezione dedicata (messaggi)
  conditions.push("s.module_path != 'piemonte-tu-messaggi'");

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const rows = db.prepare(`
    SELECT r.*, s.name AS site_name, (${IS_NEW_EXPR}) AS is_new
    FROM results r
    JOIN sites s ON s.id = r.site_id
    ${where}
    ORDER BY is_new DESC, r.last_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt FROM results r
    JOIN sites s ON s.id = r.site_id
    ${where}
  `).get(...params).cnt;

  return { rows, total, page, limit };
}

// ── UniTo helpers ──────────────────────────────────────────────────────────────

function upsertLibrettoExam(runId, exam) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM unito_libretto WHERE materia = ? AND cfu = ?'
  ).get(exam.materia, exam.cfu ?? null);

  if (existing) {
    db.prepare(`
      UPDATE unito_libretto SET
        run_id = ?, codice = ?, voto = ?, data_esame = ?,
        stato = ?, settore = ?, raw_json = ?, last_seen = datetime('now')
      WHERE id = ?
    `).run(runId, exam.codice ?? null, exam.voto ?? null, exam.data_esame ?? null,
           exam.stato ?? null, exam.settore ?? null, JSON.stringify(exam), existing.id);
    return { isNew: false };
  } else {
    db.prepare(`
      INSERT INTO unito_libretto (run_id, codice, materia, cfu, voto, data_esame, stato, settore, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, exam.codice ?? null, exam.materia, exam.cfu ?? null,
           exam.voto ?? null, exam.data_esame ?? null, exam.stato ?? null,
           exam.settore ?? null, JSON.stringify(exam));
    return { isNew: true };
  }
}

function saveCarriera(data) {
  const db = getDb();
  db.prepare(`INSERT INTO unito_carriera (data_json) VALUES (?)`).run(JSON.stringify(data));
  // Tieni solo gli ultimi 10 snapshot
  db.prepare(`
    DELETE FROM unito_carriera WHERE id NOT IN (
      SELECT id FROM unito_carriera ORDER BY scraped_at DESC LIMIT 10
    )
  `).run();
}

function getLibretto() {
  return getDb().prepare(`
    SELECT * FROM unito_libretto ORDER BY
      CASE WHEN stato LIKE '%superato%' OR stato LIKE '%Superato%' THEN 0 ELSE 1 END,
      data_esame DESC
  `).all();
}

function getLatestCarriera() {
  const row = getDb().prepare(
    'SELECT * FROM unito_carriera ORDER BY scraped_at DESC LIMIT 1'
  ).get();
  if (!row) return null;
  try { return { scraped_at: row.scraped_at, data: JSON.parse(row.data_json) }; }
  catch { return { scraped_at: row.scraped_at, data: {} }; }
}

module.exports = {
  getDb, initDb, upsertResult, getSites, getRuns, getResults,
  upsertLibrettoExam, saveCarriera, getLibretto, getLatestCarriera,
};
