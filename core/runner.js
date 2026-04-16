'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initDb, getDb, upsertResult } = require('./db');
const { getSession } = require('./session');

// ── CLI argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const siteArg = (() => {
  const i = args.indexOf('--site');
  return i !== -1 ? args[i + 1] : null;
})();
const dryRun = args.includes('--dry-run');

// ── Core runner logic ─────────────────────────────────────────────────────────

async function runSite(db, site, existingRunId = null) {
  const modulePath = path.join(__dirname, '..', 'sites', `${site.module_path}.js`);
  let siteModule;
  try {
    siteModule = require(modulePath);
  } catch (err) {
    throw new Error(`Cannot load module for site "${site.name}": ${err.message}`);
  }

  // Load session if site requires auth.
  // Se il modulo definisce meta.authSite, usa quella sessione condivisa
  // (utile per job multipli sotto lo stesso login, es. tutti i job INPS).
  let session = null;
  // Carica sessione se: auth_type != none  OPPURE  il modulo definisce meta.authSite
  const authSiteName = siteModule.meta?.authSite || (site.auth_type !== 'none' ? site.name : null);
  if (authSiteName) {
    try {
      session = getSession(authSiteName);
    } catch (err) {
      throw new Error(`Sessione non disponibile per "${authSiteName}": ${err.message}. Vai in Accessi SPID e autenticati prima di eseguire.`);
    }
  }

  // Use pre-created run record if provided (from server), otherwise create one
  let runId;
  if (existingRunId) {
    runId = existingRunId;
  } else {
    runId = dryRun ? null : db.prepare(`
      INSERT INTO runs (site_id, started_at, status)
      VALUES (?, datetime('now'), 'running')
    `).run(site.id).lastInsertRowid;
  }

  console.log(`[${site.name}] Starting run${dryRun ? ' (DRY RUN)' : ` #${runId}`}...`);

  let totalResults = 0;
  let newResults = 0;

  try {
    const items = await siteModule.run(db, site.id, session);

    if (!Array.isArray(items)) {
      throw new Error('Site module run() must return an array');
    }

    totalResults = items.length;

    if (!dryRun) {
      for (const item of items) {
        const { isNew } = upsertResult(site.id, runId, item);
        if (isNew) newResults++;
      }

      // Update run record
      db.prepare(`
        UPDATE runs SET
          finished_at   = datetime('now'),
          status        = 'ok',
          total_results = ?,
          new_results   = ?
        WHERE id = ?
      `).run(totalResults, newResults, runId);
    }

    console.log(`[${site.name}] Done. Total: ${totalResults}, New: ${newResults}${dryRun ? ' (not saved)' : ''}`);
    return { success: true, totalResults, newResults, runId };
  } catch (err) {
    console.error(`[${site.name}] Error: ${err.message}`);

    if (!dryRun && runId) {
      db.prepare(`
        UPDATE runs SET
          finished_at = datetime('now'),
          status      = 'error',
          error       = ?
        WHERE id = ?
      `).run(err.message, runId);
    }

    return { success: false, error: err.message, runId };
  }
}

async function runAll(db, siteNameFilter) {
  const sites = db.prepare(
    'SELECT * FROM sites WHERE enabled = 1' +
    (siteNameFilter ? ' AND (name = ? OR module_path = ?)' : '')
  ).all(...(siteNameFilter ? [siteNameFilter, siteNameFilter] : []));

  if (sites.length === 0) {
    console.log('No enabled sites found' + (siteNameFilter ? ` matching "${siteNameFilter}"` : ''));
    return;
  }

  console.log(`Running ${sites.length} site(s)...`);

  const results = [];
  for (const site of sites) {
    const result = await runSite(db, site);
    results.push({ site: site.name, ...result });
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.success) {
      console.log(`  ✓ ${r.site}: ${r.totalResults} results, ${r.newResults} new`);
    } else {
      console.log(`  ✗ ${r.site}: FAILED - ${r.error}`);
    }
  }

  return results;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const db = initDb();
  runAll(db, siteArg)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
}

module.exports = { runSite, runAll };
