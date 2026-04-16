'use strict';

/**
 * Scraper – INPS Centro notifiche
 * URL: https://servizi2.inps.it/servizi/areariservata/centro-notifiche
 *
 * Recupera notifiche, scadenze e appuntamenti dall'area riservata INPS.
 * Sessione condivisa con inps-dati (meta.authSite).
 *
 * Strategia:
 *   1. Playwright con intercettazione XHR/fetch di Angular
 *      per catturare la risposta API delle notifiche
 *   2. Fallback: estrazione DOM dalla lista renderizzata
 */

const BASE = 'https://servizi2.inps.it';
const URL_NOTIFICHE = `${BASE}/servizi/areariservata/centro-notifiche`;

function isAuthPage(url) {
  return /login|spid|sso|idp|identity|agid/i.test(url) && !url.includes('areariservata');
}

module.exports = {
  meta: {
    name: 'INPS – Centro notifiche',
    url: URL_NOTIFICHE,
    authType: 'spid',
    authSite: 'inps-dati',
    loginUrl: `${BASE}/servizi/areariservata/dati`,
    loginSuccessPattern: 'areariservata',
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

      // Intercetta risposte JSON che potrebbero contenere notifiche
      page.on('response', async res => {
        const url = res.url();
        const ct  = res.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;
        if (
          url.includes('notif') || url.includes('avvis') || url.includes('message') ||
          url.includes('alert') || url.includes('comunicaz') || url.includes('centro') ||
          url.includes('scadenz') || url.includes('appuntament')
        ) {
          try {
            const body = await res.json();
            captured.push({ url, body });
            console.log(`[inps-notifiche] API intercettata: ${url.slice(0, 100)}`);
          } catch {}
        }
      });

      console.log('[inps-notifiche] Navigazione a', URL_NOTIFICHE);
      await page.goto(URL_NOTIFICHE, { waitUntil: 'networkidle', timeout: 45000 });

      const finalUrl = page.url();
      console.log('[inps-notifiche] URL finale:', finalUrl);

      if (isAuthPage(finalUrl)) {
        throw new Error('Sessione INPS scaduta — vai in Accessi SPID e rifai il login.');
      }

      await page.waitForTimeout(3000);

      // Dump HTML per debug
      const html = await page.content();
      const debugPath = path.join(__dirname, '..', 'data', 'debug-inps-notifiche.html');
      fs.writeFileSync(debugPath, html, 'utf8');
      console.log(`[inps-notifiche] HTML dump: ${debugPath} (${html.length} chars)`);

      // ── Estrazione DOM fallback ──────────────────────────────────────────
      const domItems = await page.evaluate(() => {
        const items = [];

        // Pattern 1: card/item notifica
        document.querySelectorAll(
          '[class*="notific"], [class*="avviso"], [class*="alert-item"], ' +
          'mat-list-item, [class*="notification"], [class*="message-item"]'
        ).forEach(card => {
          const title = card.querySelector('[class*="title"],[class*="titolo"],h2,h3,strong')?.textContent?.trim();
          const date  = card.querySelector('[class*="date"],[class*="data"],time')?.textContent?.trim();
          const body  = card.querySelector('[class*="body"],[class*="testo"],p')?.textContent?.trim();
          const type  = card.querySelector('[class*="type"],[class*="tipo"],[class*="tag"],[class*="categ"]')?.textContent?.trim();
          if (title) items.push({ title, date, body, type });
        });

        // Pattern 2: righe tabella
        if (items.length === 0) {
          document.querySelectorAll('table tr').forEach(tr => {
            const cells = [...tr.querySelectorAll('td')].map(c => c.textContent.trim()).filter(Boolean);
            if (cells.length >= 2 && cells[0].length < 300) {
              items.push({ title: cells[0], date: cells[1], body: cells[2] || '', type: cells[3] || '' });
            }
          });
        }

        // Pattern 3: lista generica
        if (items.length === 0) {
          document.querySelectorAll('ul li, ol li').forEach(li => {
            const text = li.textContent.trim();
            if (text.length > 10 && text.length < 500) items.push({ title: text });
          });
        }

        return items;
      });

      console.log(`[inps-notifiche] API: ${captured.length}, DOM: ${domItems.length}`);

      // ── Combina risultati ────────────────────────────────────────────────
      let notifications = [];

      for (const { url, body } of captured) {
        const arr = Array.isArray(body) ? body
          : body?.data        ? (Array.isArray(body.data)       ? body.data       : [])
          : body?.items       ? (Array.isArray(body.items)      ? body.items      : [])
          : body?.notifiche   ? (Array.isArray(body.notifiche)  ? body.notifiche  : [])
          : body?.results     ? (Array.isArray(body.results)    ? body.results    : [])
          : body?.content     ? (Array.isArray(body.content)    ? body.content    : [])
          : [];

        for (const item of arr) {
          notifications.push({
            id:     item.id || item.idNotifica || item.uuid || String(Date.now() + notifications.length),
            title:  item.titolo  || item.title  || item.oggetto   || item.descrizione || '(senza titolo)',
            body:   item.testo   || item.body   || item.messaggio || item.descrizioneEstesa || '',
            date:   item.data    || item.dataCreazione || item.dataScadenza || item.timestamp || '',
            type:   item.tipo    || item.type   || item.categoria || item.tag || '',
            raw:    item,
          });
        }
      }

      if (notifications.length === 0) {
        notifications = domItems.map((item, i) => ({
          id:    String(i),
          title: item.title || '(senza titolo)',
          body:  item.body  || '',
          date:  item.date  || '',
          type:  item.type  || '',
          raw:   item,
        }));
      }

      console.log(`[inps-notifiche] Totale: ${notifications.length}`);

      return notifications.map(n => ({
        externalId:   `notifica:${n.id}`,
        title:        n.title,
        organization: 'INPS',
        location:     n.date || null,
        province:     null,
        contractType: n.type || null,
        expiresAt:    null,
        rawJson: JSON.stringify({
          id:        n.id,
          sender:    'INPS',
          title:     n.title,
          body:      n.body,
          timestamp: n.date,
          tag:       n.type,
          read_at:   null,
          _raw:      n.raw,
        }),
      }));

    } finally {
      await browser.close();
    }
  },
};
