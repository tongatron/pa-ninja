- [ ] # PA Companion

  Strumento locale per consultare, raccogliere e organizzare informazioni provenienti da portali della Pubblica Amministrazione italiana.

  Funziona come una **memoria personale dei servizi PA**: ti aiuta a non perdere dati, scadenze e aggiornamenti dispersi tra portali diversi.

  **Dashboard:** http://localhost:3001

  ---

  ## Perché esiste

  I portali della PA sono frammentati, eterogenei e spesso poco integrati.

  Questo progetto nasce per:

  - centralizzare informazioni disperse
  - evitare ricerche ripetitive
  - evidenziare cambiamenti nel tempo
  - costruire uno storico personale locale

  ---

  ## Cosa fa

  - raccoglie dati da portali pubblici e servizi online
  - normalizza le informazioni in un formato unico
  - salva tutto in un database locale (SQLite)
  - espone una dashboard web semplice
  - evidenzia nuovi risultati rispetto alle esecuzioni precedenti

  ---

  ## Cosa NON fa

  - non è un servizio cloud
  - non invia dati a server esterni
  - non automatizza login in modo invisibile
  - non garantisce compatibilità con tutti i portali

  ---

  ## Filosofia

  - **local-first** → i tuoi dati restano sul tuo computer  
  - **user-controlled** → sei tu ad avviare le operazioni  
  - **progressive access** → prima API ufficiali, poi pagine pubbliche, infine browser assistito  
  - **modulare** → ogni sito è un connettore indipendente  

  ---

  ## Setup

  ```bash
  git clone https://github.com/tongatron/PA-scraping
  cd PA-scraping
  npm install
  npm start
