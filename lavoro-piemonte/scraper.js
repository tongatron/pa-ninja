/**
 * Scraper - Lavoro Piemonte (pslp.regione.piemonte.it)
 * Endpoint: POST /pslpbff/api-public/v1/annunci-pslp/consulta-annunci
 * Nessuna autenticazione richiesta.
 *
 * Utilizzo:
 *   node scraper.js                          # tutti gli annunci Piemonte
 *   node scraper.js --provincia TORINO        # solo provincia di Torino
 *   node scraper.js --cpi TORINO              # solo CPI di Torino
 *   node scraper.js --keyword INFORMATICO     # filtra per parola (post-processing)
 *   node scraper.js --art1                    # solo art.1 L.68/99
 *   node scraper.js --details                 # scarica anche il dettaglio di ogni annuncio
 */

const fs   = require('fs');
const path = require('path');

// ── Configurazione ─────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:            'https://pslp.regione.piemonte.it/pslpbff/api-public/v1/annunci-pslp',
  pageSize:           20,    // l'API restituisce max 20 per pagina
  outputDir:          './output',
  delayBetweenPages:  250,   // ms di pausa tra le pagine (gentile verso il server)
};

// ── Parsing argomenti ──────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const withDetails = args.includes('--details');
const art1Only    = args.includes('--art1');
const art18Only   = args.includes('--art18');
const tirocinioOnly = args.includes('--tirocinio');

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1]?.toUpperCase() : undefined;
}

const provinciaArg = getArg('--provincia');   // es. TORINO
const cpiArg       = getArg('--cpi');          // es. TORINO
const keywordArg   = getArg('--keyword');      // es. INFORMATICO

// ── Costruzione body API ───────────────────────────────────────────────────
function buildBody() {
  return {
    art1:          art1Only    ? 'S' : (art18Only || tirocinioOnly ? 'N' : 'T'),
    art18:         art18Only   ? 'S' : (art1Only  || tirocinioOnly ? 'N' : 'T'),
    tirocinio:     tirocinioOnly ? 'S' : (art1Only || art18Only    ? 'N' : 'T'),
    soloAnnunciCpi: 'N',
  };
}

// ── Filtro client-side ─────────────────────────────────────────────────────
function matchesFilter(a) {
  if (provinciaArg && a.descrProvinciaSede?.toUpperCase() !== provinciaArg) return false;
  if (cpiArg       && a.descrCpi?.toUpperCase() !== cpiArg)                 return false;
  if (keywordArg) {
    const haystack = [a.titoloVacancy, a.qualifica, a.dsProfiloIstat]
      .join(' ').toUpperCase();
    if (!haystack.includes(keywordArg)) return false;
  }
  return true;
}

// ── Utilità ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(page) {
  const url = `${CONFIG.baseUrl}/consulta-annunci?page=${page}&recForPage=${CONFIG.pageSize}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': 'https://pslp.regione.piemonte.it/' },
    body:    JSON.stringify(buildBody()),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} su pagina ${page}`);
  return res.json();
}

