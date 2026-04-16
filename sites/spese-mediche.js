/**
 * Scraper — Spese Mediche (Sistema Tessera Sanitaria)
 * Login: https://sistemats1.sanita.finanze.it/portale/area-riservata-cittadino
 *         sistemats1 is the SPID portal; sistemats5 is the app server accessed via cross-domain SSO.
 *         The scraper must first visit sistemats1 (to restore the session) then navigate to sistemats5.
 * Data:  https://sistemats5.sanita.finanze.it/730PreServiziCittadinoWeb/pages/includes/consultazione/tabConsultazione.jsf
 *
 * JSF/PrimeFaces page. Uses Playwright with injected session cookies.
 * For each year: selects it → clicks Cerca → captures total → downloads XLS → scrapes table rows.
 * XLS files saved to data/spese-mediche/spese_YEAR.xls
 */
'use strict';
const path = require('path');
const fs   = require('fs');

const PORTAL_URL = 'https://sistemats1.sanita.finanze.it/portale/area-riservata-cittadino';
const TAB_URL = 'https://sistemats5.sanita.finanze.it/730PreServiziCittadinoWeb/pages/includes/consultazione/tabConsultazione.jsf';
const DEBUG_PATH = path.join(__dirname, '..', 'data', 'debug-spese-login.json');

function isAuthUrl(url = '') {
  return /login|spid|sso|idp|identity|agid/i.test(url);
}

function isSanitaFinanzeUrl(url = '') {
  return /https:\/\/sistemats[0-9]+\.sanita\.finanze\.it\//i.test(url);
}

function writeLoginDebug(data) {
  const dir = path.dirname(DEBUG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DEBUG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function waitForLoginCompletion({ context, page, loginUrl }) {
  const targetHost = new URL(loginUrl).hostname;
  let checks = 0;
  let initialUrl = null;
  const snapshots = [];

  while (checks <= 360) {
    checks++;

    try {
      const currentUrl = page.url();

      if (checks === 1) {
        initialUrl = currentUrl;
        console.log(`[Spese Mediche] Initial login URL: ${initialUrl}`);
        writeLoginDebug({
          phase: 'initial',
          initialUrl,
          currentUrl,
          checks,
          snapshots,
        });
        await page.waitForTimeout(1000);
        continue;
      }

      const onTargetDomain = currentUrl.includes(targetHost);
      const onSanitaDomain = isSanitaFinanzeUrl(currentUrl);
      const cookies = await context.cookies();
      const domains = [...new Set(cookies.map(cookie => cookie.domain))];

      if (checks % 2 === 0) {
        snapshots.push({
          checks,
          currentUrl,
          onTargetDomain,
          onSanitaDomain,
          domains,
        });
        if (snapshots.length > 30) snapshots.shift();
      }

      if (checks % 5 === 0) {
        console.log(`[Spese Mediche] [${checks}s] URL: ${currentUrl.slice(0, 120)} | domains: ${domains.join(', ')}`);
        writeLoginDebug({
          phase: 'polling',
          initialUrl,
          currentUrl,
          checks,
          onTargetDomain,
          onSanitaDomain,
          domains,
          snapshots,
        });
      }

      const hasPortalCookies = cookies.some(cookie => cookie.domain.includes('sistemats1.sanita.finanze.it'));
      const hasBrokerCookies = cookies.some(cookie => cookie.domain.includes('sistemats4.sanita.finanze.it'));
      const canTryConsultation =
        checks >= 10 &&
        onSanitaDomain &&
        (hasPortalCookies || hasBrokerCookies);

      if (canTryConsultation) {
        console.log('[Spese Mediche] Trying to open consultation page...');
        writeLoginDebug({
          phase: 'trying-consultation',
          initialUrl,
          currentUrl,
          checks,
          onTargetDomain,
          onSanitaDomain,
          domains,
          snapshots,
        });
        await openConsultationPage(page);
        const refreshedCookies = await context.cookies();
        const refreshedDomains = [...new Set(refreshedCookies.map(cookie => cookie.domain))];
        writeLoginDebug({
          phase: 'consultation-opened',
          initialUrl,
          currentUrl: page.url(),
          checks,
          onTargetDomain,
          domains: refreshedDomains,
          snapshots,
        });
        if (refreshedDomains.some(domain => domain.includes('sistemats5.sanita.finanze.it'))) {
          console.log('[Spese Mediche] sistemats5 session established.');
          return;
        }
      }
    } catch (err) {
      writeLoginDebug({
        phase: 'error',
        initialUrl,
        currentUrl: page.url(),
        checks,
        error: err.message,
        snapshots,
      });
    }

    await page.waitForTimeout(1000);
  }

  writeLoginDebug({
    phase: 'timeout',
    initialUrl,
    currentUrl: page.url(),
    checks,
    snapshots,
  });
  throw new Error('Login timeout after 6 minutes');
}

async function waitForResults(page, year) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}

  await page.waitForFunction(
    (selectedYear) => {
      const body = document.body.innerText || '';
      const hasHeading = body.includes(`Documenti di spesa ${selectedYear}`);
      const hasDownload = /Scarica tutte le spese/i.test(body);
      const hasRows = !!document.querySelector('table tbody tr');
      return hasHeading || hasDownload || hasRows;
    },
    year,
    { timeout: 15000 }
  ).catch(() => {});
}

