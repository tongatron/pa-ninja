'use strict';
// TODO: implementare scraper per inps-notifiche
module.exports = {
  meta: {
    name: 'INPS – inps-notifiche',
    url: 'https://servizi2.inps.it',
    authType: 'spid',
    authSite: 'inps-dati',
    loginUrl: 'https://servizi2.inps.it/servizi/areariservata/dati',
    loginSuccessPattern: 'areariservata',
  },
  async run(db, siteId, session) {
    console.log('[inps-notifiche] Scraper non ancora implementato — skip');
    return [];
  },
};
