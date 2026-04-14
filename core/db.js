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
  return sites.map(s => ({
    ...s,
    last_run: lastRunStmt.get(s.id) || null
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

/**
 * Get results with optional filters.
 * filters: { siteId, province, keyword, expiresAfter, page, limit }
 */
function getResults(filters = {}) {
  const db = getDb();
  const { siteId, province, keyword, expiresAfter, page = 1, limit = 50 } = filters;

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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const rows = db.prepare(`
    SELECT r.*, s.name AS site_name
    FROM results r
    JOIN sites s ON s.id = r.site_id
    ${where}
    ORDER BY r.last_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt FROM results r ${where}
  `).get(...params).cnt;

  return { rows, total, page, limit };
}

module.exports = { getDb, initDb, upsertResult, getSites, getRuns, getResults };
