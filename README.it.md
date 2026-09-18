# jevmap

Versione italiana breve. Il [README in inglese](README.md) contiene tutti i dettagli.

jevmap costruisce una mappa della codebase come unità piccole (funzioni,
endpoint, classi, componenti, pagine, job) leggendo il sorgente, senza AI, e
poi chiede a Jev (TypeSafe AI) quali unità servono per un compito scritto in
linguaggio naturale. Il risultato è una lista corta di file, con righe e
probabilità, che un agente di programmazione legge prima di toccare qualcosa.
Zero dipendenze, Node.js 18 o superiore, licenza MIT.

## L'idea

Un agente che deve cambiare due file in un repository che non conosce ne legge
ottanta: fa grep, apre candidati, segue gli import, legge file interi per
trovare una funzione. jevmap fa il contrario: la mappa dell'intero repository è
abbastanza piccola perché Jev la legga tutta, giudichi ogni unità rispetto al
compito e passi all'agente i dieci file che contano, in ordine.

Misurato con jevmap 0.1.0 su AEGEST, un gestionale per un'officina di lamiera
(backend Express, frontend React, 302 file, 1.460 unità), con gli ultimi 40
commit come verità (32 utilizzabili: messaggio = compito, file sorgente
toccati = risposta):

| Modo                          | primo file giusto | nei primi 3 | nei primi 5 | tempo per ricerca | costo per ricerca |
| ----------------------------- | ----------------: | ----------: | ----------: | ----------------- | ----------------- |
| scansione completa (default)  |               72% |         81% |         88% | 1-2 s             | 0,7 centesimi di dollaro (25 chiamate, 160k token) |
| prefiltro per parole + choice |               72% |         84% |         94% | meno di 1 s       | 0,02 centesimi (1 chiamata, 4k token) |

La versione interna precedente, misurata sullo stesso repository con 855 unità
più grosse e 103 commit, dava scansione 76% / 90% (primo / primi 5) e
prefiltro 58% / 72%. I numeri cambiano da repository a repository e con la
qualità delle descrizioni: il comando `bench` misura il tuo.

## Installazione

```sh
npm i -g jevmap
# oppure direttamente da GitHub, o senza installare:
npm i -g github:aegsrl7/jevmap
npx jevmap --help
```

