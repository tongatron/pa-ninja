'use strict';

/**
 * Scraper - Lavoro Piemonte (pslp.regione.piemonte.it)
 * Endpoint: POST /pslpbff/api-public/v1/annunci-pslp/consulta-annunci
 * Nessuna autenticazione richiesta.
 */

const BASE_URL = 'https://pslp.regione.piemonte.it/pslpbff/api-public/v1/annunci-pslp';
const PAGE_SIZE = 20;
const DELAY_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(page) {
  const url = `${BASE_URL}/consulta-annunci?page=${page}&recForPage=${PAGE_SIZE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://pslp.regione.piemonte.it/',
    },
    body: JSON.stringify({ art1: 'T', art18: 'T', tirocinio: 'T' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  return res.json();
}

module.exports = {
  meta: {
    name: 'Lavoro Piemonte',
    url: 'https://pslp.regione.piemonte.it/pslpwcl/pslpfcweb/consulta-annunci/profili-ricercati',
    authType: 'none',
    loginUrl: null,
    loginSuccessPattern: null,
  },

  async run(db, siteId, session) {
    console.log('[lavoro-piemonte] Fetching page 0...');
    const first = await fetchPage(0);

    if (!first.esitoPositivo) {
      throw new Error(`Negative response from API: ${JSON.stringify(first)}`);
    }

    const totalPages = first.totalPage;
    const totalResult = first.totalResult;
    console.log(`[lavoro-piemonte] Total: ${totalResult} results, ${totalPages} pages`);

    const allAnnunci = [...(first.list || [])];

    for (let p = 1; p < totalPages; p++) {
      await sleep(DELAY_MS);
      process.stdout.write(`\r[lavoro-piemonte] Page ${p + 1}/${totalPages} (fetched: ${allAnnunci.length})...`);
      try {
        const page = await fetchPage(p);
        if (!page.esitoPositivo) {
          console.warn(`\n[lavoro-piemonte] Page ${p} returned negative, skipping`);
          continue;
        }
        allAnnunci.push(...(page.list || []));
      } catch (err) {
        console.warn(`\n[lavoro-piemonte] Page ${p} failed: ${err.message}, skipping`);
      }
    }

    if (totalPages > 1) process.stdout.write('\n');
    console.log(`[lavoro-piemonte] Downloaded ${allAnnunci.length} annunci total`);

    return allAnnunci.map(a => ({
      externalId:   String(a.idAnnuncio),
      title:        a.titoloVacancy || null,
      organization: a.azienda || null,
      location:     a.descrComuneSede || null,
      province:     a.descrProvinciaSede || null,
      contractType: a.contratto || null,
      expiresAt:    a.dataScadenza ? String(a.dataScadenza).slice(0, 10) : null,
      rawJson:      JSON.stringify(a),
    }));
  }
};
