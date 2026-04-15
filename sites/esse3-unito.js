'use strict';

/**
 * Scraper – ESSE3 UniTo
 * Libretto: https://esse3.unito.it/auth/studente/Libretto/LibrettoHome.do
 * Carriera: https://esse3.unito.it/auth/studente/HomePageStudente.do
 *
 * authType: 'spid' → il login avviene tramite finestra Playwright.
 * Apre la pagina home dello studente; se non autenticato, ESSE3 redirige al
 * login (credenziali UniTo / SPID / CIE). Completato il login, session.js
 * salva i cookie automaticamente.
 */

const { upsertLibrettoExam, saveCarriera } = require('../core/db');

const ESSE3 = 'https://esse3.unito.it';

// ── HTML parsing helpers ────────────────────────────────────────────────────

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Estrae tutte le <table> della pagina come array di righe (array di stringhe).
 * Usa un approccio stack-based per gestire correttamente le tabelle nidificate.
 */
function extractTables(html) {
  const out = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');

  // Stack-based extraction: trova aperture e chiusure di <table>
  const tagRe = /<(\/?)table[\s> ]/gi;
  const stack = [];
  let m;

  while ((m = tagRe.exec(clean)) !== null) {
    if (!m[1]) {
      // apertura <table>
      stack.push(m.index);
    } else if (stack.length > 0) {
      // chiusura </table>
      const start = stack.pop();
      if (stack.length === 0) {
        // tabella di livello top
        const tableHtml = clean.slice(start, m.index + m[0].length);
        const rows = parseTableRows(tableHtml);
        if (rows.length >= 2) out.push(rows);
      }
    }
  }
  return out;
}

/**
 * Estrae le righe di una singola tabella (senza nidificazione).
 * Ignora le sotto-tabelle nei <td>.
 */
function parseTableRows(tableHtml) {
  const rows = [];
  // Rimuovi sotto-tabelle per non confondere i <tr>
  const flat = tableHtml.replace(/<table[\s\S]*?<\/table>/gi, '');
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let tr;
  while ((tr = trRe.exec(flat)) !== null) {
    const cols = [];
    let td;
    const tdRe2 = new RegExp(tdRe.source, 'gi');
    while ((td = tdRe2.exec(tr[1])) !== null) {
      cols.push(stripTags(td[1]));
    }
    if (cols.some(c => c)) rows.push(cols);
  }
  return rows;
}

/**
 * Cerca la tabella del libretto tra tutte le tabelle della pagina.
 * Strategia primaria: intestazione con "Attività Didattiche" o "Materia/Insegnamento"
 * Strategia secondaria: tabella con voti (18-30)
 */
function findLibrettoTable(tables) {
  for (const t of tables) {
    const header = (t[0] || []).join(' ').toLowerCase();
    if (header.includes('attivit') || header.includes('insegnamento') ||
        header.includes('materia') || header.includes('didattich')) {
      return t;
    }
  }
  // fallback: righe con pattern voto numerico
  for (const t of tables) {
    if (t.length < 3) continue;
    const hasGrades = t.slice(1).some(row =>
      row.some(cell => /\b(1[89]|2\d|30L?)\b/.test(cell))
    );
    if (hasGrades && t[0].length >= 3) return t;
  }
  return null;
}

/**
 * Rileva le colonne del libretto dall'intestazione.
 * Gestisce sia il formato "standard" (CFU/Voto separati) sia il formato UniTo
 * (Peso + "Voto - Data Esame" combinato).
 */
function detectColumns(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const low = h.toLowerCase().replace(/\s+/g, ' ');
    if (!idx.attivita && /attivit|insegnamento|materia|didattich/.test(low)) idx.attivita = i;
    if (!idx.codice   && /^cod\.?$|^codice$/.test(low))                      idx.codice   = i;
    if (!idx.cfu      && /^cfu$|^peso$|crediti/.test(low))                   idx.cfu      = i;
    if (!idx.votodata && /voto.*data|data.*voto/.test(low))                   idx.votodata = i;
    if (!idx.voto     && !idx.votodata && /^voto$|^grade$|^esito$/.test(low)) idx.voto    = i;
    if (!idx.data     && !idx.votodata && /^data/.test(low))                  idx.data     = i;
    if (!idx.stato    && /^stato$|status/.test(low))                          idx.stato    = i;
    if (!idx.anno     && /^anno$/.test(low))                                  idx.anno     = i;
    if (!idx.settore  && /settore|ssd|ambito/.test(low))                      idx.settore  = i;
  });
  return idx;
}

