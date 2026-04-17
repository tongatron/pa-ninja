'use strict';

const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://www.intesasanpaolo.com/';
const HOME_URL = 'https://www.intesasanpaolo.com/ndce/webapp/ib-globalposition-v1/homepage';
const DOWNLOAD_DIR = path.join(__dirname, '..', 'data', 'intesa-sanpaolo');
const DEBUG_HTML = path.join(DOWNLOAD_DIR, 'debug-intesa-download.html');
const PROFILE_DIR = path.join(__dirname, '..', 'data', 'browser-profiles', 'intesa-sanpaolo-conto');

const meta = {
  loginUrl: LOGIN_URL,
  loginSuccessPattern: 'intesasanpaolo\\.com\\/ndce\\/webapp\\/ib-globalposition-v1\\/homepage',
  persistentProfile: true,
  runHeadless: false,
};

function formatInputDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDisplayDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickByLooseText(page, regex) {
  return page.evaluate((pattern) => {
    const rx = new RegExp(pattern, 'i');
    const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
    const target = candidates.find(el => {
      const text = [
        el.innerText,
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('value'),
      ].filter(Boolean).join(' ');
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      return visible && rx.test(text);
    });
    if (!target) return false;
    target.click();
    return true;
  }, regex.source);
}

async function waitForLoginCompletion({ context, page }) {
  const maxChecks = 360;
  for (let i = 0; i < maxChecks; i++) {
    const url = page.url();
    const cookies = await context.cookies();
    const hasBankCookie = cookies.some(cookie => /intesasanpaolo/i.test(cookie.domain));
    const onHomepage = /\/ndce\/webapp\/ib-globalposition-v1\/homepage/i.test(url);
    if (onHomepage && hasBankCookie) {
      await page.waitForTimeout(1500);
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Login Intesa Sanpaolo non completato entro 6 minuti.');
}

async function completeLoginSession({ page }) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function ensureAuthenticated(page, context) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  if (/ndce\/webapp\/ib-globalposition-v1/i.test(page.url())) {
    return;
  }

  console.log('[Intesa] Sessione non attiva. Completa il login nella finestra appena aperta...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await acceptCookiesIfNeeded(page);
  await waitForLoginCompletion({ context, page });
  await completeLoginSession({ page });

  if (!/ndce\/webapp\/ib-globalposition-v1/i.test(page.url())) {
    fs.writeFileSync(DEBUG_HTML, await page.content(), 'utf8');
    throw new Error('Sessione Intesa non riconosciuta: il portale ha reindirizzato fuori dall’home banking.');
  }
}

async function acceptCookiesIfNeeded(page) {
  await clickFirst(page, [
    'button:has-text("Accetto")',
    'button:has-text("Acconsento")',
    'button:has-text("Accetta")',
    'button:has-text("Accetta tutti")',
    '[role="button"]:has-text("Accetto")',
  ]).catch(() => {});
}

async function openMovementsArea(page) {
  await clickFirst(page, [
    'a:has-text("Conto")',
    'button:has-text("Conto")',
    'a:has-text("Conto corrente")',
    'button:has-text("Conto corrente")',
  ]).catch(() => {});

  await page.waitForTimeout(1200);

  await clickFirst(page, [
    'button:has-text("Saldo al")',
    'a:has-text("Saldo al")',
    'button:has-text("Movimenti")',
    'a:has-text("Movimenti")',
    'button:has-text("Lista movimenti")',
  ]).catch(() => {});

  await clickFirst(page, [
    'button:has-text("VAI A TUTTE LE OPERAZIONI")',
    'a:has-text("VAI A TUTTE LE OPERAZIONI")',
    'button:has-text("Vai a tutte le operazioni")',
    'a:has-text("Vai a tutte le operazioni")',
  ]).catch(() => {});

  await clickByLooseText(page, /vai a tutte le operazioni/i).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
}

async function openAdvancedSearch(page) {
  let opened = await clickFirst(page, [
    'button:has-text("Ricerca avanzata")',
    'a:has-text("Ricerca avanzata")',
    '[role="button"]:has-text("Ricerca avanzata")',
  ]);
  if (!opened) {
    opened = await clickByLooseText(page, /ricerca avanzata/i);
  }
  await page.waitForTimeout(800);
  return opened;
}

async function fillDateRange(page, fromDate, toDate) {
  const fromIso = formatInputDate(fromDate);
  const toIso = formatInputDate(toDate);
  const fromDisplay = formatDisplayDate(fromDate);
  const toDisplay = formatDisplayDate(toDate);

  await page.evaluate(({ fromIso, toIso, fromDisplay, toDisplay }) => {
    const visibleInputs = [...document.querySelectorAll('input')]
      .filter(input => {
        const style = window.getComputedStyle(input);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && input.offsetParent !== null;
        return visible && !input.disabled && !input.readOnly;
      });

    const dateInputs = visibleInputs.filter(input =>
      input.type === 'date' ||
      /data|dal|da/i.test(input.placeholder || '') ||
      /data|dal|da/i.test(input.getAttribute('aria-label') || '') ||
      /date|data/i.test(input.name || '')
    );

    const first = dateInputs[0];
    const second = dateInputs[1];
    const applyValue = (input, value, fallback) => {
      if (!input) return;
      input.focus();
      input.value = input.type === 'date' ? value : fallback;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    };

    applyValue(first, fromIso, fromDisplay);
    applyValue(second, toIso, toDisplay);
  }, { fromIso, toIso, fromDisplay, toDisplay });
}

async function applySearch(page) {
  await clickFirst(page, [
    'button:has-text("Applica")',
    'button:has-text("Cerca")',
    '[role="button"]:has-text("Applica")',
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
}

async function downloadStatement(page, fromDate, toDate) {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const clickDownload = async () => {
    let clicked = await clickFirst(page, [
      'button:has-text("Scarica il file")',
      'a:has-text("Scarica il file")',
      'button:has-text("Scarica")',
      'a:has-text("Scarica")',
      '[role="button"]:has-text("Scarica il file")',
      '[role="button"]:has-text("Scarica")',
      '[aria-label*="Scarica" i]',
      '[title*="Scarica" i]',
    ]);
    if (!clicked) {
      clicked = await clickByLooseText(page, /scarica( il file)?/i);
    }
    if (!clicked) return null;
    return true;
  };

  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  const clicked = await clickDownload();
  if (!clicked) {
    fs.writeFileSync(DEBUG_HTML, await page.content(), 'utf8');
    return null;
  }

  const download = await downloadPromise;
  if (!download) {
    fs.writeFileSync(DEBUG_HTML, await page.content(), 'utf8');
    return null;
  }

  const suggested = await download.suggestedFilename().catch(() => '');
  const ext = path.extname(suggested) || '.csv';
  const fileName = `intesa_movimenti_${formatInputDate(fromDate)}_${formatInputDate(toDate)}${ext}`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);
  await download.saveAs(filePath);

  return { fileName, filePath };
}

async function extractSnapshot(page, fromDate, toDate, fileName) {
  return page.evaluate(({ fromDisplay, toDisplay, fileName }) => {
    const bodyText = (document.body.innerText || '').replace(/\u00a0/g, ' ');
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const compactAmount = text => {
      const value = clean(text).replace(/\s+/g, '');
      return value || '';
    };

    const pickLine = regex => {
      const match = bodyText.match(regex);
      return match ? clean(match[1]) : '';
    };

    const collectText = node => clean(node?.innerText || node?.textContent || '');

    const balanceSection = [...document.querySelectorAll('balance-section-account')]
      .find(node => /conto/i.test(collectText(node)));
    const balanceAmounts = balanceSection
      ? [...balanceSection.querySelectorAll('[balance-amount], .font-weight-bold.font-size-1-4, .font-125.font-weight-bold')]
          .map(node => compactAmount(node.textContent))
          .filter(Boolean)
      : [];

    const accountName =
      collectText(balanceSection?.querySelector('h1')) ||
      pickLine(/Conto[:\s]+([^\n]+)/i) ||
      pickLine(/(XME\s+Conto[^\n]*)/i) ||
      'Conto corrente';

    const accountingBalance =
      balanceAmounts[1] ||
      pickLine(/Saldo\s+contabile[:\s]*([+-]?\s*€?\s*[\d\.\,]+)/i) ||
      pickLine(/Saldo\s+contabile\s*\n([^\n]+)/i);

    const availableBalance =
      balanceAmounts[0] ||
      pickLine(/Saldo\s+disponibile[:\s]*([+-]?\s*€?\s*[\d\.\,]+)/i) ||
      pickLine(/Saldo\s+disponibile\s+ad\s+oggi[:\s]*([+-]?\s*€?\s*[\d\.\,]+)/i) ||
      pickLine(/Disponibilit[aà][:\s]*([+-]?\s*€?\s*[\d\.\,]+)/i);

    const balanceDate =
      pickLine(/Saldo\s+al[:\s]*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i) ||
      pickLine(/Scaricare\s+saldo\s+al[:\s]*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);

    const ibanMasked =
      pickLine(/IBAN[:\s]*([A-Z]{2}[0-9A-Z\s\*]+)/i) ||
      pickLine(/IT\d{2}[A-Z0-9\* ]+/i);

    const operations = [];

    const operationItems = [...document.querySelectorAll('operation-item')];
    for (const item of operationItems) {
      const day = collectText(item.querySelector('operation-data .font-135'));
      const month = collectText(item.querySelector('operation-data .font-75'));
      const bookingDate = clean([day, month].filter(Boolean).join(' '));
      const description = collectText(item.querySelector('operation-descrizione .h4')) || collectText(item.querySelector('operation-descrizione'));
      const accountRef = collectText(item.querySelector('operation-descrizione .h5'));
      const category = collectText(item.querySelector('.primary-black-color-75.mt-1, .font-75.primary-black-color-75'));
      const integerPart = collectText(item.querySelector('operation-saldo .font-125'));
      const decimalPart = collectText(item.querySelector('operation-saldo .font-1'));
      const amount = compactAmount(`${integerPart}${decimalPart}`);
      const status = collectText(item.querySelector('.blue-color-100'));

      if (!description && !amount) continue;

      operations.push({
        bookingDate,
        valueDate: '',
        description,
        amount,
        category: clean([category, accountRef].filter(Boolean).join(' · ')),
        status,
        accountingState: status,
      });
    }

    if (!operations.length) {
      const tables = [...document.querySelectorAll('table')];
      for (const table of tables) {
        const headers = [...table.querySelectorAll('th')].map(th => clean(th.innerText));
        const headerBlob = headers.join(' | ').toLowerCase();
        if (!/data|descrizione|importo/.test(headerBlob)) continue;

        const rows = [...table.querySelectorAll('tbody tr')];
        for (const row of rows) {
          const cells = [...row.querySelectorAll('td')].map(td => clean(td.innerText));
          if (!cells.length) continue;

          operations.push({
            bookingDate: cells[0] || '',
            valueDate: cells[1] || '',
            description: cells[2] || cells[1] || '',
            amount: cells[cells.length - 1] || '',
            category: cells[3] || '',
            status: cells.find(cell => /contabilizz/i.test(cell)) || '',
            accountingState: cells.find(cell => /contabilizz/i.test(cell)) || '',
          });
        }
        if (operations.length) break;
      }
    }

    return {
      accountName,
      accountingBalance,
      availableBalance,
      balanceDate,
      ibanMasked,
      searchFrom: fromDisplay,
      searchTo: toDisplay,
      fileName,
      operations,
      bodyText,
    };
  }, {
    fromDisplay: formatDisplayDate(fromDate),
    toDisplay: formatDisplayDate(toDate),
    fileName,
  });
}

async function run(db, siteId, session) {
  if (!session?.storageState && !session?.cookies?.length && !fs.existsSync(PROFILE_DIR)) {
    throw new Error('Sessione Intesa Sanpaolo non disponibile. Esegui prima l’accesso manuale.');
  }

  const { chromium } = require('playwright');
  const usePersistentProfile = meta.persistentProfile && fs.existsSync(PROFILE_DIR);
  let browser = null;
  let context = null;

  try {
    if (usePersistentProfile) {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: meta.runHeadless !== false,
        acceptDownloads: true,
      });
    } else {
      browser = await chromium.launch({ headless: meta.runHeadless !== false });
      context = await browser.newContext(
        session.storageState ? { storageState: session.storageState, acceptDownloads: true } : { acceptDownloads: true }
      );

      if (!session.storageState && session.cookies?.length) {
        await context.addCookies(session.cookies);
      }
    }

    const page = await context.newPage();
    await ensureAuthenticated(page, context);
    await acceptCookiesIfNeeded(page);
    await openMovementsArea(page);

    const fromDate = new Date();
    fromDate.setMonth(0, 1);
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date();

    await openAdvancedSearch(page);
    await fillDateRange(page, fromDate, toDate);
    await applySearch(page);

    const downloadResult = await downloadStatement(page, fromDate, toDate);
    const fileName = downloadResult?.fileName || null;
    const filePath = downloadResult?.filePath || null;
    const snapshot = await extractSnapshot(page, fromDate, toDate, fileName || '');
    const downloadedAt = new Date().toISOString();

    const results = [
      {
        externalId: 'intesa-summary',
        title: snapshot.accountName || 'Conto corrente',
        organization: 'Intesa Sanpaolo',
        location: snapshot.ibanMasked || '',
        contractType: 'Saldo',
        rawJson: JSON.stringify({
          kind: 'summary',
          accountName: snapshot.accountName,
          ibanMasked: snapshot.ibanMasked,
          accountingBalance: snapshot.accountingBalance,
          availableBalance: snapshot.availableBalance,
          balanceDate: snapshot.balanceDate,
          searchFrom: snapshot.searchFrom,
          searchTo: snapshot.searchTo,
          downloadedAt,
          fileName,
          downloadMissing: !fileName,
        }),
      },
    ];

    if (fileName) {
      results.push({
        externalId: `intesa-file-${formatInputDate(fromDate)}-${formatInputDate(toDate)}`,
        title: fileName,
        organization: 'Intesa Sanpaolo',
        contractType: 'Export',
        rawJson: JSON.stringify({
          kind: 'file',
          fileName,
          filePath,
          downloadedAt,
          fromDate: snapshot.searchFrom,
          toDate: snapshot.searchTo,
        }),
      });
    }

    for (const op of snapshot.operations) {
      const ext = `intesa-op-${slug(op.bookingDate)}-${slug(op.description)}-${slug(op.amount)}`;
      results.push({
        externalId: ext,
        title: op.description || 'Movimento',
        organization: op.category || 'Conto corrente',
        location: op.valueDate || '',
        contractType: op.status || op.accountingState || 'Movimento',
        expiresAt: null,
        rawJson: JSON.stringify({
          kind: 'operation',
          bookingDate: op.bookingDate,
          valueDate: op.valueDate,
          description: op.description,
          amount: op.amount,
          category: op.category,
          status: op.status,
          accountingState: op.accountingState,
          sign: /^-/.test(op.amount || '') ? 'debit' : 'credit',
        }),
      });
    }

    return results;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  meta,
  waitForLoginCompletion,
  completeLoginSession,
  run,
};
