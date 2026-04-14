'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDb } = require('./db');

// ── Session fetch wrapper ─────────────────────────────────────────────────────

function getSession(siteName) {
  const db = getDb();

  const site = db.prepare('SELECT * FROM sites WHERE name = ? OR module_path = ?').get(siteName, siteName);
  if (!site) throw new Error(`Site not found: ${siteName}`);

  const sessionRow = db.prepare('SELECT * FROM sessions WHERE site_id = ?').get(site.id);
  if (!sessionRow) throw new Error(`No session saved for site: ${siteName}. Run "node core/session.js login --site ${siteName}" first.`);

  let cookies;
  try {
    cookies = JSON.parse(sessionRow.cookies);
  } catch {
    throw new Error('Invalid session cookies stored in DB');
  }

  const cookieHeader = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  return {
    cookies,
    cookieHeader,
    savedAt: sessionRow.saved_at,

    async fetch(url, opts = {}) {
      const headers = {
        ...(opts.headers || {}),
        Cookie: cookieHeader,
      };
      return fetch(url, { ...opts, headers });
    }
  };
}

// ── SPID Login via Playwright ─────────────────────────────────────────────────

async function login(siteName) {
  const { chromium } = require('playwright');
  const db = getDb();

  const site = db.prepare('SELECT * FROM sites WHERE name = ? OR module_path = ?').get(siteName, siteName);
  if (!site) {
    throw new Error(`Site not found: "${siteName}". Add it via the dashboard or DB first.`);
  }

  const siteModule = require(path.join(__dirname, '..', 'sites', `${site.module_path}.js`));
  const meta = siteModule.meta || {};

  const loginUrl = meta.loginUrl || site.url;
  const successPattern = meta.loginSuccessPattern
    ? new RegExp(meta.loginSuccessPattern)
    : null;

  console.log(`Opening browser for SPID login on: ${site.name}`);
  console.log(`URL: ${loginUrl}`);
  console.log('Complete the SPID login in the browser window. The session will be saved automatically.');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(loginUrl);

  // Poll until login is detected
  await new Promise((resolve, reject) => {
    let checks = 0;
    const maxChecks = 360; // 6 minutes timeout

    const interval = setInterval(async () => {
      checks++;
      if (checks > maxChecks) {
        clearInterval(interval);
        reject(new Error('Login timeout after 6 minutes'));
        return;
      }

      try {
        const currentUrl = page.url();

        let loggedIn = false;
        if (successPattern) {
          loggedIn = successPattern.test(currentUrl);
        } else {
          // Default: logged in when URL no longer contains login-related paths
          loggedIn = !currentUrl.includes('/login') &&
                     !currentUrl.includes('/auth') &&
                     !currentUrl.includes('/spid') &&
                     !currentUrl.includes('/sso') &&
                     currentUrl !== loginUrl;
        }

        if (loggedIn) {
          clearInterval(interval);
          resolve();
        }
      } catch (err) {
        // Page might be navigating, ignore transient errors
      }
    }, 1000);
  });

  console.log('Login detected! Saving session cookies...');

  const cookies = await context.cookies();
  await browser.close();

  // Save to DB
  db.prepare(`
    INSERT INTO sessions (site_id, cookies, saved_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(site_id) DO UPDATE SET
      cookies  = excluded.cookies,
      saved_at = excluded.saved_at
  `).run(site.id, JSON.stringify(cookies));

  console.log(`Session saved for "${site.name}" (${cookies.length} cookies)`);
  return cookies;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0]; // 'login'
  const siteIdx = args.indexOf('--site');
  const siteName = siteIdx !== -1 ? args[siteIdx + 1] : null;

  if (command === 'login') {
    if (!siteName) {
      console.error('Usage: node core/session.js login --site <siteName>');
      process.exit(1);
    }
    login(siteName)
      .then(() => process.exit(0))
      .catch(err => {
        console.error('Login failed:', err.message);
        process.exit(1);
      });
  } else {
    console.error('Unknown command. Use: node core/session.js login --site <name>');
    process.exit(1);
  }
}

module.exports = { getSession, login };
