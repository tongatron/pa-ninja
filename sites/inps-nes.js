'use strict';
// TODO: implementare scraper per inps-nes
module.exports = {
  meta: {
    name: 'INPS – inps-nes',
    url: 'https://servizi2.inps.it',
    authType: 'spid',
    authSite: 'inps-dati',
    loginUrl: 'https://servizi2.inps.it/servizi/areariservata/dati',
    loginSuccessPattern: 'areariservata',
  },
  async run(db, siteId, session) {
    console.log('[inps-nes] Scraper non ancora implementato — skip');
    return [];
  },
};