async function getResultsSignature(page) {
  return page.evaluate(() => {
    const body = document.body.innerText || '';
    const headingMatch = body.match(/Documenti di spesa\s+(20\d{2})/i);
    const totalMatch = body.match(/Totale importo[:\s]*€?\s*([\d.,]+)/i);
    const firstRow = [...document.querySelectorAll('table tbody tr td')]
      .slice(0, 6)
      .map(td => (td.innerText || td.textContent || '').trim())
      .filter(Boolean)
      .join(' | ');

    return {
      displayedYear: headingMatch ? headingMatch[1] : null,
      totalText: totalMatch ? `€ ${totalMatch[1]}` : '',
      firstRow,
    };
  });
}

async function waitForUpdatedResults(page, previousSignature, expectedYear) {
  await page.waitForFunction(
    ({ prev, year }) => {
      const body = document.body.innerText || '';
      const headingMatch = body.match(/Documenti di spesa\s+(20\d{2})/i);
      const totalMatch = body.match(/Totale importo[:\s]*€?\s*([\d.,]+)/i);
      const firstRow = [...document.querySelectorAll('table tbody tr td')]
        .slice(0, 6)
        .map(td => (td.innerText || td.textContent || '').trim())
        .filter(Boolean)
        .join(' | ');

      const current = {
        displayedYear: headingMatch ? headingMatch[1] : null,
        totalText: totalMatch ? `€ ${totalMatch[1]}` : '',
        firstRow,
      };

      const changed =
        current.displayedYear !== prev.displayedYear ||
        current.totalText !== prev.totalText ||
        current.firstRow !== prev.firstRow;

      if (!changed) return false;
      if (current.displayedYear === year) return true;
      return true;
    },
    { prev: previousSignature, year: expectedYear },
    { timeout: 20000 }
  );
}

async function openConsultationPage(page) {
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const portalUrl = page.url();
  if (isAuthUrl(portalUrl)) {
    throw new Error('Sessione sistemats1 scaduta (redirect al login SPID). Vai in Accessi SPID e rifai il login.');
  }

  await page.goto(TAB_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(
    () => {
      const body = document.body.innerText || '';
      return !!document.querySelector('select') && (
        body.includes('Anno di pagamento') ||
        body.includes('Documenti di spesa') ||
        body.includes('Scarica tutte le spese')
      );
    },
    { timeout: 20000 }
  );
}

async function getYearSelect(page) {
  const selectors = [
    '#annoScelto',
    'select[id$="annoScelto"]',
    'select[name$="annoScelto"]',
    'select'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const options = await locator.locator('option').allTextContents().catch(() => []);
      if (options.some(text => /\b20\d{2}\b/.test(text))) {
        return locator;
      }
    }
  }

  throw new Error('Selettore anno non trovato nella pagina Spese Mediche.');
}

