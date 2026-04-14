'use strict';

/**
 * Template per nuovo sito PA
 * Esporta: run(db, siteId, session?)
 *
 * Per aggiungere un nuovo sito:
 * 1. Copia questo file con il nome del sito (es. my-site.js)
 * 2. Compila i campi meta
 * 3. Implementa la funzione run()
 * 4. Aggiungi il sito nel DB tramite la dashboard o direttamente
 */

module.exports = {
  meta: {
    name: 'Nome Sito',
    url: 'https://example.com',
    authType: 'none', // 'none' | 'spid' | 'basic'
    loginUrl: null,   // URL da aprire per il login SPID (se authType = 'spid')
    loginSuccessPattern: null, // regex stringa sull'URL post-login, es. '/dashboard'
  },

  /**
   * Esegui lo scraping del sito e restituisci un array di risultati.
   *
   * @param {import('better-sqlite3').Database} db  - Istanza del DB (sola lettura nel sito)
   * @param {number} siteId                         - ID del sito nel DB
   * @param {object|null} session                   - Sessione (se authType != 'none')
   *   session.fetch(url, opts)  - fetch con cookie iniettati automaticamente
   *   session.cookies           - array di cookie objects
   *   session.savedAt           - timestamp salvataggio
   *
   * @returns {Promise<Array<{
   *   externalId:   string,   // ID univoco sul sito sorgente
   *   title:        string,   // Titolo della posizione
   *   organization: string,   // Nome azienda/ente
   *   location:     string,   // Comune/sede
   *   province:     string,   // Provincia
   *   contractType: string,   // Tipo contratto
   *   expiresAt:    string,   // Data scadenza ISO (YYYY-MM-DD o datetime)
   *   rawJson:      string,   // JSON.stringify dell'oggetto originale
   * }>>}
   */
  async run(db, siteId, session) {
    // const fetcher = session ? session.fetch.bind(session) : fetch;

    // Esempio:
    // const res = await fetcher('https://example.com/api/jobs');
    // const data = await res.json();
    // return data.items.map(item => ({
    //   externalId:   String(item.id),
    //   title:        item.title,
    //   organization: item.company,
    //   location:     item.city,
    //   province:     item.province,
    //   contractType: item.contractType,
    //   expiresAt:    item.deadline,
    //   rawJson:      JSON.stringify(item),
    // }));

    throw new Error('run() not implemented — edit sites/_template.js');
  }
};
