# Orkas

**Un team open source di agenti IA sul tuo computer: trasforma i tuoi obiettivi in lavoro portato a termine e fa andare avanti le cose.**

Orkas è un'app desktop multi-agente open source (MIT) con priorità al locale — un assistente IA che lavora come un team. Di' al **Commander** di cosa hai bisogno: porta a termine da solo molte attività e, per i lavori più grandi, pianifica i passaggi e coinvolge agenti specializzati, oltre agli agenti di programmazione e agli agenti personali che già usi — **Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent** — perché ci lavorino insieme.

Orkas è pensato per far avanzare un progetto, non solo per rispondere a un singolo prompt. Un **progetto** contiene l'obiettivo, le regole, la memoria e i file, così ogni nuova conversazione riprende da dove si era fermata la precedente. La lista **Da fare** divide il lavoro tra persone e agenti, l'**Avanzamento automatico** permette al team di occuparsi da solo dell'attività successiva, e le **automazioni pianificate** ripetono il lavoro di routine ogni ora, ogni giorno, ogni settimana o ogni mese. Tutti i tuoi dati restano sul tuo computer e il lavoro finito torna a te per la revisione: così puoi affidare a Orkas il lavoro continuativo della tua attività.

**[⬇ Scarica Orkas per macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — gratis, con 500 crediti per il modello Orkas integrato, quindi per iniziare non ti serve una chiave API. Preferisci usare le tue chiavi? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, oppure un endpoint locale compatibile con OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![App desktop di Orkas — conversazione di un'attività e risultati consegnati](./resources/app-ui/task-en.png)

---

## Cosa consegna il team

- **Video, voci fuori campo e immagini** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Report di ricerca, audit SEO e analisi di mercato** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Post, articoli, newsletter e presentazioni** — ContentWriter, PptMaker
- **Siti web, interfacce e codice** — UIDesigner, ProductDeveloper
- **File Word, Excel, PowerPoint e PDF** — OfficeWorker
- **Lavoro per l'e-commerce** — ricerca prodotti, schede prodotto, analisi delle recensioni, analisi delle vendite e modifiche al catalogo, grazie a cinque agenti dedicati all'e-commerce
- **Lavori complessi che richiedono più agenti** — il Commander li suddivide, assegna ogni parte all'agente giusto e unisce i risultati; per esempio, una ricerca di mercato che diventa un report, una presentazione e un video di lancio

16 specialisti sono inclusi nell'app, ognuno con abilità, memoria e strumenti propri. Sfoglia oltre 30 agenti nel [Marketplace degli agenti](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas), oppure descrivi il ruolo che ti serve e il Commander creerà per te un agente personalizzato.

<details>
<summary><b>Tutti i 16 agenti integrati</b></summary>

| Area | Agente | Cosa consegna |
| --- | --- | --- |
| Ricerca e analisi | **DeepResearcher** | Ricerca basata su prove, con fonti verificate, contraddizioni segnalate e un report verificabile |
| | **SeoGeoAgent** | Dagli un URL — audit tecnico, qualità dei contenuti, Core Web Vitals, citabilità nelle risposte dell'IA (GEO), elenco di correzioni ordinato per priorità |
| | **StockAnalyser** | Analisi azionaria, screening fattoriali, backtest e controlli del rischio di portafoglio, con dashboard tracciabili |
| Contenuti e media | **ContentWriter** | Post, articoli, newsletter e casi di studio pronti da pubblicare, a partire da un obiettivo, da fonti o da una bozza |
| | **PptMaker** | Presentazioni PPTX modificabili e facili da rivedere, a partire da un argomento, una scaletta o un documento |
| | **ImageStudio** | Poster, copertine, immagini per i social e infografiche |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narrazione, presentatori IA, sottotitoli e doppiaggio, clip dei momenti salienti, localizzazione e ricreazione di video di riferimento con i tuoi contenuti e il tuo girato |
| | **VoiceStudio** | Narrazione, audio a più voci, trascrizioni e sottotitoli, editing e mixaggio audio |
| | **UIDesigner** | Interfacce modificabili, costruite attorno all'HTML, a partire da obiettivi di prodotto, PRD, screenshot o materiale Figma |
| Sviluppo e ufficio | **ProductDeveloper** | Sviluppo che conosce il tuo repository — implementa un PRD, corregge bug, fa refactoring e revisioni, con risultati verificabili |
| | **OfficeWorker** | Crea, modifica, controlla e consegna file Word / Excel / PowerPoint / PDF, uno alla volta o in blocco |
| E-commerce | **ECommerceResearcher** | Selezione dei prodotti in base a budget, mercato e vincoli di approvvigionamento — candidati, motivi di esclusione, piani di validazione |
| | **ECommerceWriter** | Titoli, pagine prodotto, FAQ, testi per le immagini e script video con la voce del tuo brand |
| | **ECommerceReviewer** | Analisi di recensioni e reputazione — temi ricorrenti tra i clienti, cause profonde delle recensioni negative, priorità |
| | **ECommerceAnalyzer** | Vendite, profitti, pubblicità, rimborsi e magazzino a partire dai tuoi export — metriche riconciliate e decisioni |
| | **ECommerceOperator** | Pianifica modifiche a catalogo, prezzi, promozioni e magazzino; le esegue solo tramite gli strumenti che colleghi |

Approfondimenti su ogni agente → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Ricrea un video di riferimento con i tuoi contenuti

**VideoStudio** può ricreare la struttura narrativa, lo stile visivo e il ritmo di montaggio di un video virale usando il tuo prodotto, il tuo script e il tuo girato. Fornisci un file video di riferimento e i tuoi materiali: l'agente analizza l'aggancio iniziale, l'ordine delle informazioni, i momenti visivi chiave e l'invito all'azione, poi propone cosa mantenere e cosa sostituire; solo dopo si passa alla produzione.

Funziona al meglio con video esplicativi in motion graphics, demo di SaaS o di app e annunci di prodotto realizzati con il girato che hai già. Testi, sottotitoli, narrazione e clip creati in locale si possono modificare separatamente; il testo impresso nel girato generato dall'IA si può cambiare solo modificando quel girato.

> «Usa reference.mp4 come riferimento per un video promozionale verticale di 30 secondi. Mantieni l'aggancio iniziale, la tipografia e il ritmo, sostituisci i contenuti con il mio prodotto e le mie registrazioni dello schermo, e mostrami prima l'analisi e il piano.»

Parti da un file video che l'agente può leggere; il download dai link di condivisione dei social non è integrato. I movimenti di camera esatti, la recitazione delle persone e la corrispondenza fotogramma per fotogramma non sono garantiti. Consulta il [flusso di lavoro per ricreare un video di riferimento](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Fai avanzare il lavoro

Una singola attività è un buon inizio. Orkas è fatto per il lavoro che continua.

- **Progetti** — obiettivi e regole, memoria e file da cui parte ogni conversazione del progetto, così non devi mai rispiegare tutto da capo.
- **Da fare e Avanzamento automatico** — ogni progetto ha una lista di attività da fare per persone e agenti; con l'Avanzamento automatico attivo, il team prende da solo la voce successiva e ti riporta il lavoro finito da rivedere.
- **Automazioni pianificate** — esegui qualsiasi attività ogni ora, ogni giorno, ogni settimana o ogni mese. Orkas gira sul tuo computer. Dalla v1.9, quando il computer si riattiva o Orkas si avvia, ogni automazione recupera la sua ultima esecuzione saltata, se risale alle ultime 12 ore.
- **Connettori** — Gmail, Google Calendar, Sheets e Drive, Notion, Slack, Shopify, Stripe e molti altri. Per impostazione predefinita, Orkas chiede conferma ogni volta che deve inviare, pubblicare o eliminare qualcosa.
- **App** — descrivi uno strumento e Orkas lo costruisce come app locale all'interno dell'app desktop. Nell'app installabile, con un piano a pagamento puoi anche pubblicarlo come web app con un link pubblico.
- **Progetti condivisi** *(app installabile)* — invita un collega o un assistente virtuale e assegna ogni attività da fare a una persona o a un agente.

> [!NOTE]
> I progetti condivisi, la sincronizzazione cloud e la pubblicazione di web app sono disponibili solo nell'app installabile: la versione open source non li supporta ancora. Per usarli, **[scarica Orkas per macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratis, con 500 crediti per iniziare).

---

## Esegui insieme Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent

Orkas esegue gli agenti CLI che hai già installato come sessioni locali, accanto ai suoi specialisti — gli agenti di programmazione **Claude Code, Codex e OpenCode** e gli agenti personali **OpenClaw e Hermes-Agent**. Il Commander affida a ciascuno la parte in cui riesce meglio e mantiene un unico piano per tutti, così una sola chat può correggere il bug, rivedere la modifica e scrivere la bozza delle note di rilascio. Gli strumenti open source come HyperFrames si collegano allo stesso modo.

[Usare Claude Code e Codex insieme →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Perché Orkas

- **Un Commander che pianifica, delega e fa il resto** — scompone gli obiettivi, sceglie gli agenti, le abilità, i connettori e gli strumenti giusti, e si occupa direttamente di analisi, scrittura, ricerca e lavoro sui file quando nessuno specialista è più adatto.
- **Progettato con priorità al locale** — conversazioni, file, knowledge base e agenti personalizzati restano sul tuo disco per impostazione predefinita. La sincronizzazione cloud è facoltativa nell'app installabile. Con le tue chiavi, le chiamate ai modelli vanno direttamente dal tuo computer al provider; il modello Orkas integrato passa per il servizio di modelli gestito da Orkas.
- **Qualsiasi modello, da cambiare quando vuoi** — il Commander e gli agenti integrati condividono un'unica impostazione del modello: il modello Orkas integrato, un tuo provider o un endpoint locale. Gli agenti CLI esterni mantengono le proprie impostazioni del modello.
- **Agenti che migliorano** — ogni agente ha abilità e memoria private. Le revisioni in background esaminano la nuova attività quando l'app è inattiva e possono affinare l'autovalutazione, i metodi riutilizzabili e le abilità apprese.
- **Open source, nessuna scatola nera** — licenza MIT. Leggi esattamente cosa fanno Orkas, ogni agente e ogni abilità.

> ⭐ Se Orkas ti è utile, una stella aiuta più persone a trovare il progetto.

---

## Download

| | App installabile (consigliata) | Esecuzione dal codice sorgente |
| --- | --- | --- |
| Piattaforme | macOS 12+ (Apple Silicon e Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 con glibc 2.34+ |
| Account | Accesso — 500 crediti gratuiti | Nessuno |
| Modelli | Modello Orkas integrato o le tue chiavi | Le tue chiavi o un endpoint locale |
| Include anche | Collaborazione sui progetti, pubblicazione di app, sincronizzazione cloud e altro | — |
| Come ottenerla | **[Scarica Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Avvio rapido](#avvio-rapido) |

Il link di download rileva il tuo sistema e avvia il programma di installazione giusto.

---

## Per cosa si usa

- **Contenuti di marketing** — video di lancio, pagine prodotto, post e newsletter con il tuo stile. [Scrittura di contenuti](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Video](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Gestione del negozio** — riepiloghi settimanali delle vendite, risposte alle recensioni, schede prodotto e controlli sulla concorrenza. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Ricerca e report** — report e presentazioni con fonti, su richiesta o ogni settimana. [Ricerca](https://orkas.ai/use/researchers/?source=gh-orkas) · [Analisi dei dati](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Chatta con i tuoi documenti** — risposte basate sui tuoi file, con citazioni che rimandano ai passaggi originali. [Chat con i documenti](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Lavoro per i clienti** — brief per le riunioni, report mensili per i clienti e presentazioni di aggiornamento basate sul tuo modello. [Modello di report mensile per i clienti](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lancio di prodotto** — landing page, correzioni di bug con test, changelog e post di lancio. [Sviluppatori](https://orkas.ai/use/developers/?source=gh-orkas)
- **Crea un'app** — calcolatori di preventivi, moduli di prenotazione, strumenti interni. [Creare app](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Piccoli team** — un unico progetto per persone e agenti. [Piccoli team](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas a confronto

| Strumento | Che cos'è | In cosa si distingue Orkas |
| --- | --- | --- |
| **Claude Code** | Lo strumento di programmazione agentico di Anthropic — nel terminale, nell'IDE, su desktop e sul web, basato sui modelli Claude. | Non serve scegliere: Orkas esegue Claude Code come uno dei suoi agenti. Attorno a lui, Orkas aggiunge un team indipendente dal modello per il lavoro che va oltre il codice — ricerca, contenuti, video e altro — con progetti, attività da fare e automazioni che fanno avanzare il lavoro. [Orkas vs Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | L'agente di programmazione di OpenAI — nel terminale, nel tuo editor e nel cloud. | Non serve scegliere: Orkas esegue Codex come uno dei suoi agenti, accanto a Claude Code e OpenCode. Il Commander può affidare la scrittura del codice a Codex e la revisione a un altro agente, e poi occuparsi della metà di un rilascio che non riguarda il codice — documentazione, post di lancio e video. [Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | L'agente di Anthropic per il lavoro quotidiano, ora parte di Claude — su desktop, web e mobile con un piano Claude a pagamento. Per impostazione predefinita funziona nel cloud di Anthropic e usa i modelli Claude. | Un'alternativa open source (MIT) a Claude Cowork, gratuita per iniziare, con 500 crediti. Orkas esegue i suoi agenti sul tuo computer e, per impostazione predefinita, tiene i tuoi dati in locale, con il modello Orkas integrato, le chiavi dei tuoi provider o un endpoint locale. Il Commander può anche coinvolgere Claude Code, Codex e altri agenti CLI. Il compromesso: Orkas richiede che il computer non sia in sospensione, mentre le attività cloud di Cowork possono continuare anche senza. [Alternative a Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Un agente IA che, per impostazione predefinita, pianifica ed esegue le attività nel cloud di Manus. L'app desktop Manus Studio (macOS e Windows) può anche lavorare in una cartella a tua scelta, ma le attività vengono comunque pianificate nel cloud. | Un'alternativa open source (MIT) a Manus. Orkas esegue i suoi agenti sul tuo computer e, per impostazione predefinita, tiene i tuoi dati in locale, con il modello Orkas integrato, le chiavi dei tuoi provider o un endpoint locale. Progetti, attività da fare e automazioni fanno avanzare il lavoro. Il compromesso: Orkas richiede che il computer non sia in sospensione, mentre le attività cloud di Manus possono continuare anche senza. [Alternativa open source a Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Un framework (o libreria) per sviluppatori con cui creare app e agenti basati su LLM — incentrato sul codice, integrato nella tua app Python/JS. | Orkas è un'app desktop che guidi tramite chat, senza scrivere codice di orchestrazione. Per impostazione predefinita i dati restano in locale. |
| **CrewAI** | Un framework Python per orchestrare agenti autonomi che interpretano ruoli — definisci crew e agenti nel codice. | Orkas porta l'orchestrazione multi-agente in un'app desktop, con progetti, attività da fare, automazioni e automiglioramento di ogni singolo agente già integrati. |
| **OpenClaw** | Una piattaforma di agenti personali con integrazioni di messaggistica, instradamento multi-agente e sotto-agenti. | Orkas offre uno spazio di lavoro desktop per ottenere risultati finiti, con specialisti integrati e coordinamento tra Claude Code, Codex, OpenCode e altri agenti CLI. OpenClaw può entrare in questo flusso di lavoro come agente CLI. |
| **Hermes-Agent** | L'agente di Nous Research che si migliora da sé — un unico agente con memoria e abilità, disponibile come CLI, gateway di messaggistica e app desktop. | Orkas coordina un team: il Commander dirige molti specialisti e altri agenti CLI, e Hermes-Agent si collega come uno di loro. |

**Orkas fa per te se** vuoi un team di agenti anziché un singolo assistente, un lavoro che va avanti per giorni, e i tuoi dati, le tue chiavi e i tuoi agenti sul tuo disco.

**Non fa per te se** vuoi solo un chatbot generico tuttofare, o una semplice libreria di codice da integrare nella tua app.

**Devi scegliere tra agenti di programmazione?** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternative a Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Confronti completi fianco a fianco →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Avvio rapido

Preferisci un programma di installazione già pronto? Vedi [Download](#download) qui sopra. Per eseguire Orkas dal codice sorgente — attualmente è così che si usa Orkas su Linux:

**Requisiti**: Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 o arm64. Tieni a disposizione Python 3 e una toolchain di compilazione C/C++ per il raro caso in cui i moduli nativi vadano compilati dal sorgente.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Su Linux, l'esecuzione dal sorgente richiede glibc 2.34+. Alpine e le altre distribuzioni basate su musl non sono supportate. Per la trascrizione vocale locale, il runtime whisper.cpp nativo della piattaforma di destinazione e il modello multilingue vengono scaricati e verificati al primo avvio dal sorgente.

`run.sh` / `run.cmd` installa l'albero delle dipendenze npm bloccato e, al primo avvio, prepara le risorse a versione fissata: Python, uv, Node, modello di embedding (~95 MB), OfficeCLI, FFmpeg, whisper.cpp e modello vocale multilingue. Su Linux, l'avvio verifica poi i moduli nativi della piattaforma e il runtime Whisper con l'ABI di Electron prima di aprire l'app. I pacchetti Python per l'OCR e per le singole abilità vengono installati in ambienti locali isolati la prima volta che si usano quelle funzioni. Il primo avvio crea uno spazio di lavoro in `~/.orkas/` (macOS / Linux) o in `<smallest non-system drive>:\.orkas\` (Windows). Poi apri **Impostazioni → Provider di IA** per aggiungere una chiave API o OAuth.

Errori delle dipendenze native: usa Node.js 24 LTS (minimo 22.12.0), poi esegui
`npm run native:repair` da questo checkout. Questo comando ripristina i pacchetti opzionali,
ripara SQLite per Electron, prepara il Node incluso per l'elaborazione isolata delle immagini
e controlla SQL, sqlite-vec e sharp, segnalando il successo solo a controlli superati.
Usa `npm run native:check` per un controllo senza installazione.
I controlli eseguiti sono descritti nello [script di verifica delle dipendenze native](./scripts/verify-native-dependencies.cjs).

---

## Come funziona

### Instradamento delle attività

Il Commander gestisce da solo il lavoro generale e delega il lavoro specialistico tramite tre strumenti:

- **`dispatch_to`** esegue un agente indicato per nome e ne restituisce il risultato per proseguire il lavoro. Può attendere il risultato oppure funzionare in modo asincrono e avvisare il Commander quando l'attività è terminata.
- **`hand_off_to`** trasferisce il lavoro rimanente a un agente indicato per nome e chiude il turno corrente del Commander. L'agente fornisce la propria risposta; una continuazione facoltativa permette poi al Commander di riprendere un'attività più ampia.
- **`run_worker`** esegue una sotto-attività anonima e isolata e restituisce un risultato privato. Non riceve la cronologia della conversazione né le abilità di un agente indicato per nome.

Le attività degli agenti indicati per nome e i worker anonimi hanno controlli di concorrenza separati. Vedi l'[implementazione del dispatch](./src/main/features/group_chat/bus.ts) e i [lock di esecuzione](./src/main/util/locks.ts).

### Gestione del contesto

Il runtime calcola il budget di contesto in base alla capacità di input utilizzabile del modello selezionato, tenendo conto di prompt, strumenti e stato persistente del runtime. I dialoghi completati usano una finestra limitata della cronologia recente; le attività lunghe ancora in corso usano checkpoint per condensare i messaggi di processo precedenti mantenendo il lavoro recente. Letture di file, modifiche ai file ed esecuzioni di comandi hanno anche registrazioni strutturate che possono sopravvivere alla compattazione del contesto.

Vedi [budget di contesto](./src/core-agent/src/agent/context-budget.ts), [cronologia delle sessioni e checkpoint](./src/core-agent/src/agent/session.ts) e [registrazioni dello spazio di lavoro](./src/core-agent/src/agent/workspace-state.ts).

### Memoria e Biblioteca

Note persistenti conservano le preferenze dell'utente, i fatti relativi al progetto e le conoscenze riutilizzabili di ogni agente in ambiti separati. Queste note sono distinte dall'indice dei documenti della Biblioteca e dalla cronologia delle conversazioni salvata.

La Biblioteca suddivide i documenti in passaggi e memorizza un indice vettoriale SQLite locale. Il suo modello di embedding gira sul tuo computer; lo strumento `library` può elencare file, cercare passaggi pertinenti e leggere i contenuti originali dalla Biblioteca globale o da quella del progetto corrente. Le conversazioni precedenti vengono recuperate separatamente tramite `chat_history`.

Vedi [memoria per ambiti](./src/main/features/memory.ts), [estrazione dei documenti](./src/main/util/file_to_chunks.ts), [strumenti della Biblioteca](./src/main/model/core-agent/kb-tools.ts) e [recupero delle conversazioni](./src/main/model/core-agent/chat-history-tools.ts).

### Limiti di esecuzione e ripristino

I lock di sessione e i limiti di concorrenza tengono sotto controllo il lavoro in parallelo. Budget per i round di strumenti, checkpoint di avanzamento, controlli sulle chiamate ripetute e watchdog di inattività che tengono conto della fase aiutano a contenere le esecuzioni che si bloccano o ripetono lavoro. Le attività degli agenti indicati per nome possono essere monitorate e annullate singolarmente; un'attività accettata o in coda non viene considerata un risultato completato.

Vedi i [budget per attore](./src/main/features/group_chat/actor-budgets.ts), il [runtime degli agenti](./src/core-agent/src/agent/runner.ts) e l'[adattatore di modello per desktop](./src/main/model/core-agent/client.ts).

### Imparare dall'attività

Le revisioni in background esaminano la nuova attività degli agenti quando l'app è inattiva, nel rispetto di tempi di attesa e limiti di esecuzione. Una revisione può aggiornare l'autovalutazione di un agente (`COMPETENCE.md`), i metodi riutilizzabili (`LEARNING_STRATEGIES.md`) o le abilità apprese. Le revisioni dipendono dalla nuova attività svolta, non dal numero di compiti, e possono concludere che non c'è nulla che valga la pena salvare.

Vedi lo [scheduler delle riflessioni](./src/main/features/reflection-orchestrator.ts) e il [prompt di revisione](./src/core-agent/src/evolution/metacognition.ts).

---

## Domande frequenti

**Che cos'è Orkas?**
Orkas è un'app desktop multi-agente open source (MIT) con priorità al locale. Il suo Commander trasforma il tuo obiettivo in attività da fare e coordina 16 agenti specializzati integrati — oltre a Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent — per consegnare file finiti.

**Mi serve una chiave API?**
No. L'app installabile include 500 crediti per il modello Orkas integrato. Una volta esauriti, puoi acquistare crediti, scegliere un piano a pagamento o aggiungere le chiavi dei tuoi provider; i costi dei provider sono a parte.

**Orkas è un LLM locale?**
No. Orkas gira sul tuo computer e chiama i modelli che scegli — il modello Orkas integrato, le tue chiavi API o un endpoint di modello locale. Orchestra agenti e strumenti; non è esso stesso un modello.

**Orkas può rispondere a domande sui miei documenti, con citazioni?**
Sì. Aggiungi PDF e documenti alla tua Biblioteca locale; Orkas può cercare al loro interno e rispondere citando i passaggi originali, così puoi aprire l'originale e controllare. L'indice viene creato sul tuo computer.

**Posso usare modelli locali come Ollama o LM Studio?**
Sì. Apri **Impostazioni account → Modelli → Chat → Aggiungi modello → Personalizzato**, seleziona **Compatibile con OpenAI** o **Compatibile con Anthropic** e inserisci l'URL di base, l'ID esatto del modello e la chiave API. Poi scegli il modello salvato dal selettore del modello dell'attività.

**Dove vengono conservati le mie chiavi API e i miei dati?**
Sul tuo disco, per impostazione predefinita. Le chiavi dei tuoi provider sono cifrate in locale ed escluse dalla sincronizzazione cloud. Con le tue chiavi, le chiamate ai modelli vanno direttamente dal tuo computer al provider; il modello Orkas integrato usa il servizio gestito di Orkas. La sincronizzazione cloud facoltativa e i progetti condivisi dell'app installabile memorizzano i dati selezionati sui server di Orkas. [Sicurezza e gestione dei dati →](https://orkas.ai/security/?source=gh-orkas)

**Orkas funziona offline?**
La versione dal sorgente può funzionare completamente offline con un endpoint di modello locale. L'app installabile richiede l'accesso con un account e i modelli cloud richiedono una connessione di rete.

**Orkas continua a lavorare quando il computer è spento?**
No — Orkas gira sul tuo computer, quindi l'Avanzamento automatico e le automazioni richiedono che il computer non sia in sospensione e che Orkas sia in esecuzione. Dalla v1.9, quando il computer si riattiva o Orkas si avvia, ogni automazione recupera la sua ultima esecuzione saltata, se risale alle ultime 12 ore.

**Posso creare e pubblicare app?**
Sì. Le app locali che girano dentro Orkas sono gratuite. Per pubblicare una web app con un link pubblico serve un piano a pagamento (Lite 5, Pro 8, Max 15 app), e le web app pubblicate non includono tutte le funzionalità disponibili dentro Orkas.

**Mi serve un account Orkas?**
L'app desktop installabile ti chiede di accedere al primo avvio. La versione dal sorgente in questo repository non ha alcun livello di account — si avvia direttamente nell'app.

**Orkas può pilotare Claude Code e altri agenti CLI?**
Sì. Orkas può pilotare cinque agenti CLI esterni come sottoprocessi locali — gli agenti di programmazione Claude Code, Codex e OpenCode, più gli agenti personali OpenClaw e Hermes-Agent — e integrare progetti open source come HyperFrames, il tutto diretto dalla stessa chat.

**In cosa è diverso Orkas da Claude Code / Codex / CrewAI / LangChain?**
Claude Code e Codex sono agenti di programmazione — Orkas li esegue entrambi come membri del suo team, così non devi scegliere tra loro; CrewAI e LangChain sono framework incentrati sul codice. Orkas è un'app desktop open source in cui un Commander coordina un team di agenti specializzati e i tuoi agenti CLI, con qualsiasi provider di modelli, e tiene dati e chiavi in locale. Vedi i [confronti completi](https://orkas.ai/compare/?source=gh-orkas).

**Quali piattaforme supporta Orkas?**
Per macOS 12+ (Apple Silicon e Intel) e Windows 10+ sono disponibili programmi di installazione. Linux x64/arm64 con glibc 2.34+ oggi si esegue dal sorgente, per ora senza programma di installazione. La trascrizione vocale locale è supportata su Linux tramite il runtime whisper.cpp a versione fissata, preparato al primo avvio. Alpine e le altre distribuzioni basate su musl non sono supportate. L'avvio dal sorgente richiede Node 22.12+; Python 3 e una toolchain di compilazione C/C++ servono solo quando un pacchetto npm nativo non ha un binario precompilato compatibile e deve essere ricompilato in locale.

**Orkas è gratuito e open source?**
Sì — l'app ha licenza MIT ed è gratuita. L'app installabile include 500 crediti per il modello Orkas integrato; i piani a pagamento da $11.99/mese aggiungono crediti mensili, sincronizzazione cloud, più progetti condivisi e la pubblicazione di app. Con le tue chiavi, l'uso dei modelli viene fatturato dal tuo provider; Orkas non applica alcun ricarico. [Prezzi →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licenza

[MIT](./LICENSE)
