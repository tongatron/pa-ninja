# 🥷 PA Ninja

> ⚠️ **PROTOTIPO IN FASE SPERIMENTALE — non usare in produzione**
>
> I connettori sono in sviluppo attivo. I dati estratti potrebbero essere incompleti,
> errati o assenti. Le sessioni SPID e i selettori DOM vengono affinati iterazione dopo iterazione.

Dashboard locale prototipale per monitorare portali della Pubblica Amministrazione italiana:
annunci di lavoro, messaggi, notifiche INPS, documenti e dichiarazioni ISEE —
tutto in un'unica interfaccia, senza condividere credenziali con terze parti.

---

## Requisiti

- **Node.js** ≥ 18
- **npm** ≥ 9
- Browser **Chromium** (installato automaticamente da Playwright)

## Installazione

```bash
git clone https://github.com/tongatron/pa-ninja.git
cd pa-ninja
npm install
npx playwright install chromium
```

Crea un file `.env` nella root (opzionale):

```env
PORT=3001
PLAYWRIGHT_HEADLESS=true   # false = mostra il browser durante il login
DB_PATH=data/pa-ninja.db
```

---

## Avvio

```bash
# Avvia il server dashboard (http://localhost:3001)
npm start

# Esegui tutti i connettori abilitati
npm run run:all

# Esegui un connettore specifico
npm run run:site -- --site inps-dati

# Avvia una sessione di login interattiva (finestra Chromium)
npm run login -- --site inps-dati
```

---

## Connettori

| Connettore | Descrizione | Stato | Auth |
|---|---|---|---|
| `lavoro-piemonte` | Annunci di lavoro — Regione Piemonte | ✅ Funzionante | — |
| `lavoro-piemonte-documenti` | Documenti e circolari | ✅ Funzionante | — |
| `piemonte-tu-messaggi` | Messaggi area riservata Piemonte Tu | ✅ Funzionante | SPID |
| `inps-dati` | I miei dati (Anagrafica e Consensi) | 🧪 In test | SPID |
| `inps-notifiche` | Centro notifiche | 🧪 In test | SPID* |
| `inps-nes` | NES — Nucleo Elaborazione Stipendi | 🚧 Stub | SPID* |
| `inps-domande` | Consultazione domande | 🚧 Stub | SPID* |
| `inps-isee` | ISEE — Dichiarazioni | 🚧 Stub | SPID* |

> \* I connettori INPS secondari riusano la sessione SPID di `inps-dati` —
> basta autenticarsi una volta sola dalla sezione **Accessi SPID** della dashboard.

---

## Struttura del progetto

```
pa-ninja/
├── core/
│   ├── db.js          # Inizializzazione SQLite, upsertResult
│   ├── runner.js      # Logica di esecuzione connettori
│   └── session.js     # Gestione sessioni Playwright (storageState)
├── dashboard/
│   ├── server.js      # Server Express + API REST
│   └── public/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── sites/
│   ├── *.js           # Moduli scraper (uno per connettore)
│   └── *.json         # Config agenti (opzionale, per import/export)
├── data/
│   ├── pa-ninja.db    # Database SQLite locale (gitignored)
│   └── debug-*.html   # Dump HTML per debug scraper
└── .env               # Variabili d'ambiente (gitignored)
```

---

## Aggiungere un connettore

1. Crea `sites/mio-sito.js` con `module.exports = { meta, run }`.
2. `run(db, siteId, session)` deve restituire un array di oggetti con almeno `{ externalId, title }`.
3. Aggiungi il sito al DB dalla sezione **Amministrazione → Aggiungi** nella dashboard,
   oppure inseriscilo direttamente nella lista seed in `core/db.js`.
4. Se richiede autenticazione, imposta `auth_type = 'spid'` e usa `meta.loginUrl`.
5. Per condividere la sessione di un altro sito, aggiungi `meta.authSite: 'nome-sito-principale'`.

---

## Privacy

Tutte le sessioni e i dati estratti restano **esclusivamente in locale** — nessun dato
viene inviato a server esterni. Il database SQLite e gli artefatti locali sono esclusi
dal repository tramite `.gitignore`.

---

*v0.1.0 — prototipo locale in evoluzione*