/**
 * Divide la cella "Voto - Data Esame" nel formato UniTo.
 * Esempi: "24 - 24/07/2001", "30L - 15/01/2020", "24&nbsp;-&nbsp;24/07/2001"
 */
function parseVotoData(cell) {
  if (!cell) return { voto: null, data_esame: null };
  const clean = cell.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  // Pattern: <voto> - <data>
  const m = clean.match(/^(30L?|[1-3]\d)\s*[-–]\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/i);
  if (m) return { voto: m[1], data_esame: m[2] };
  // Solo voto senza data
  if (/^(30L?|[1-3]\d)$/.test(clean)) return { voto: clean, data_esame: null };
  return { voto: null, data_esame: null };
}

/**
 * Separa codice e nome dalla cella "Attività Didattiche".
 * Esempio: "16007 - BIOLOGIA GENERALE" → { codice: "16007", materia: "BIOLOGIA GENERALE" }
 */
function parseAttivita(cell) {
  if (!cell) return { codice: '', materia: '' };
  const m = cell.match(/^(\d+)\s*[-–]\s*(.+)$/);
  if (m) return { codice: m[1].trim(), materia: m[2].trim() };
  return { codice: '', materia: cell.trim() };
}

function parseLibretto(html) {
  const tables = extractTables(html);
  const table  = findLibrettoTable(tables);
  if (!table) return [];

  const [headerRow, ...dataRows] = table;
  const cols = detectColumns(headerRow);

  return dataRows
    .filter(r => r.some(c => c))
    .map(row => {
      const get = (key, fallback) =>
        cols[key] !== undefined ? (row[cols[key]] || '').trim() : (row[fallback] || '').trim();

      // Cella "Attività Didattiche" (UniTo) o fallback colonna 0
      const attCell  = get('attivita', 0);
      const { codice, materia } = parseAttivita(attCell);

      // CFU: colonna "Peso" o "CFU"
      const cfuRaw   = get('cfu', 2);
      const cfu      = parseInt(cfuRaw) || null;

      // Voto e data: possono essere in cella combinata o separate
      let voto = null, data_esame = null;
      if (cols.votodata !== undefined) {
        const vd = parseVotoData(row[cols.votodata] || '');
        voto      = vd.voto;
        data_esame = vd.data_esame;
      } else {
        voto      = get('voto', 3) || null;
        data_esame = get('data', 4) || null;
      }

      return {
        codice,
        materia,
        cfu,
        voto,
        data_esame,
        stato:   get('stato', 5) || (voto ? 'Superato' : null),
        settore: get('settore', -1) || null,
      };
    })
    .filter(e => e.materia);
}

/**
 * Estrae le info studente dalla pagina carriera.
 * Cerca coppie label→valore in tutte le tabelle.
 */
function parseCarriera(html) {
  const tables = extractTables(html);
  const data   = {};

  // Estrai coppie label:valore
  for (const t of tables) {
    for (const row of t) {
      if (row.length >= 2) {
        const key = row[0].replace(/:$/, '').trim();
        const val = row[1].trim();
        if (key && val && key.length < 80 && val.length < 300 && !/^\s*$/.test(val)) {
          // Ignora chiavi numeriche o troppo generiche
          if (!/^\d+$/.test(key) && key !== '-') {
            data[key] = val;
          }
        }
      }
    }
  }

  // Cerca anche pattern "Nome Cognome" nel titolo/header della pagina
  const nameMatch = html.match(/<h[12][^>]*>[^<]*([A-Z]{2,}[^<]{3,})<\/h[12]>/i);
  if (nameMatch && !data['Nome'] && !data['Studente']) {
    const candidate = stripTags(nameMatch[0]);
    if (candidate && candidate.length < 60) data['_intestazione'] = candidate;
  }

  return data;
}

// ── Module export ───────────────────────────────────────────────────────────

