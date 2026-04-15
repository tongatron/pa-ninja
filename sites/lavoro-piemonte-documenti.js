/**
 * Scraper - Lavoro Piemonte Documenti
 * https://pslp.regione.piemonte.it/pslpwcl/pslpfcweb/private/documenti/riepilogo-documenti
 *
 * Richiede autenticazione SPID.
 * Esegui prima: node core/session.js login --site lavoro-piemonte-documenti
 *
 * API utilizzate:
 *   GET  /pslpbff/api/v1/utente/self                                    → dati utente (idSilLavAnagrafica)
 *   POST /pslpbff/api/v1/documenti/ricerca-richieste-documenti           → lista documenti
 *   GET  /pslpbff/api/v1/documenti/stampa-documento-richiesto/{id}       → download PDF
 *
 * Il file PDF viene salvato in: data/documenti/{id}_{titolo}.pdf
 */

const path = require('path');
const fs   = require('fs');

module.exports = {

  meta: {
    name:                'Lavoro Piemonte Documenti',
    url:                 'https://pslp.regione.piemonte.it/pslpwcl/pslpfcweb/private/documenti/riepilogo-documenti',
    authType:            'spid',
    // La home mostra il bottone "Entra con SPID". Dopo il login l'URL cambia
    // verso /pslphome/home-page e vengono impostati i cookie di sessione.
    loginUrl:            'https://pslp.regione.piemonte.it/pslpwcl/pslphome/home-page',
    loginSuccessPattern: 'pslpfcweb/private',
  },

  async run(db, siteId, session) {
    if (!session) throw new Error('Sessione SPID mancante. Esegui: node core/session.js login --site lavoro-piemonte-documenti');

    const baseUrl = 'https://pslp.regione.piemonte.it/pslpbff';

    // 1. Recupera utente loggato
    const selfRes = await session.fetch(`${baseUrl}/api/v1/utente/self`);
    if (!selfRes.ok) throw new Error(`/utente/self → HTTP ${selfRes.status}. Sessione scaduta?`);
    const self = await selfRes.json();
    const idSilLavAnagrafica = self?.utente?.idSilLavAnagrafica;
    if (!idSilLavAnagrafica) throw new Error('idSilLavAnagrafica non trovato nella risposta di /utente/self');

    // 2. Scarica lista documenti
    const listRes = await session.fetch(
      `${baseUrl}/api/v1/documenti/ricerca-richieste-documenti?page=0&recForPage=100`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify({ idSilLavAnagrafica }),
      }
    );
    if (!listRes.ok) throw new Error(`ricerca-richieste-documenti → HTTP ${listRes.status}`);

    const listData = await listRes.json();
    if (!listData.esitoPositivo) throw new Error(`API error: ${listData.descrizioneEsito || 'esitoPositivo=false'}`);

    const documenti = (listData.list || [])
      // Escludi stato 5 (eliminati), come fa il frontend
      .filter(d => d.silwebTStatoDocume?.idSilwebTStatoDocume !== 5);

    if (!documenti.length) return [];

    // 3. Cartella download PDF
    const docsDir = path.join(__dirname, '..', 'data', 'documenti');
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

    // 4. Scarica PDF per ogni documento e mappa al formato comune
    const results = [];
    for (const doc of documenti) {
      const idRichiesta = doc.idRichiestaDocume ?? doc.idRichiestaDocumento;
      const tipoLabel   = doc.silwebTTipoDocume?.dsTipoDocume || 'Documento';
      const stato       = doc.silwebTStatoDocume?.dsSilwebTStatoDocume || '';
      const dataRichiesta = doc.dtRichiesta || doc.dtInserimento || null;

      // Prova a scaricare il PDF
      let pdfPath = null;
      if (idRichiesta) {
        try {
          const pdfRes = await session.fetch(
            `${baseUrl}/api/v1/documenti/stampa-documento-richiesto/${encodeURIComponent(idRichiesta)}`,
            { headers: { Accept: 'application/pdf' } }
          );
          if (pdfRes.ok && pdfRes.headers.get('content-type')?.includes('pdf')) {
            const buf = Buffer.from(await pdfRes.arrayBuffer());
            const safeName = tipoLabel.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
            const fileName = `${idRichiesta}_${safeName}.pdf`;
            pdfPath = path.join(docsDir, fileName);
            fs.writeFileSync(pdfPath, buf);
          }
        } catch (err) {
          console.warn(`[Documenti] PDF download failed for ${idRichiesta}:`, err.message);
        }
      }

      results.push({
        externalId:   String(idRichiesta ?? `doc_${doc.idSilwebTTipoDocume}`),
        title:        tipoLabel,
        organization: 'Lavoro Piemonte',
        location:     null,
        province:     null,
        contractType: stato,
        expiresAt:    null,
        rawJson: JSON.stringify({
          idRichiesta,
          tipo:         tipoLabel,
          stato,
          dataRichiesta,
          pdfPath,
          raw:          doc,
        }),
      });
    }

    return results;
  },
};