async function getAvailableYears(yearSelect) {
  const options = await yearSelect.locator('option').evaluateAll(nodes =>
    nodes
      .map(node => ({
        value: node.value,
        text: (node.textContent || '').trim(),
      }))
      .filter(opt => opt.value && /\b20\d{2}\b/.test(opt.text || opt.value))
  );

  const seen = new Set();
  return options.filter(opt => {
    const key = `${opt.value}|${opt.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getDisplayedYear(page, fallbackYear) {
  const displayedYear = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const match = body.match(/Documenti di spesa\s+(20\d{2})/i);
    return match ? match[1] : null;
  });

  return displayedYear || fallbackYear;
}

async function clickSearch(page) {
  const searchButton = page.getByRole('button', { name: /cerca/i }).first();
  if (await searchButton.count()) {
    await searchButton.click();
    return;
  }

  const fallback = page.locator('button, input[type="submit"], a').filter({ hasText: 'Cerca' }).first();
  if (await fallback.count()) {
    await fallback.click();
    return;
  }

  throw new Error('Pulsante Cerca non trovato.');
}

async function clickDownloadAll(page) {
  const button = page.getByRole('button', { name: /scarica tutte le spese/i }).first();
  if (await button.count()) {
    await button.click();
    return;
  }

  const link = page.locator('a, button, input').filter({ hasText: 'Scarica tutte le spese' }).first();
  if (await link.count()) {
    await link.click();
    return;
  }

  const byId = page.locator('#btnScaricaSpese, [id*="ScaricaSpese"], [id*="scaricaSpese"]').first();
  if (await byId.count()) {
    await byId.click();
    return;
  }

  throw new Error('Pulsante "Scarica tutte le spese" non trovato.');
}

async function extractTableData(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    const target = tables.find(table => {
      const headers = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').trim());
      return headers.some(h => /denominazione erogatore/i.test(h)) &&
             headers.some(h => /importo/i.test(h));
    });

    if (!target) return { headers: [], rows: [] };

    const headers = [...target.querySelectorAll('thead th')]
      .map(th => (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim())
      .map(text => text.replace(/^Ordina per\s*/i, '').trim())
      .filter(Boolean);

    const rows = [...target.querySelectorAll('tbody tr')]
      .map(tr => [...tr.querySelectorAll('th, td')].map(cell => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()))
      .filter(row => row.length >= 5);

    return { headers, rows };
  });
}

function inferYearFromTable(headers, rows, fallbackYear) {
  const yearCounts = new Map();
  const yearPattern = /\b(20\d{2})\b/g;
  const candidateIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(item => /data pagamento|data emissione/i.test(item.header))
    .map(item => item.index);

  for (const row of rows) {
    const values = candidateIndexes.length
      ? candidateIndexes.map(index => row[index]).filter(Boolean)
      : row;

    for (const value of values) {
      for (const match of value.matchAll(yearPattern)) {
        const foundYear = match[1];
        yearCounts.set(foundYear, (yearCounts.get(foundYear) || 0) + 1);
      }
    }
  }

  const sorted = [...yearCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || fallbackYear;
}

module.exports = {
  meta: {
    name:                'Spese Mediche',
    url:                 TAB_URL,
    authType:            'spid',
    loginUrl:            PORTAL_URL,
    loginSuccessPattern: 'area-riservata-cittadino|scrivania|home',
  },

  waitForLoginCompletion,

  async completeLoginSession({ context, page }) {
    await openConsultationPage(page);
    const cookies = await context.cookies();
    const domains = [...new Set(cookies.map(cookie => cookie.domain))];

    if (!domains.some(domain => domain.includes('sistemats5.sanita.finanze.it'))) {
      throw new Error('Login completato ma la sessione applicativa di Spese Mediche non e stata creata su sistemats5.');
    }
  },

  async run(db, siteId, session) {
    if (!session) throw new Error('Sessione SPID mancante. Vai in Accessi SPID e autenticati prima di eseguire.');

    const { chromium } = require('playwright');
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    const browser = await chromium.launch({ headless });
    const context = session.storageState
      ? await browser.newContext({ storageState: session.storageState, acceptDownloads: true })
      : await browser.newContext({ acceptDownloads: true });

    if (!session.storageState && session.cookies?.length) {
      await context.addCookies(session.cookies);
    }

    const page = await context.newPage();

    const dlDir = path.join(__dirname, '..', 'data', 'spese-mediche');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

    const results = [];
    try {
      await openConsultationPage(page);

      const yearSelect = await getYearSelect(page);
      const yearOptions = await getAvailableYears(yearSelect);
      if (yearOptions.length === 0) {
        throw new Error('Nessun anno disponibile trovato nella pagina Spese Mediche.');
      }

      const savedYears = new Set();

      for (const yearOption of yearOptions) {
        const fallbackYear = (yearOption.text.match(/20\d{2}/) || [yearOption.value])[0];
        console.log(`[Spese Mediche] Anno selezionato ${fallbackYear} (value=${yearOption.value})...`);
        try {
          const previousSignature = await getResultsSignature(page);
          await yearSelect.selectOption(yearOption.value);
          await page.waitForTimeout(400);
          await clickSearch(page);
          await waitForUpdatedResults(page, previousSignature, fallbackYear).catch(async () => {
            await waitForResults(page, fallbackYear);
          });

          const displayedYear = await getDisplayedYear(page, fallbackYear);
          const tableData = await extractTableData(page);
          const inferredYear = inferYearFromTable(tableData.headers, tableData.rows, displayedYear);
          const effectiveYear = inferredYear || displayedYear || fallbackYear;

          console.log(`[Spese Mediche] Anno visibile=${displayedYear}, anno inferito=${inferredYear}, anno salvato=${effectiveYear}`);

          if (savedYears.has(effectiveYear)) {
            console.log(`[Spese Mediche] Anno ${effectiveYear} gia acquisito, salto il duplicato.`);
            continue;
          }

          const totalText = await page.evaluate(() => {
            const body = document.body.innerText || '';
            const match = body.match(/Totale importo[:\s]*€?\s*([\d.,]+)/i);
            return match ? `€ ${match[1]}` : '';
          });

          const headers = tableData.headers;
          const rows = tableData.rows;

          let xlsFilename = null;
          const targetPath = path.join(dlDir, `spese_${effectiveYear}.xls`);
          try {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 30000 }),
              clickDownloadAll(page),
            ]);
            xlsFilename = `spese_${effectiveYear}.xls`;
            await download.saveAs(targetPath);
            console.log(`[Spese Mediche] XLS ${effectiveYear} scaricato (${xlsFilename})`);
          } catch (dlErr) {
            console.warn(`[Spese Mediche] Download XLS ${effectiveYear} fallito: ${dlErr.message}`);
          }

          savedYears.add(effectiveYear);
          results.push({
            externalId:   `spese-${effectiveYear}`,
            title:        `Spese sanitarie ${effectiveYear}`,
            organization: 'Sistema Tessera Sanitaria',
            location:     null,
            province:     null,
            contractType: totalText || null,
            expiresAt:    null,
            rawJson: JSON.stringify({
              year: effectiveYear,
              displayedYear,
              inferredYear,
              selectedValue: yearOption.value,
              selectedLabel: yearOption.text,
              total: totalText || null,
              xlsFilename,
              headers,
              rows,
              scrapedAt: new Date().toISOString(),
            }),
          });
        } catch (yearErr) {
          console.warn(`[Spese Mediche] Anno ${fallbackYear} errore: ${yearErr.message}`);
        }
      }
    } catch (err) {
      throw new Error(`Impossibile caricare la pagina spese. Sessione scaduta? ${err.message}`);
    } finally {
      await browser.close();
    }

    return results;
  },
};
