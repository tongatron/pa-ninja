'use strict';

/**
 * Scraper – AdE Riscossione: Situazione debitoria → Saldati
 * URL: https://servizi.agenziaentrateriscossione.gov.it/estratto-conto/situazione-debitoria#tab-saldati
 *
 * Estrae la tabella dei debiti saldati dall'area riservata
 * Agenzia delle Entrate-Riscossione (login SPID/CIE).
 *
 * Strategia:
 *   1. Intercettazione risposte JSON/API (Angular SPA)
 *   2. Fallback: estrazione DOM della tabella renderizzata
 */

const BASE = 'https://servizi.agenziaentrateriscossione.gov.it';
const URL_SALDATI = `${BASE}/estratto-conto/situazione-debitoria#tab-saldati`;

function isAuthPage(url) {
  return /login|spid|sso|idp|identity|agid|entratel|fiscoonline/i.test(url) &&
         !url.includes('estratto-conto');
}

module.exports = {
  meta: {
    name: 'AdE Riscossione – Saldati',
    url: URL_SALDATI,
    authType: 'spid',
    loginUrl: URL_SALDATI,
    loginSuccessPattern: 'estratto-conto',
  },

  async run(db, siteId, session) {
    const { chromium } = require('playwright');
    const fs   = require('fs');
    const path = require('path');
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    const browser  = await chromium.launch({ headless });

    const captured = [];

    try {
      const context = session.storageState
        ? await browser.newContext({ storageState: session.storageState })
        : await browser.newContext();
      if (!session.storageState) await context.addCookies(session.cookies);

      const page = await context.newPage();

      // Intercetta risposte JSON che potrebbero contenere cartelle/debiti
      page.on('response', async res => {
        const url = res.url();
        const ct  = res.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;
        if (
          url.includes('saldati') || url.includes('pagat') || url.includes('debit') ||
          url.includes('cartell') || url.includes('estratto') || url.includes('situazione') ||
          url.includes('riscoss') || url.includes('rate') || url.includes('posiz')
        ) {
          try {
            const body = await res.json();
            captured.push({ url, body });
            console.log(`[ader-saldati] API intercettata: ${url.slice(0, 100)}`);
          } catch {}
        }
      });

      console.log('[ader-saldati] Navigazione a', URL_SALDATI);
      await page.goto(URL_SALDATI, { waitUntil: 'networkidle', timeout: 60000 });

      const finalUrl = page.url();
      console.log('[ader-saldati] URL finale:', finalUrl);

      if (isAuthPage(finalUrl)) {
        throw new Error('Sessione AdE Riscossione scaduta — vai in Accessi SPID e rifai il login.');
      }

      // Prova a cliccare sul tab "Saldati" se non è già attivo
      try {
        const tabClicked = await page.evaluate(() => {
          const selectors = [
            '[id*="saldati"]', '[href*="saldati"]', '[data-tab*="saldati"]',
            'button', 'a', 'li[role="tab"]',
          ];
          for (const sel of selectors) {
            const els = [...document.querySelectorAll(sel)];
            const tab = els.find(el =>
              el.textContent?.toLowerCase().includes('saldati') ||
              el.id?.toLowerCase().includes('saldati')
            );
            if (tab) { tab.click(); return true; }
          }
          return false;
        });
        if (tabClicked) {
          console.log('[ader-saldati] Tab Saldati cliccato, attendo rendering...');
          await page.waitForTimeout(3000);
          // Ulteriore networkidle dopo click
          try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
        }
      } catch {}

      await page.waitForTimeout(2000);

      // Dump HTML per debug
      const html = await page.content();
      const debugPath = path.join(__dirname, '..', 'data', 'debug-ader-saldati.html');
      fs.writeFileSync(debugPath, html, 'utf8');
      console.log(`[ader-saldati] HTML dump: ${debugPath} (${html.length} chars)`);

      // ── Estrazione DOM fallback ────────────────────────────────────────────
      const domRows = await page.evaluate(() => {
        const rows = [];

        // Pattern 1: righe tabella nella sezione saldati
        const tables = [
          ...document.querySelectorAll('[id*="saldati"] table, [class*="saldati"] table'),
          ...document.querySelectorAll('table'),
        ];

        for (const table of tables) {
          // Intestazioni
          const headers = [...table.querySelectorAll('th')]
            .map(th => th.textContent.trim())
            .filter(Boolean);

          // Corpo
          table.querySelectorAll('tbody tr, tr').forEach(tr => {
            const cells = [...tr.querySelectorAll('td')]
              .map(td => td.textContent.trim())
              .filter(Boolean);
            if (cells.length >= 2 && cells[0].length < 200) {
              const obj = { _cells: cells };
              headers.forEach((h, i) => { if (cells[i] !== undefined) obj[h] = cells[i]; });
              rows.push(obj);
            }
          });

          if (rows.length > 0) break; // Prima tabella con dati
        }

        // Pattern 2: card/lista elementi
        if (rows.length === 0) {
          document.querySelectorAll(
            '[class*="cartella"], [class*="debit"], [class*="pagament"], ' +
            '[class*="item"], mat-row, [role="row"]'
          ).forEach(el => {
            const text = el.textContent.trim();
            if (text.length > 5 && text.length < 500) {
              rows.push({ _text: text });
            }
          });
        }

        return rows;
      });

      console.log(`[ader-saldati] API: ${captured.length}, DOM: ${domRows.length}`);

      // ── Combina risultati ──────────────────────────────────────────────────
      let items = [];

      // Prima: dati da API JSON intercettate
      for (const { url, body } of captured) {
        const arr = Array.isArray(body) ? body
          : body?.data      ? (Array.isArray(body.data)     ? body.data     : [])
          : body?.items     ? (Array.isArray(body.items)    ? body.items    : [])
          : body?.cartelle  ? (Array.isArray(body.cartelle) ? body.cartelle : [])
          : body?.results   ? (Array.isArray(body.results)  ? body.results  : [])
          : body?.content   ? (Array.isArray(body.content)  ? body.content  : [])
          : body?.elenco    ? (Array.isArray(body.elenco)   ? body.elenco   : [])
          : [];

        for (const item of arr) {
          const id       = item.id || item.numeroCartella || item.codice || item.idPosizione
                        || String(Date.now() + items.length);
          const numero   = item.numeroCartella || item.numero || item.codice || id;
          const importo  = item.importoTotale  || item.importo || item.ammontare || '';
          const dataPag  = item.dataPagamento  || item.dataChiusura || item.data || '';
          const tipo     = item.tipoDebito     || item.tipo    || item.categoria || '';
          const ente     = item.enteAffidatario || item.ente  || item.creditore  || 'AdE Riscossione';
          const anno     = item.annoAccertamento || item.anno || '';

          items.push({
            externalId:   `ader-saldato:${id}`,
            title:        `Cartella ${numero}${anno ? ` (${anno})` : ''}`,
            organization: ente,
            location:     dataPag  || null,
            province:     null,
            contractType: tipo     || null,
            expiresAt:    null,
            rawJson: JSON.stringify({
              id, numero, importo, dataPagamento: dataPag,
              tipo, ente, anno,
              _raw: item,
            }),
          });
        }
      }

      // Fallback DOM
      if (items.length === 0) {
        items = domRows.map((row, i) => {
          const cells = row._cells || [];
          const text  = row._text  || cells.join(' — ');
          // Cerca pattern tipo "numero/anno" nella prima cella
          const numero = cells[0] || `riga-${i + 1}`;
          const importo = cells.find(c => /[0-9]+[,.]/.test(c)) || '';
          const data    = cells.find(c => /\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(c)) || '';

          return {
            externalId:   `ader-saldato:dom:${i}`,
            title:        numero.length < 100 ? `Cartella ${numero}` : text.slice(0, 100),
            organization: 'AdE Riscossione',
            location:     data    || null,
            province:     null,
            contractType: importo || null,
            expiresAt:    null,
            rawJson: JSON.stringify({ _cells: cells, _text: text }),
          };
        });
      }

      console.log(`[ader-saldati] Totale: ${items.length}`);
      return items;

    } finally {
      await browser.close();
    }
  },
};
