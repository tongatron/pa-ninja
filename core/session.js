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

  let storageState = null;
  if (sessionRow.storage_state) {
    try { storageState = JSON.parse(sessionRow.storage_state); } catch {}
  }

  const cookieHeader = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  return {
    cookies,
    storageState,
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

  // Poll until login is detected:
  // Strategy: wait until URL leaves the login/spid/sso flow AND
  // the page has meaningful session cookies (not just the initial page load).
  await new Promise((resolve, reject) => {
    let checks = 0;
    const maxChecks = 360; // 6 minutes timeout
    let initialUrl = null;
    const targetHost = new URL(loginUrl).hostname;

    // SPID login always passes through an external IdP domain.
    // We track this to avoid false positives: the successPattern must
    // match ONLY AFTER the browser has left the target domain at least once
    // (i.e. gone through SPID/SSO provider). Without this flag, a site
    // that serves cookies on initial page load (before login) would be
    // detected as logged-in immediately.
    let everLeftTargetDomain = false;

    const interval = setInterval(async () => {
      checks++;
      if (checks > maxChecks) {
        clearInterval(interval);
        reject(new Error('Login timeout after 6 minutes'));
        return;
      }

      try {
        const currentUrl = page.url();

        // Save initial URL on first check, skip detection
        if (checks === 1) {
          initialUrl = currentUrl;
          console.log(`Initial URL: ${initialUrl}`);
          return;
        }

        const cookies = await context.cookies();

        // Only count cookies from the target domain (not SPID/Shibboleth IdP cookies)
        const appCookies = cookies.filter(c =>
          c.domain.includes(targetHost) &&
          !c.name.startsWith('_shib') &&
          !c.name.startsWith('_opensaml') &&
          !c.name.startsWith('_shibstate')
        );

        const onTargetDomain = currentUrl.includes(targetHost);

        // Track if browser has ever visited an external (SPID/IdP) domain
        if (!onTargetDomain) everLeftTargetDomain = true;

        const urlChanged = currentUrl !== initialUrl;
        const notAuthPage = !currentUrl.includes('/login') &&
                            !currentUrl.includes('/auth') &&
                            !currentUrl.includes('/spid') &&
                            !currentUrl.includes('/sso') &&
                            !currentUrl.includes('agid') &&
                            !currentUrl.includes('idp') &&
                            !currentUrl.includes('identity');
        // Require at least 1 real app cookie from the target domain
        const hasAppCookies = appCookies.length >= 1;

        let loggedIn = false;
        if (successPattern) {
          // Require the browser to have passed through an external auth domain
          // (SPID provider) at least once — prevents false positives when the
          // target page sets cookies on initial load before any authentication.
          loggedIn = everLeftTargetDomain && successPattern.test(currentUrl) && onTargetDomain && hasAppCookies;
        } else {
          loggedIn = urlChanged && onTargetDomain && notAuthPage && hasAppCookies;
        }

        if (checks % 5 === 0) {
          console.log(`[${checks}s] URL: ${currentUrl.slice(0, 80)} | all cookies: ${cookies.length} | app cookies: ${appCookies.length} | changed: ${urlChanged} | leftDomain: ${everLeftTargetDomain}`);
        }

        if (loggedIn) {
          clearInterval(interval);
          // Extra wait to ensure all cookies are set
          setTimeout(resolve, 2000);
        }
      } catch (err) {
        // Page might be navigating, ignore transient errors
      }
    }, 1000);
  });

  console.log('Login detected! Saving session cookies...');

  // Breve attesa extra per assicurarsi che tutti i cookie finali siano impostati
  await page.waitForLoadState('networkidle').catch(() => {});

  const cookies = await context.cookies();
  const storageState = await context.storageState();

  console.log(`Captured ${cookies.length} cookies from domains: ${[...new Set(cookies.map(c => c.domain))].join(', ')}`);
  if (cookies.length === 0) {
    await browser.close();
    throw new Error('Nessun cookie catturato — il login potrebbe non essere andato a buon fine. Riprova.');
  }
  await browser.close();

  // Save to DB (cookies + storageState per Playwright context restore)
  db.prepare(`
    INSERT INTO sessions (site_id, cookies, storage_state, saved_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(site_id) DO UPDATE SET
      cookies       = excluded.cookies,
      storage_state = excluded.storage_state,
      saved_at      = excluded.saved_at
  `).run(site.id, JSON.stringify(cookies), JSON.stringify(storageState));

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