module.exports = {
  meta: {
    name: 'ESSE3 UniTo',
    url: 'https://esse3.unito.it/auth/studente/HomePageStudente.do',
    authType: 'spid',
    // Il login richiede browser: apre la pagina home, ESSE3 redirige al login
    loginUrl: 'https://esse3.unito.it/auth/studente/HomePageStudente.do',
    // Rilevamento successo: URL deve contenere "HomePageStudente" con cookie attivi
    loginSuccessPattern: 'HomePageStudente',
  },

  async run(db, siteId, session) {
    // ESSE3 usa Shibboleth SSO con cookie su più domini (SPID, IdP, ESSE3).
    // session.fetch() manda i cookie solo al dominio iniziale causando redirect loop.
    // Soluzione: usa Playwright con tutti i cookie iniettati sui domini corretti.
    const { chromium } = require('playwright');

    const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
    const browser  = await chromium.launch({ headless });
    let libHtml, carHtml;

    try {
      // Usa storageState se disponibile (modo corretto per Playwright),
      // altrimenti fallback su addCookies
      console.log(`[esse3-unito] storageState disponibile: ${!!session.storageState}`);
      if (session.storageState) {
        const sc = (session.storageState.cookies || []);
        console.log(`[esse3-unito] storageState cookies (${sc.length}): ${sc.map(c => `${c.name}@${c.domain}`).join(', ')}`);
      }
      const context = session.storageState
        ? await browser.newContext({ storageState: session.storageState })
        : await browser.newContext();
      if (!session.storageState) {
        await context.addCookies(session.cookies);
      }
      const page = await context.newPage();

      /** Naviga a un URL ESSE3 gestendo redirect-loop = sessione scaduta */
      async function gotoEsse3(url) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
          console.log(`[esse3-unito] goto error per ${url}: ${e.message}`);
          if (/redirect|ERR_TOO_MANY/i.test(e.message)) {
            throw new Error(
              'Sessione ESSE3 scaduta — vai in "Accessi SPID", clicca Accedi su ESSE3 UniTo e ripeti il login'
            );
          }
          throw e;
        }
        const url2 = page.url();
        console.log(`[esse3-unito] URL finale dopo goto: ${url2}`);
        if (/Autenticazione|\/login|\/sso\/idp/i.test(url2)) {
          throw new Error(
            'Sessione ESSE3 scaduta — vai in "Accessi SPID", clicca Accedi su ESSE3 UniTo e ripeti il login'
          );
        }
      }

      // ── Libretto ──────────────────────────────────────────────────────────
      console.log('[esse3-unito] Fetching libretto...');
      await gotoEsse3(`${ESSE3}/auth/studente/Libretto/LibrettoHome.do`);
      // Attendi che la pagina sia completamente caricata
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      libHtml = await page.content();
      console.log(`[esse3-unito] Libretto HTML length: ${libHtml.length}`);
      // Log delle tabelle trovate per debug
      const _dbgTables = extractTables(libHtml);
      console.log(`[esse3-unito] Tabelle trovate: ${_dbgTables.length}`);
      _dbgTables.forEach((t, i) => {
        console.log(`  [${i}] header: ${JSON.stringify(t[0]?.slice(0,4))}, righe: ${t.length}`);
      });

      // ── Carriera ──────────────────────────────────────────────────────────
      console.log('[esse3-unito] Fetching carriera...');
      await gotoEsse3(`${ESSE3}/auth/studente/HomePageStudente.do`);
      carHtml = await page.content();

    } finally {
      await browser.close();
    }

    // ── Parsing ──────────────────────────────────────────────────────────────
    const exams    = parseLibretto(libHtml);
    const carriera = parseCarriera(carHtml);
    console.log(`[esse3-unito] ${exams.length} esami, ${Object.keys(carriera).length} campi carriera`);

    // ── Salva nei custom tables ───────────────────────────────────────────────
    const lastRun = db.prepare(
      `SELECT id FROM runs WHERE site_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`
    ).get(siteId);
    const runId = lastRun ? lastRun.id : null;

    let newExams = 0;
    for (const exam of exams) {
      const { isNew } = upsertLibrettoExam(runId, exam);
      if (isNew) newExams++;
    }
    console.log(`[esse3-unito] Esami: ${exams.length} totali, ${newExams} nuovi`);

    if (Object.keys(carriera).length > 0) {
      saveCarriera(carriera);
    }

    // ── Formato generico per il runner ────────────────────────────────────────
    return exams.map(e => ({
      externalId:   e.codice || e.materia,
      title:        e.materia,
      organization: carriera['Corso di Studio'] || carriera['Corso di laurea'] || carriera['CdL'] || 'UniTo',
      location:     e.cfu ? `${e.cfu} CFU` : '',
      province:     null,
      contractType: e.voto || e.stato || '',
      expiresAt:    null,
      rawJson:      JSON.stringify(e),
    }));
  },
};
