/**
 * Scraper - Lavoro Piemonte (pslp.regione.piemonte.it)
 * Endpoint: POST /pslpbff/api-public/v1/annunci-pslp/consulta-annunci
 * Nessuna autenticazione richiesta.
 */

const fs = require('fs');
const path = require('path');

// ── Configurazione ricerca ─────────────────────────────────────────────────
const CONFIG = {
  baseUrl: 'https://pslp.regione.piemonte.it/pslpbff/api-public/v1/annunci-pslp',
  pageSize: 50,         // max risultati per pagina
  outputDir: './output',

  // Parametri di ricerca (tutti opzionali)
  search: {
    soloAnnunciCpi: 'N',  // 'S' = solo CPI, 'N' = tutti
    art1: 'T',             // 'S' = sì, 'N' = no, 'T' = tutti
    art18: 'T',
    tirocinio: 'T',
    paroleRicercate: null, // es. 'SVILUPPATORE', 'INFORMATICO'
    // comune: { id: null, descrizione: null },  // da scoprire
    // rangeKM: 10,
  },

  // Pausa tra le pagine per non sovraccaricare il server (ms)
  delayBetweenPages: 300,
};

// ── Utilità ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildBody(pagina) {
  const body = {
    pagina,
    dimensione: CONFIG.pageSize,
    soloAnnunciCpi: CONFIG.search.soloAnnunciCpi,
    art1: CONFIG.search.art1,
    art18: CONFIG.search.art18,
    tirocinio: CONFIG.search.tirocinio,
  };
  if (CONFIG.search.paroleRicercate) body.paroleRicercate = CONFIG.search.paroleRicercate;
  if (CONFIG.search.comune)          body.comune = CONFIG.search.comune;
  if (CONFIG.search.rangeKM)         body.rangeKM = CONFIG.search.rangeKM;
  return body;
}

async function fetchPage(pagina) {
  const res = await fetch(CONFIG.baseUrl + '/consulta-annunci', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(pagina)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} su pagina ${pagina}`);
  return res.json();
}

async function fetchDetail(idAnnuncio) {
  const res = await fetch(`${CONFIG.baseUrl}/get-dettaglio/${encodeURIComponent(idAnnuncio)}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.esitoPositivo ? json : null;
}

// ── Scraper principale ─────────────────────────────────────────────────────
async function scrape({ withDetails = false } = {}) {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  console.log('🔍 Prima pagina...');
  const first = await fetchPage(0);

  if (!first.esitoPositivo) {
    console.error('❌ Risposta negativa:', first);
    process.exit(1);
  }

  const totalPages = first.totalPage;
  const totalResults = first.totalResult;
  console.log(`📄 Totale: ${totalResults} annunci, ${totalPages} pagine`);

  let allAnnunci = [...first.list];

  // Scarica le pagine rimanenti
  for (let p = 1; p < totalPages; p++) {
    process.stdout.write(`\r⏳ Pagina ${p + 1}/${totalPages} (${allAnnunci.length}/${totalResults})...`);
    await sleep(CONFIG.delayBetweenPages);
    const page = await fetchPage(p);
    if (!page.esitoPositivo) {
      console.warn(`\n⚠️  Pagina ${p} fallita, salto`);
      continue;
    }
    allAnnunci.push(...page.list);
  }
  console.log(`\n✅ Scaricati ${allAnnunci.length} annunci`);

  // Dettagli opzionali
  if (withDetails) {
    console.log('🔎 Scarico dettagli...');
    for (let i = 0; i < allAnnunci.length; i++) {
      const annuncio = allAnnunci[i];
      process.stdout.write(`\r⏳ Dettaglio ${i + 1}/${allAnnunci.length}...`);
      await sleep(CONFIG.delayBetweenPages);
      const detail = await fetchDetail(annuncio.idAnnuncio);
      if (detail) allAnnunci[i] = { ...annuncio, ...detail };
    }
    console.log('\n✅ Dettagli completati');
  }

  // Salva JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(CONFIG.outputDir, `annunci_${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    meta: { totalResults, totalPages, scrapedAt: new Date().toISOString(), config: CONFIG.search },
    annunci: allAnnunci
  }, null, 2));
  console.log(`💾 JSON salvato: ${jsonPath}`);

  // Salva CSV
  const csvPath = path.join(CONFIG.outputDir, `annunci_${timestamp}.csv`);
  const csvRows = [
    ['idAnnuncio','titoloVacancy','azienda','dsIntermediario','descrComuneSede','descrProvinciaSede',
     'contratto','dataScadenza','flgL68Art1','flgL68Art18','flgTirocinio','stato'].join(','),
    ...allAnnunci.map(a => [
      a.idAnnuncio,
      `"${(a.titoloVacancy || '').replace(/"/g, '""')}"`,
      `"${(a.azienda || '').replace(/"/g, '""')}"`,
      `"${(a.dsIntermediario || '').replace(/"/g, '""')}"`,
      `"${(a.descrComuneSede || '').replace(/"/g, '""')}"`,
      `"${(a.descrProvinciaSede || '').replace(/"/g, '""')}"`,
      `"${(a.contratto || a.dsContratto || '').replace(/"/g, '""')}"`,
      a.dataScadenza ? a.dataScadenza.slice(0, 10) : '',
      a.flgL68Art1 || '',
      a.flgL68Art18 || '',
      a.flgTirocinio || '',
      `"${(a.stato || '').replace(/"/g, '""')}"`,
    ].join(','))
  ];
  fs.writeFileSync(csvPath, csvRows.join('\n'));
  console.log(`💾 CSV salvato:  ${csvPath}`);

  return allAnnunci;
}

// ── Avvio ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const withDetails = args.includes('--details');

scrape({ withDetails })
  .then(list => console.log(`\n🎉 Completato: ${list.length} annunci`))
  .catch(err => { console.error('\n❌ Errore:', err.message); process.exit(1); });
