'use strict';

/**
 * Scraper – INPS "I miei dati"
 * URL: https://servizi2.inps.it/servizi/areariservata/dati
 * Sezioni: Anagrafica + Consensi
 *
 * authType: 'spid' — login tramite portale INPS con SPID.
 * Questo modulo è anche il sito "primario" per la sessione condivisa:
 * tutti gli altri moduli inps-* usano meta.authSite = 'inps-dati'.
 */

const BASE = 'https://servizi2.inps.it';
const DATI_URL = `${BASE}/servizi/areariservata/dati`;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Attende che un selettore appaia, con timeout morbido */
async function waitFor(page, selector, timeout = 15000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

/** Tenta di estrarre coppie label→valore da una pagina Angular INPS */
async function extractLabeledData(page) {
  return page.evaluate(() => {
    const result = {};

    // Pattern 1: <dt>label</dt><dd>valore</dd>
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const key   = dt.textContent.trim().replace(/:$/, '');
        const value = dd.textContent.trim();
        if (key && value && key.length < 80) result[key] = value;
      }
    });

    // Pattern 2: righe tabella label | valore
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td, th')].map(c => c.textContent.trim());
      if (cells.length >= 2 && cells[0] && cells[1]) {
        const key = cells[0].replace(/:$/, '');
        if (key.length < 80 && cells[1].length < 300 && !/^\s*$/.test(cells[1])) {
          result[key] = cells[1];
        }
      }
    });

    // Pattern 3: Angular Material — mat-list-item o inps-field
    document.querySelectorAll('[class*="label"], [class*="field-label"], mat-label').forEach(el => {
      const label = el.textContent.trim().replace(/:$/, '');
      // cerca il valore nel sibling o nel parent
      let val = null;
      const sib = el.nextElementSibling;
      if (sib) val = sib.textContent.trim();
      if (!val) {
        const parent = el.parentElement;
        const children = [...(parent?.children || [])].filter(c => c !== el);
        if (children[0]) val = children[0].textContent.trim();
      }
      if (label && val && label.length < 80 && val.length < 300) {
        result[label] = val;
      }
    });

    // Pattern 4: coppie strong/span con testo
    document.querySelectorAll('strong').forEach(strong => {
      const text = strong.textContent.trim().replace(/:$/, '');
      const next = strong.nextSibling;
      const val  = next ? next.textContent.trim() : null;
      if (text && val && text.length < 60 && val.length < 300 && !result[text]) {
        result[text] = val;
      }
    });

    return result;
  });
}

/** Rileva se la pagina ha reindirizzato al login */
function isAuthPage(url) {
  return /login|spid|sso|idp|identity|agid|auth/i.test(url) &&
         !url.includes('areariservata');
}

// ── Module export ───────────────────────────────────────────────────────────

module.exports = {
  meta: {
    name: 'INPS – I miei dati',
    url: DATI_URL,
    authType: 'spid',
    // Il login parte dall'areariservata: se non autenticato, INPS redirige a SPID
    loginUrl: DATI_URL,
    loginSuccessPattern: 'areariservata',
    // Nota: questo modulo è il sito primario per la sessione INPS condivisa.
    // Gli altri moduli inps-* devono usare meta.authSite = 'inps-dati'.
  },

  async run(db, siteId, session) {
    const { chromium } = require('playwright');
    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    const browser  = await chromium.launch({ headless });

    let anagrafica = {};
    let consensi   = [];

    try {
      // Crea contesto con storageState (cookie + localStorage)
      const context = session.storageState
        ? await browser.newContext({ storageState: session.storageState })
        : await browser.newContext();

      if (!session.storageState) {
        await context.addCookies(session.cookies);
      }

      const page = await context.newPage();

      // ── Naviga alla pagina dati ───────────────────────────────────────────
      console.log('[inps-dati] Navigazione a', DATI_URL);
      await page.goto(DATI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const finalUrl = page.url();
      console.log('[inps-dati] URL finale:', finalUrl);

      if (isAuthPage(finalUrl)) {
        throw new Error(
          'Sessione INPS scaduta o non disponibile — vai in "Accessi SPID", clicca Accedi su INPS e completa il login SPID.'
        );
      }

      // Attendi che Angular carichi il contenuto (cerca elementi comuni nelle SPA INPS)
      const loaded = await waitFor(page, 'main, [class*="content"], mat-card, .container, article', 12000);
      if (!loaded) {
        console.warn('[inps-dati] Timeout attesa contenuto — provo ad estrarre comunque');
      }
      // Extra delay per Angular late rendering
      await page.waitForTimeout(2000);

      console.log('[inps-dati] Estrazione dati anagrafica...');
      anagrafica = await extractLabeledData(page);
      console.log(`[inps-dati] Campi anagrafica trovati: ${Object.keys(anagrafica).length}`);

      // ── Sezione Consensi (tab o URL dedicata) ────────────────────────────
      // Prova prima a cliccare su tab "Consensi" se presente nella stessa pagina
      const consensiTab = await page.$('[class*="consensi"], button:has-text("Consensi"), a:has-text("Consensi"), mat-tab:has-text("Consensi")');
      if (consensiTab) {
        console.log('[inps-dati] Trovato tab/link Consensi — clicco');
        await consensiTab.click();
        await page.waitForTimeout(1500);
        const consensiData = await extractLabeledData(page);
        // Aggiungi prefisso per distinguerli dall'anagrafica
        for (const [k, v] of Object.entries(consensiData)) {
          if (!anagrafica[k]) anagrafica[`Consenso – ${k}`] = v;
        }
      }

      // Raccoglie anche elementi di lista per i consensi
      consensi = await page.evaluate(() => {
        const items = [];
        // Pattern: righe con checkbox/toggle e descrizione consenso
        document.querySelectorAll('[class*="consenso"], [class*="consent"], [class*="privacy"] li').forEach(el => {
          const text = el.textContent.trim();
          if (text && text.length > 5 && text.length < 500) items.push(text);
        });
        return items;
      });
      console.log(`[inps-dati] Consensi trovati: ${consensi.length}`);

      // Se non abbiamo trovato nulla, salva snapshot HTML per debug
      if (Object.keys(anagrafica).length === 0) {
        const html = await page.content();
        console.warn(`[inps-dati] Nessun dato estratto. HTML length: ${html.length}`);
        console.warn('[inps-dati] Primi 2000 caratteri del body:');
        console.warn(html.slice(0, 2000));
        // Ritorna almeno un risultato-placeholder con l'URL corrente
        anagrafica['_url'] = page.url();
        anagrafica['_nota'] = 'Nessun dato estratto — verifica il selettore o il login';
      }

    } finally {
      await browser.close();
    }

    // ── Costruisci risultati ─────────────────────────────────────────────────
    // Ogni campo dell'anagrafica diventa una "riga" nel formato standard.
    // externalId = chiave del campo per deduplication.
    const anaItems = Object.entries(anagrafica).map(([key, value]) => ({
      externalId:   `dati:${key}`,
      title:        key,
      organization: 'INPS',
      location:     null,
      province:     null,
      contractType: null,
      expiresAt:    null,
      rawJson:      JSON.stringify({ key, value, section: 'anagrafica' }),
    }));

    const consItems = consensi.map((text, i) => ({
      externalId:   `consenso:${i}`,
      title:        text,
      organization: 'INPS',
      location:     null,
      province:     null,
      contractType: null,
      expiresAt:    null,
      rawJson:      JSON.stringify({ text, section: 'consensi', index: i }),
    }));

    const all = [...anaItems, ...consItems];
    console.log(`[inps-dati] Totale risultati: ${all.length}`);
    return all;
  },
};
