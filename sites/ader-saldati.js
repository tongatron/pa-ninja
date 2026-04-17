'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://servizi.agenziaentrateriscossione.gov.it';
const HOME_URL = `${BASE}/equitaliaServiziWeb/home/index.do`;
const SEARCH_URL = `${BASE}/estratto-conto/home`;
const DEBIT_URL = `${BASE}/estratto-conto/situazione-debitoria#tab-saldati`;
const ARTIFACT_DIR = path.join(__dirname, '..', 'data', 'ader-saldati');

function isAuthPage(url) {
  return /login|spid|sso|idp|identity|agid|entratel|fiscoonline/i.test(url) &&
         !url.includes('estratto-conto') &&
         !url.includes('equitaliaServiziWeb/home');
}

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
        await locator.click({ timeout: 4000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickByLooseText(page, regex) {
  return page.evaluate((pattern) => {
    const rx = new RegExp(pattern, 'i');
    const candidates = [...document.querySelectorAll('button, a, [role="button"], li, span, div')];
    const target = candidates.find(el => {
      const text = [
        el.innerText,
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
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

async function waitQuiet(page, timeout = 1500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(timeout);
}

async function ensureAuthenticated(page) {
  console.log('[ader-saldati] Navigazione a', HOME_URL);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitQuiet(page, 2000);

  if (isAuthPage(page.url())) {
    throw new Error('Sessione AdE Riscossione scaduta — vai in Accessi SPID e rifai il login.');
  }
}

async function openSituazioneDebitoria(page) {
  const clicked = await clickFirst(page, [
    'a:has-text("Situazione debitoria")',
    'button:has-text("Situazione debitoria")',
  ]) || await clickByLooseText(page, /situazione debitoria.*consulta e paga/i);

  if (!clicked) {
    await page.goto(DEBIT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  await waitQuiet(page, 2500);
  console.log('[ader-saldati] URL situazione debitoria:', page.url());
}

async function openSearchData(page) {
  await clickFirst(page, [
    'a:has-text("Accedi ai Dati di ricerca")',
    'button:has-text("Accedi ai Dati di ricerca")',
    'input[value*="Accedi ai Dati di ricerca"]',
  ]).catch(() => {});

  await clickByLooseText(page, /accedi ai dati di ricerca/i).catch(() => {});
  await waitQuiet(page, 1500);
}

async function selectAllProvinces(page) {
  const provinces = await page.evaluate(() => {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const selected = [];

    const ambito = document.querySelector('#ambito');
    if (ambito && ambito.options?.length) {
      return [...ambito.options]
        .filter(option => !option.disabled && option.value)
        .map(option => clean(option.textContent || option.value))
        .filter(Boolean);
    }

    const provinceInputs = [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .filter(input => {
        const label = input.labels?.[0]?.innerText || input.closest('label')?.innerText || '';
        const text = [
          label,
          input.getAttribute('aria-label'),
          input.name,
          input.id,
          input.value,
        ].filter(Boolean).join(' ');
        return /provin/i.test(text) || /tutte/i.test(text);
      });

    if (provinceInputs.length) {
      for (const input of provinceInputs) {
        const isAll = /tutte/i.test([
          input.labels?.[0]?.innerText || '',
          input.value || '',
          input.id || '',
        ].join(' '));
        const wantsChecked = input.type === 'checkbox' || isAll;
        if (wantsChecked && !input.checked) {
          input.click();
        }
        if (input.checked) {
          selected.push(clean(input.labels?.[0]?.innerText || input.value || input.id || 'Provincia'));
        }
      }
      return [...new Set(selected)];
    }

    const select = [...document.querySelectorAll('select')].find(el => {
      const blob = [
        el.name,
        el.id,
        el.getAttribute('aria-label'),
        el.closest('label')?.innerText,
        el.parentElement?.innerText,
      ].filter(Boolean).join(' ');
      return /provin/i.test(blob);
    });

    if (select) {
      for (const option of [...select.options]) {
        if (option.disabled) continue;
        option.selected = true;
        selected.push(clean(option.textContent || option.value));
      }
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return [...new Set(selected)];
    }

    return [];
  });

  await waitQuiet(page, 800);
  return provinces.filter(Boolean);
}

async function openTab(page, name) {
  const anchors = {
    daSaldare: '#tab-da-saldare',
    saldate: '#tab-saldati',
    procedureAttive: '#tab-procedure-attive',
    rateizzazione: '#tab-rateizzazioni',
  };
  const patterns = {
    daSaldare: /da saldare/i,
    saldate: /saldati|saldate/i,
    procedureAttive: /procedure attive/i,
    rateizzazione: /rateizz/i,
  };
  const regex = patterns[name];
  if (!regex) return false;

  const clicked = await clickFirst(page, [
    `a[href="${anchors[name]}"]`,
    `a[href*="${anchors[name]}"]`,
    `button[data-target="${anchors[name]}"]`,
  ]) || await clickByLooseText(page, regex);

  if (clicked) {
    await waitQuiet(page, 1800);
  }
  return clicked;
}

async function readVisibleSection(page) {
  return page.evaluate(() => {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const body = clean(document.body.innerText || '');
    return body.slice(0, 20000);
  });
}

async function captureSectionArtifact(page, stem) {
  if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = path.join(ARTIFACT_DIR, `${stem}-${timestamp}.png`);
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  return pngPath;
}

async function extractTablePage(page, section, provinceScope, pageIndex) {
  return page.evaluate(({ section, provinceScope, pageIndex, tabSelector }) => {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const scope = document.querySelector(tabSelector) || document;
    const tables = [...scope.querySelectorAll('table')];
    const rows = [];

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th')].map(th => clean(th.innerText)).filter(Boolean);
      const bodyRows = [...table.querySelectorAll('tbody tr')];
      if (!bodyRows.length) continue;

      for (const tr of bodyRows) {
        const cells = [...tr.querySelectorAll('td')].map(td => clean(td.innerText)).filter(Boolean);
        if (!cells.length) continue;
        const structured = {};
        headers.forEach((header, idx) => {
          if (cells[idx] !== undefined) structured[header] = cells[idx];
        });
        rows.push({
          section,
          provinceScope,
          pageIndex,
          headers,
          cells,
          structured,
          text: clean(tr.innerText),
        });
      }

      if (rows.length) break;
    }

    return rows;
  }, {
    section,
    provinceScope,
    pageIndex,
    tabSelector: ({
      daSaldare: '#tab-da-saldare',
      saldate: '#tab-saldati',
      procedureAttive: '#tab-procedure-attive',
      rateizzazione: '#tab-rateizzazioni',
    })[section],
  });
}

async function readTabContent(page, section) {
  return page.evaluate(({ tabSelector }) => {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const node = document.querySelector(tabSelector);
    if (!node) return '';
    return clean(node.innerText || node.textContent || '');
  }, {
    tabSelector: ({
      daSaldare: '#tab-da-saldare',
      saldate: '#tab-saldati',
      procedureAttive: '#tab-procedure-attive',
      rateizzazione: '#tab-rateizzazioni',
    })[section],
  });
}

async function nextPagination(page) {
  const clicked = await clickFirst(page, [
    'a:has-text(">>")',
    'button:has-text(">>")',
    'a:has-text(">")',
    'button:has-text(">")',
    '[aria-label*="successiva" i]',
    '[title*="successiva" i]',
  ]) || await clickByLooseText(page, /^(>|>>|pagina successiva|ultima pagina)$/i);

  if (clicked) {
    await waitQuiet(page, 1800);
  }
  return clicked;
}

async function collectPaginatedTable(page, section, provinces) {
  const provinceScope = provinces.length ? provinces.join(', ') : 'tutte';
  const seenFingerprints = new Set();
  const allRows = [];

  for (let pageIndex = 1; pageIndex <= 30; pageIndex++) {
    const rows = await extractTablePage(page, section, provinceScope, pageIndex);
    const fingerprint = JSON.stringify(rows.map(row => row.text));
    if (!rows.length || seenFingerprints.has(fingerprint)) break;
    seenFingerprints.add(fingerprint);
    allRows.push(...rows);

    const advanced = await nextPagination(page);
    if (!advanced) break;
  }

  return allRows;
}

async function openResultsFor(page, section, provinceLabel) {
  const targetId = section === 'daSaldare' ? '#submit_da_saldare' : '#submit_saldati';

  if (provinceLabel) {
    try {
      await page.selectOption('#ambito', { label: provinceLabel });
    } catch {
      const changed = await page.evaluate((label) => {
        const clean = text => (text || '').replace(/\s+/g, ' ').trim();
        const ambito = document.querySelector('#ambito');
        if (!ambito) return false;
        const option = [...ambito.options].find(opt => clean(opt.textContent) === label);
        if (!option) return false;
        ambito.value = option.value;
        ambito.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, provinceLabel);
      if (!changed) return false;
    }
  }

  const clicked = await clickFirst(page, [targetId, `input${targetId}`]) ||
    await page.evaluate((selector) => {
      const button = document.querySelector(selector);
      if (!button) return false;
      button.click();
      return true;
    }, targetId);

  if (!clicked) return false;
  await waitQuiet(page, 2500);

  const resolvedProvince = await readResolvedProvince(page);
  if (provinceLabel && resolvedProvince && resolvedProvince !== provinceLabel) {
    console.log(`[ader-saldati] Provincia attesa "${provinceLabel}" ma pagina su "${resolvedProvince}"`);
    return false;
  }
  return true;
}

async function readResolvedProvince(page) {
  return page.evaluate(() => {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const fromDescription = document.querySelector('.descrizioneSituazioneDebitoria strong.testogrigio');
    if (fromDescription) return clean(fromDescription.textContent || '');
    const fromTitle = document.querySelector('h3 .testogrigio');
    if (fromTitle) return clean(fromTitle.textContent || '');
    return '';
  });
}

function buildEmptyStateItem(section, text, provinces, artifactPath = null) {
  const labels = {
    daSaldare: 'Da saldare',
    saldate: 'Saldate',
  };
  return {
    externalId: `ader-${section}:empty:${slug(provinces.join(', ') || 'tutte')}`,
    title: `${labels[section] || section} - nessun documento`,
    organization: 'AdE Riscossione',
    location: null,
    province: provinces.length ? provinces.join(', ') : null,
    contractType: 'Empty',
    rawJson: JSON.stringify({
      section,
      empty: true,
      text,
      provinces,
      artifactPath,
    }),
  };
}

function buildTableItems(section, rows, artifactPath = null) {
  return rows.map((row, idx) => {
    const numero = row.cells[0] || `${section}-${idx + 1}`;
    const amount = row.cells.find(cell => /[0-9][0-9\.\,]*\s*€?/.test(cell)) || '';
    const date = row.cells.find(cell => /\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(cell)) || '';
    const provinceLabel = row.provinceScope || '';
    const titleBase = section === 'daSaldare' ? 'Da saldare' : 'Saldata';
    return {
      externalId: `ader-${section}:${slug(provinceLabel)}:${slug(numero)}:${idx + 1}`,
      title: `${titleBase} ${numero}`.trim(),
      organization: 'AdE Riscossione',
      location: date || null,
      province: provinceLabel || null,
      contractType: amount || null,
      rawJson: JSON.stringify({
        section,
        provinceScope: row.provinceScope,
        headers: row.headers,
        cells: row.cells,
        structured: row.structured,
        text: row.text,
        pageIndex: row.pageIndex,
        artifactPath,
      }),
    };
  });
}

function buildTextItem(section, text, artifactPath) {
  const labels = {
    procedureAttive: 'Procedure attive',
    rateizzazione: 'Rateizzazione',
  };
  return {
    externalId: `ader-${section}:${slug(text.slice(0, 80)) || 'snapshot'}`,
    title: labels[section] || section,
    organization: 'AdE Riscossione',
    location: null,
    province: null,
    contractType: 'Snapshot',
    rawJson: JSON.stringify({
      section,
      text,
      artifactPath,
    }),
  };
}

module.exports = {
  meta: {
    name: 'AdE Riscossione – Saldati',
    url: DEBIT_URL,
    authType: 'spid',
    loginUrl: HOME_URL,
    loginSuccessPattern: 'equitaliaServiziWeb|estratto-conto',
  },

  async run(db, siteId, session) {
    const { chromium } = require('playwright');
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    const browser = await chromium.launch({ headless });

    try {
      const context = session.storageState
        ? await browser.newContext({ storageState: session.storageState })
        : await browser.newContext();
      if (!session.storageState) await context.addCookies(session.cookies);

      const page = await context.newPage();
      await ensureAuthenticated(page);
      await openSituazioneDebitoria(page);
      await openSearchData(page);

      const provinces = await selectAllProvinces(page);
      console.log('[ader-saldati] Province selezionate:', provinces.join(', ') || '(default)');

      const items = [];

      const scopes = provinces.length ? provinces : [''];

      for (const provinceLabel of scopes) {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await waitQuiet(page, 1800);

        const daSaldareOpened = await openResultsFor(page, 'daSaldare', provinceLabel);
        if (!daSaldareOpened) {
          console.log(`[ader-saldati] Impossibile aprire Da saldare per ${provinceLabel || '(default)'}`);
          continue;
        }
        const daSaldareArtifact = await captureSectionArtifact(page, `da-saldare-${slug(provinceLabel || 'default')}`);
        const daSaldareRows = await collectPaginatedTable(page, 'daSaldare', provinceLabel ? [provinceLabel] : []);
        const daSaldareText = await readTabContent(page, 'daSaldare');
        if (daSaldareRows.length) items.push(...buildTableItems('daSaldare', daSaldareRows, daSaldareArtifact));
        else if (daSaldareText) items.push(buildEmptyStateItem('daSaldare', daSaldareText, provinceLabel ? [provinceLabel] : [], daSaldareArtifact));
        console.log(`[ader-saldati] Da saldare ${provinceLabel || '(default)'}: ${daSaldareRows.length} righe`);

        await openTab(page, 'saldate');
        const saldateArtifact = await captureSectionArtifact(page, `saldate-${slug(provinceLabel || 'default')}`);
        const saldateRows = await collectPaginatedTable(page, 'saldate', provinceLabel ? [provinceLabel] : []);
        const saldateText = await readTabContent(page, 'saldate');
        if (saldateRows.length) items.push(...buildTableItems('saldate', saldateRows, saldateArtifact));
        else if (saldateText) items.push(buildEmptyStateItem('saldate', saldateText, provinceLabel ? [provinceLabel] : [], saldateArtifact));
        console.log(`[ader-saldati] Saldate ${provinceLabel || '(default)'}: ${saldateRows.length} righe`);

        await openTab(page, 'procedureAttive');
        const procedureText = await readTabContent(page, 'procedureAttive');
        const procedureArtifact = await captureSectionArtifact(page, `procedure-attive-${slug(provinceLabel || 'default')}`);
        if (procedureText) {
          const item = buildTextItem('procedureAttive', procedureText, procedureArtifact);
          item.province = provinceLabel || null;
          item.rawJson = JSON.stringify({
            ...JSON.parse(item.rawJson),
            province: provinceLabel || null,
          });
          items.push(item);
        }

        await openTab(page, 'rateizzazione');
        const rateText = await readTabContent(page, 'rateizzazione');
        const rateArtifact = await captureSectionArtifact(page, `rateizzazione-${slug(provinceLabel || 'default')}`);
        if (rateText) {
          const item = buildTextItem('rateizzazione', rateText, rateArtifact);
          item.province = provinceLabel || null;
          item.rawJson = JSON.stringify({
            ...JSON.parse(item.rawJson),
            province: provinceLabel || null,
          });
          items.push(item);
        }
      }

      const htmlPath = path.join(ARTIFACT_DIR, 'debug-ader-saldati.html');
      if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(htmlPath, await page.content(), 'utf8');

      console.log(`[ader-saldati] Totale risultati: ${items.length}`);
      return items;
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
