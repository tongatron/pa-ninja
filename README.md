# PA Scraping

Strumento locale per monitorare portali della Pubblica Amministrazione italiana.
Raccoglie dati, li salva in un database locale e li espone tramite una dashboard web.

**Dashboard:** `http://localhost:3001`

---

## Setup

```bash
git clone https://github.com/tongatron/PA-scraping
cd PA-scraping
npm install
npm start
```

Apri `http://localhost:3001` nel browser.

---

## Comandi utili

```bash
npm start                                    # avvia la dashboard (porta 3001)
PORT=3002 npm start                          # porta alternativa

node core/runner.js                          # esegui tutti i siti abilitati
node core/runner.js --site lavoro-piemonte   # esegui un sito specifico
node core/runner.js --dry-run                # test senza salvare nel DB

node core/session.js login --site <nome>     # login SPID (apre browser Playwright)
```

Se la porta è già in uso:
```bash
pkill -f "node dashboard/server.js"
```

---

## Struttura

```
PA-scraping/
├── core/
│   ├── db.js           # SQLite: tabelle sites, runs, results, sessions
│   ├── runner.js       # orchestratore multi-sito
│   └── session.js      # gestione sessioni SPID via Playwright
├── sites/
│   ├── _template.js    # template per aggiungere nuovi siti
│   └── lavoro-piemonte.js
├── dashboard/
│   ├── server.js       # Express API REST
│   └── public/         # SPA frontend (vanilla JS)
├── data/               # DB SQLite + sessioni (gitignored)
└── lavoro-piemonte/    # scraper CLI standalone (legacy)
```

---

## Siti supportati

| Sito | URL | Auth | Schedule |
|------|-----|------|----------|
| Lavoro Piemonte | pslp.regione.piemonte.it | — | 08:00 e 14:00 |

---

## Aggiungere un nuovo sito

1. Copia `sites/_template.js` → `sites/nome-sito.js`
2. Implementa il metodo `run(db, siteId, session)`
3. Aggiungi il sito dalla dashboard (sezione **Siti** → "+ Aggiungi sito")
4. Imposta `module_path: nome-sito`

Per siti con autenticazione SPID, imposta `auth_type: spid` e usa
`node core/session.js login --site nome-sito` per salvare la sessione.

---

## API REST

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/sites` | lista siti |
| POST | `/api/sites` | crea sito |
| PUT | `/api/sites/:id` | aggiorna sito |
| DELETE | `/api/sites/:id` | elimina sito |
| POST | `/api/sites/:id/run` | lancia run manuale |
| GET | `/api/runs/:runId/status` | stato run |
| GET | `/api/results` | risultati (filtri: siteId, province, keyword, expiresAfter, page, limit) |
| GET | `/api/results/provinces` | lista province disponibili |
| POST | `/api/sites/:id/login` | avvia sessione SPID |
| GET | `/api/sessions` | stato sessioni salvate |

---

## Prossimi passi

### In lavorazione
- [ ] Aggiungere altri portali PA (INPS, Agenzia delle Entrate, portali regionali)
- [ ] Testare login SPID con Playwright su sito reale

### Funzionalità pianificate
- [ ] **Notifiche** — email o Telegram quando escono nuovi risultati
- [ ] **Scheduler automatico** — attivare il cron integrato (già configurato per sito, da abilitare)
- [ ] **Filtro diff** — mostrare solo i risultati nuovi rispetto all'ultima run
- [ ] **Export** — download CSV/JSON direttamente dalla dashboard
- [ ] **Tag e note** — annotare manualmente i risultati interessanti

### Distribuzione futura
- [ ] **Electron** — pacchetto desktop installabile (.dmg / .exe) per utenti non tecnici
- [ ] **Docker** — container per chi preferisce non installare Node
- [ ] **Configurazione via `.env`** — credenziali, porta, path DB
