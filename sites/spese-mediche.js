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

const TAB_URL = 'https://sistemats5.sanita.finanze.it/730PreServiziCittadinoWeb/pages/includes/consultazione/tabConsultazione.jsf';

module.exports = {
  meta: {
    name:                'Spese Mediche',
    url:                 TAB_URL,
    authType:            'spid',
    loginUrl:            'https://sistemats1.sanita.finanze.it/portale/area-riservata-cittadino',
    // No loginSuccessPattern: use generic urlChanged detection.
    // Liferay redirects unauthenticated users to /portale/login, so initialUrl ≠ post-login URL.
    // This ensures the JSESSIONID and proper auth cookies are captured after SPID completes.
  },

  async run(db, siteId, session) {
    if (!session) throw new Error('Sessione SPID mancante. Vai in Accessi SPID e autenticati prima di eseguire.');

    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
    });

    // Inject session cookies
    if (session.cookies && session.cookies.length > 0) {
      await context.addCookies(session.cookies);
    }

    const page = await context.newPage();

    try {
      // Step 1: visit sistemats1 first to restore the session via SSO.
      // sistemats1 is the SPID portal; cookies injected here let the browser
      // establish the Shibboleth SP session for sistemats1.
      const PORTAL_URL = 'https://sistemats1.sanita.finanze.it/portale/area-riservata-cittadino';
      console.log('[Spese Mediche] Ripristino sessione su sistemats1...');
      await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 30000 });
      const portalUrl = page.url();
      if (portalUrl.includes('/login') || portalUrl.includes('/spid') || portalUrl.includes('agid') || portalUrl.includes('identity')) {
        await browser.close();
        throw new Error('Sessione sistemats1 scaduta (redirect al login SPID). Vai in Accessi SPID e rifai il login.');
      }
      console.log(`[Spese Mediche] Portale ok (${portalUrl.slice(0, 60)}). Navigo alle spese...`);

      // Step 2: now navigate to sistemats5 — the browser has the SSO context
      // from sistemats1 and the Shibboleth IdP cookies, so sistemats5 will issue
      // a new SP session automatically via SSO without prompting for credentials.
      await page.goto(TAB_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('#annoScelto', { timeout: 15000 });
    } catch (err) {
      await browser.close();
      throw new Error(`Impossibile caricare la pagina spese. Sessione scaduta? ${err.message}`);
    }

    // Get available years
    const years = await page.$$eval('#annoScelto option', opts => opts.map(o => o.value).filter(v => v));

    const dlDir = path.join(__dirname, '..', 'data', 'spese-mediche');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

    const currentYear = String(new Date().getFullYear());
    const results = [];

    for (const year of years) {
      console.log(`[Spese Mediche] Anno ${year}...`);
      try {
        // Select year and submit Cerca
        await page.selectOption('#annoScelto', year);
        await page.locator('#formAttivi button[type="submit"]').first().click();
        await page.waitForLoadState('networkidle', { timeout: 20000 });

        // Extract total amount from page text
        const totalText = await page.evaluate(() => {
          const all = document.querySelectorAll('strong, b, span, p, div, h2, h3, h4');
          for (const el of all) {
            if (el.children.length === 0 && el.textContent.includes('Totale importo')) {
              return el.closest('p,div,span')?.textContent?.trim() || el.textContent.trim();
            }
          }
          // fallback: search whole page text
          const body = document.body.innerText;
          const m = body.match(/Totale importo[:\s]*€?\s*([\d.,]+)/i);
          return m ? `€ ${m[1]}` : '';
        });

        // Extract table rows (current year: all visible rows; other years: first page only)
        const rows = await page.evaluate(() => {
          const trs = [...document.querySelectorAll('#formAttivi table tbody tr, .table-spese tbody tr, table tbody tr')];
          return trs.map(tr => {
            const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
            return cells.filter(c => c && !c.startsWith('Visualizza'));
          }).filter(r => r.length >= 3);
        });

        // Download XLS
        let xlsFilename = null;
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }),
            page.click('#btnScaricaSpese'),
          ]);
          xlsFilename = `spese_${year}.xls`;
          await download.saveAs(path.join(dlDir, xlsFilename));
          console.log(`[Spese Mediche] XLS ${year} scaricato (${xlsFilename})`);
        } catch (dlErr) {
          console.warn(`[Spese Mediche] Download XLS ${year} fallito: ${dlErr.message}`);
        }

        results.push({
          externalId:   `spese-${year}`,
          title:        `Spese sanitarie ${year}`,
          organization: 'Sistema Tessera Sanitaria',
          location:     null,
          province:     null,
          contractType: totalText || null,
          expiresAt:    null,
          rawJson: JSON.stringify({
            year,
            total:       totalText || null,
            xlsFilename: xlsFilename,
            rows:        year === String(new Date().getFullYear()) ? rows : rows.slice(0, 5),
            scrapedAt:   new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.warn(`[Spese Mediche] Anno ${year} errore: ${err.message}`);
      }
    }

    await browser.close();
    return results;
  },
};
