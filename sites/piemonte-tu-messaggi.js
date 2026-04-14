/**
 * Scraper - PiemonteTu Messaggi
 * https://www.piemontetu.it/area-personale/messaggi
 *
 * Richiede autenticazione SPID.
 * Esegui prima: node core/session.js login --site piemonte-tu-messaggi
 *
 * API utilizzate:
 *   GET /api-auth/me                                      → codice fiscale utente
 *   GET /api-auth/notify/messages/users/{CF}/messages     → lista messaggi
 */

module.exports = {

  meta: {
    name:                 'PiemonteTu Messaggi',
    url:                  'https://www.piemontetu.it/area-personale/messaggi',
    authType:             'spid',
    loginUrl:             'https://www.piemontetu.it/area-personale',
    // Login completato quando /api-auth/me risponde 200 con codice_fiscale
    loginSuccessPattern:  '/area-personale',
  },

  async run(db, siteId, session) {
    if (!session) throw new Error('Sessione SPID mancante. Esegui: node core/session.js login --site piemonte-tu-messaggi');

    const baseUrl = 'https://www.piemontetu.it';

    // 1. Recupera codice fiscale dell'utente
    const meRes = await session.fetch(`${baseUrl}/api-auth/me`);
    if (!meRes.ok) throw new Error(`/api-auth/me → HTTP ${meRes.status}. Sessione scaduta?`);
    const me = await meRes.json();
    const cf = me.codice_fiscale;
    if (!cf) throw new Error('Codice fiscale non trovato nella risposta di /api-auth/me');

    // 2. Scarica tutti i messaggi
    const msgsRes = await session.fetch(
      `${baseUrl}/api-auth/notify/messages/users/${encodeURIComponent(cf)}/messages`
    );
    if (!msgsRes.ok) throw new Error(`messages API → HTTP ${msgsRes.status}`);

    const raw = await msgsRes.json();
    const messaggi = Array.isArray(raw) ? raw : Object.values(raw);

    if (!messaggi.length) return [];

    // 3. Mappa al formato comune
    return messaggi.map(m => ({
      externalId:   m.id,
      title:        m.mex?.title   || '(senza titolo)',
      organization: m.sender       || '',
      location:     null,
      province:     null,
      contractType: m.tag          || '',   // es. "r_piemon,sanita,noticed"
      expiresAt:    null,
      // Campi extra salvati nel JSON grezzo
      rawJson: JSON.stringify({
        id:             m.id,
        sender:         m.sender,
        tag:            m.tag,
        timestamp:      m.timestamp,
        read_at:        m.read_at,
        title:          m.mex?.title,
        body:           m.mex?.body,
        call_to_action: m.mex?.call_to_action,
      }),
    }));
  },
};