async function fetchDetail(idAnnuncio) {
  const res = await fetch(`${CONFIG.baseUrl}/get-dettaglio/${encodeURIComponent(idAnnuncio)}`, {
    headers: { 'Referer': 'https://pslp.regione.piemonte.it/' }
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.esitoPositivo ? json : null;
}

// ── Scraper principale ─────────────────────────────────────────────────────
async function scrape() {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // Riepilogo filtri attivi
  const activeFilters = [];
  if (provinciaArg)   activeFilters.push(`provincia=${provinciaArg}`);
  if (cpiArg)         activeFilters.push(`cpi=${cpiArg}`);
  if (keywordArg)     activeFilters.push(`keyword="${keywordArg}"`);
  if (art1Only)       activeFilters.push('art1=S');
  if (art18Only)      activeFilters.push('art18=S');
  if (tirocinioOnly)  activeFilters.push('tirocinio=S');
  console.log(`🔍 Avvio scraping${activeFilters.length ? ' [' + activeFilters.join(', ') + ']' : ' [tutti gli annunci]'}...`);

  // Prima pagina
  const first = await fetchPage(0);
  if (!first.esitoPositivo) { console.error('❌ Risposta negativa:', first); process.exit(1); }

  const totalPages   = first.totalPage;
  const totalResults = first.totalResult;
  console.log(`📄 Totale API: ${totalResults} annunci, ${totalPages} pagine`);

  let allAnnunci = [...first.list];

  // Scarica le pagine rimanenti
  for (let p = 1; p < totalPages; p++) {
    process.stdout.write(`\r⏳ Pagina ${p + 1}/${totalPages} (scaricati: ${allAnnunci.length})...`);
    await sleep(CONFIG.delayBetweenPages);
    const page = await fetchPage(p);
    if (!page.esitoPositivo) { console.warn(`\n⚠️  Pagina ${p} fallita, salto`); continue; }
    allAnnunci.push(...page.list);
  }
  console.log(`\n✅ Scaricati ${allAnnunci.length} annunci totali`);

  // Applica filtri client-side
  const filtered = (provinciaArg || cpiArg || keywordArg)
    ? allAnnunci.filter(matchesFilter)
    : allAnnunci;

  if (filtered.length !== allAnnunci.length)
    console.log(`🔎 Dopo filtro: ${filtered.length} annunci`);

  // Dettagli opzionali (solo sugli annunci filtrati)
  if (withDetails) {
    console.log('🔎 Scarico dettagli...');
    for (let i = 0; i < filtered.length; i++) {
      process.stdout.write(`\r⏳ Dettaglio ${i + 1}/${filtered.length}...`);
      await sleep(CONFIG.delayBetweenPages);
      const detail = await fetchDetail(filtered[i].idAnnuncio);
      if (detail) filtered[i] = { ...filtered[i], ...detail };
    }
    console.log('\n✅ Dettagli completati');
  }

  // Salva output
  const tag       = [provinciaArg, cpiArg, keywordArg].filter(Boolean).join('_') || 'tutti';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base      = `annunci_${tag}_${timestamp}`;

  // JSON
  const jsonPath = path.join(CONFIG.outputDir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    meta: {
      totalAPI: totalResults,
      totalFiltered: filtered.length,
      scrapedAt: new Date().toISOString(),
      filters: { provincia: provinciaArg, cpi: cpiArg, keyword: keywordArg, art1: art1Only, art18: art18Only, tirocinio: tirocinioOnly }
    },
    annunci: filtered
  }, null, 2));
  console.log(`💾 JSON: ${jsonPath}`);

  // CSV
  const csvPath = path.join(CONFIG.outputDir, `${base}.csv`);
  const esc = s => `"${(s || '').replace(/"/g, '""')}"`;
  const csvRows = [
    ['idAnnuncio','numAnnuncio','titoloVacancy','azienda','descrCpi','descrComuneSede',
     'descrProvinciaSede','contratto','dataScadenza','flgL68Art1','stato'].join(','),
    ...filtered.map(a => [
      a.idAnnuncio,
      a.numAnnuncio || '',
      esc(a.titoloVacancy),
      esc(a.azienda),
      esc(a.descrCpi),
      esc(a.descrComuneSede),
      esc(a.descrProvinciaSede),
      esc(a.contratto),
      a.dataScadenza ? a.dataScadenza.slice(0, 10) : '',
      a.flgL68Art1 || '',
      esc(a.stato),
    ].join(','))
  ];
  fs.writeFileSync(csvPath, csvRows.join('\n'));
  console.log(`💾 CSV:  ${csvPath}`);

  return filtered;
}

// ── Avvio ──────────────────────────────────────────────────────────────────
scrape()
  .then(list => console.log(`\n🎉 Completato: ${list.length} annunci`))
  .catch(err  => { console.error('\n❌ Errore:', err.message); process.exit(1); });