Serve una chiave TypeSafe per le ricerche (`TYPESAFE_API_KEY`, vedi
https://docs.typesafe.ai) e, facoltativa, una chiave Anthropic
(`ANTHROPIC_API_KEY`) per il comando `describe` e per spezzare i compiti
composti. Costruire la mappa non richiede nessuna chiave.

## Avvio rapido

```sh
cd mio-repo
export TYPESAFE_API_KEY=...

jevmap build
# Map built: 258 files, 855 units in 2100 ms

jevmap find "mostra il nome del cliente nella lista delle mail"
# Task: mostra il nome del cliente nella lista delle mail
# Scan: 15 calls in 1100 ms, 51k tokens ($0.0021)
# Files to read:
#   93%  backend/routes/emails.js
#   81%  frontend/src/pages/EmailList.jsx
# Units:
#   93%  backend/routes/emails.js:120  GET /api/emails - List emails with filters
#   81%  frontend/src/pages/EmailList.jsx:18  EmailList - Page with the email table
```

Il compito può essere in qualunque lingua; i testi fissi del CLI sono in inglese.

## Comandi

```
jevmap build [--root .] [--out .jevmap] [--project "..."] [--include g] [--exclude g] [--json]
jevmap find "compito" [--mode scan|prefilter] [--split llm|heuristic|none] [--top 15]
                      [--files-only] [--json] [--batch 60] [--candidates 40]
jevmap describe [--model claude-haiku-4-5] [--dry-run] [--max-units 500]
jevmap bench [--commits 100] [--modes scan,prefilter] [--json]
jevmap --help | --version
```

- `build`: legge il repository e scrive `.jevmap/map.json` e `.jevmap/map.md`.
  Nessuna rete, nessuna chiave.
- `find`: chiede a Jev e stampa, per ogni parte del compito, i file da leggere
  e le unità con probabilità. `--files-only` stampa solo i file, `--json` il
  risultato grezzo. Se manca la mappa dice di lanciare `jevmap build`; se
  manca `TYPESAFE_API_KEY` mostra l'ordine del prefiltro per parole e lo dice.
- `describe`: riempie le descrizioni mancanti con un modello Anthropic
  (default `claude-haiku-4-5`), le salva in `.jevmap/descriptions.json` e
  ricostruisce la mappa. `--dry-run` mostra cosa manderebbe.
- `bench`: usa gli ultimi commit come casi di prova e stampa top-1, top-3,
  top-5 per modo, con chiamate, token, costo e tempo medi.

Codici di uscita: 0 ok, 1 errore (messaggio su stderr), 2 uso sbagliato.

## Configurazione: jevmap.config.json

Facoltativo, nella radice del repository. Ogni campo è facoltativo; le opzioni
da riga di comando hanno la precedenza.

```json
{
  "project": "AEGEST, gestionale per un'officina di lamiera: backend Express in backend/, frontend React in frontend/src",
  "include": ["backend/**", "frontend/src/**"],
  "exclude": ["**/*.test.js", "backend/scripts/**"],
  "areas": [["email|imap|mail", "email"], ["laser", "laser"]],
  "out": ".jevmap",
  "descriptions": ".jevmap/descriptions.json",
  "batch": 60
}
```

- `project`: una frase usata dentro le domande a Jev. Più è concreta, meglio
  ordina.
- `include`, `exclude`: pattern glob con `**`, `*` e `?`. Di default esclude
  `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`,
  `__pycache__`, `.venv`, `venv`, `target`, `*.min.js`, `*.map`, lockfile,
  binari e file oltre 1 MB.
- `areas`: coppie `[regex, nome]` applicate al percorso relativo (prima il
  nome del file, poi il percorso intero); l'area di default è la prima
  cartella. Servono solo a organizzare `map.md`.
- `out`: cartella di uscita (default `.jevmap`).
- `descriptions`: file delle descrizioni unito alla mappa a ogni build.
- `batch`: unità per richiesta a Jev nella scansione completa (default 60).

## Variabili d'ambiente

- `TYPESAFE_API_KEY`: chiave Jev (find, bench). Mai stampata.
- `ANTHROPIC_API_KEY`: describe e spezzamento `llm` dei compiti
  (`CLAUDE_API_KEY` accettata come alias).
- `JEV_MODEL`: modello Jev (default `jev-latest`).
- `NO_COLOR`: disattiva i colori anche su terminale.

Un file `.env` nella radice del repository viene letto per queste variabili.

## La skill per Claude Code

Copia `skills/jevmap/SKILL.md` in `.claude/skills/jevmap/` del tuo repository:

```sh
mkdir -p .claude/skills/jevmap
cp "$(npm root -g)/jevmap/skills/jevmap/SKILL.md" .claude/skills/jevmap/
```

Con la skill, all'inizio di ogni compito su un repository che ha la cartella
`.jevmap`, l'agente lancia `jevmap find "<compito>"` prima di aprire file,
legge i primi 2-3 file alle righe indicate, cerca in `map.md` per area quando
le probabilità sono piatte, ricostruisce la mappa dopo modifiche grosse e non
legge mai `map.json` intero.

## Come funziona

- **Unità**: `build` estrae con espressioni regolari le definizioni di primo
  livello (funzioni, classi e metodi, route Express/Koa/Fastify/NestJS, cron,
  componenti React e pagine, route Flask/FastAPI/Django, handler Go, funzioni
  Rust, mapping Spring e ASP.NET, route Rails e Laravel, funzioni shell,
  `CREATE` SQL). Ogni unità ha file, righe, il commento sopra (o la docstring)
  e gli extra trovati nel corpo: tabelle SQL, chiamate API, eventi socket,
  import locali, middleware, route.
- **Scansione completa** (default): una domanda `noul` per unità ("per fare
  il compito in `task` un programmatore deve leggere o modificare questa
  unità: ..."), a lotti di 60 per richiesta, tutti in parallelo. 855 unità
  sono 15 richieste e circa un secondo.
- **Prefiltro** (`--mode prefilter`): punteggio per parole in comune con
  stemming, 40 candidati, una domanda `choice` con un criterio per candidato
  più "nessuno". Una sola richiesta, funziona bene quando il compito usa le
  parole del codice.
- **Compiti composti**: se il testo sembra composto (righe, punti e virgola,
  elenchi, virgole tra parti di più parole, oltre 14 parole) un modello
  Anthropic lo spezza in sotto-compiti (massimo 8); senza chiave lo fa
  un'euristica. Ogni parte viene cercata in parallelo.
- **Descrizioni**: Jev giudica un'unità dalla sua descrizione di una riga.
  `build` la prende dal commento sopra l'unità; `describe` riempie le altre.
  La cosa più utile per la qualità dell'ordinamento è un commento di una riga
  sopra ogni endpoint, job e componente.

## Il benchmark

`jevmap bench --commits 100`: per ognuno degli ultimi 100 commit (saltati
merge, messaggi troppo corti e commit che toccano solo documentazione,
lockfile, JSON o YAML) il messaggio è il compito e i file sorgente toccati
presenti nella mappa sono la risposta. La tabella riporta top-1, top-3, top-5
(quota di commit con il primo file toccato entro i primi 1, 3, 5 file
proposti), `cov@3` (quota media di file toccati trovati nei primi 3 file di
una qualunque parte), chiamate, token e tempo medi, costo totale. Le righe per
commit finiscono in `.jevmap/bench.json`. Leggi i numeri come confronto tra
modi e tra versioni della mappa, non come voto assoluto: i messaggi di commit
sono un'approssimazione dei compiti.

## Costi

- Jev (TypeSafe): 0,042 USD per milione di token in ingresso al momento della
  scrittura. Una scansione completa costa circa 110 token per unità: 1.460
  unità sono 160k token, cioè 0,007 USD per ricerca; il prefiltro circa 4k
  token, 0,0002 USD. Un compito composto si cerca parte per parte, quindi costa
  una scansione per parte. Prezzi correnti su https://docs.typesafe.ai.
- `describe`: modello Anthropic (default `claude-haiku-4-5`); la stima viene
  stampata a fine esecuzione, di solito pochi centesimi per qualche centinaio
  di unità.
- `build` e lo spezzamento euristico sono gratis.

## Limiti

- L'estrattore è un insieme di espressioni regolari, non un parser: trova le
  definizioni di primo livello e i pattern dei framework più comuni.
- Funziona meglio su JavaScript, TypeScript e Python; gli altri linguaggi
  hanno regole di base.
- Repository grandi: richieste e token crescono con il numero di unità (un
  lotto da 60 per richiesta). Diecimila unità sono circa 170 richieste e 600k
  token per ricerca, sotto i tre centesimi; usa `include`/`exclude` per
  limitare la mappa al codice che cambia.
- Disponibilità di Jev: `find` riprova su 408, 429 e 5xx. Senza chiave o senza
  rete resta l'ordine per parole.
- La qualità dipende dalle descrizioni: lancia `describe` dopo la prima build.

## Contribuire

Issue e pull request sono benvenute. `npm test` usa `node:test` e un piccolo
repository di prova, senza rete. Niente dipendenze a runtime, CommonJS con
`'use strict'`, un test per ogni nuova regola di linguaggio.

## Licenza

MIT, vedi [LICENSE](LICENSE).

jevmap usa Jev di TypeSafe AI per l'ordinamento: https://docs.typesafe.ai
