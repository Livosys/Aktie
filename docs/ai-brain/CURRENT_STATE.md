# Current State

Senast verifierat: 2026-08-05T08:03:46Z via read-only Git-preflight under Fas 2. Bygger på godkänd Fas 0-inventering, Fas 1 Second Brain-kärna och senare docs-only synkronisering.

Denna status är tidsbunden. Branch, HEAD, upstream, index, runtime, PM2-status och dirty worktree måste verifieras om vid varje ny session innan arbete fortsätter.

## Repo och runtime

Verifierat 2026-08-05T08:03:46Z:

- Projektmapp: `/var/www/nasdaq-scanner-prod`
- Git-root: `/var/www/nasdaq-scanner-prod`
- Alternativ mapp `/var/www/nasdaq-scanner`: saknades vid Fas 0
- Branch: `lab-batch-runnability-ui`
- HEAD: `82338a1`
- Upstream: `origin-disabled/lab-batch-runnability-ui`
- Ahead/behind: `ahead 65`, `behind 0`
- Index: tomt vid preflight
- PM2-process: `nasdaq-scanner`, enligt Fas 0 och senare read-only PM2-kontroll
- PM2-status senast verifierad före Fas 2: `online`
- Runtime working directory: `/var/www/nasdaq-scanner-prod`

Git-, PM2- och runtimestatus ovan är tidsbundna ögonblicksbilder. De får inte återanvändas som sanning i en ny session utan ny read-only verifiering.

Historisk referens:

- Vid Fas 0 var HEAD `14a7265` med `ahead 64`, `behind 0`.
- `82338a1 docs(ai-brain): add minimal multi-agent project context` är en lokal docs-only commit ovanpå `14a7265`.
- Git-publicering är fortsatt stoppad och upstream är `origin-disabled`.

## Dirty worktree

Dirty worktree fanns vid Fas 0, kvarstod vid Fas 2-preflight och får inte röras utan uttryckligt uppdrag.

Sammanfattade dirty arbetsområden:

- Futures Paper
- IBKR Paper execution
- market data
- frontend
- strategy store
- release verification
- tester

Untracked poster i repo-roten:

- `scratchpad/` har okänt ägarskap och får inte röras, flyttas, städas eller committas utan separat uttryckligt uppdrag.

Kopiera inte hela dirty fillistan mellan Second Brain-filer. Kör i stället ny Git-preflight när aktuell filnivå krävs.

## Aktuellt huvudmål

Trading OS befinner sig i ett tre dagar långt Mini Futures harness-test.

Målet är att verifiera att Trading OS egna strategier fungerar genom hela IBKR Paper-kedjan:

```text
marknadsdata
-> strategi
-> signal
-> kandidat
-> Entry Contract
-> Guard
-> Risk
-> execution intent
-> IBKR Paper-order
-> fill
-> brokerposition
-> reconciliation
-> exit
-> resultat
-> learning
```

Testet ska visa att egna strategier:

- producerar giltiga signaler och kandidater
- passerar rätt Entry Contracts
- stoppas med tydliga `blockedReason` när krav saknas
- passerar Guard och Risk när alla krav är uppfyllda
- kan skicka säkra paper-order till IBKR Paper
- får korrekta fills
- skapar korrekta brokerpositioner
- reconcileras korrekt mot Trading OS
- avslutas korrekt med stop, target eller annan godkänd exit
- registrerar PnL och resultat
- fortsätter säkert efter omstart
- inte skapar dubbla order efter reconnect eller restart

Mini Futures harness-testet är högsta prioritet.

PineScript- och TradingView-automation är en senare arbetsström. PineScript-arbetet får inte störa det pågående harness-testet.

## Verifierad systemmodell

Trading OS är en lokal produktionskörd research-, strategi-, paper-execution- och learning-plattform.

Futures Paper execution beskrivs som IBKR Paper enligt aktuell runtime-dokumentation och verifierad kod. Paper broker är inte live broker.

Intern futures-simulator är pensionerad enligt verifierad kod och får inte behandlas som aktiv utan ny evidens.

Live trading får inte antas vara aktivt.

Faktisk IB Gateway-status: EJ VERIFIERAT under detta Fas 2 read-only docs-uppdrag.

## Frontendens aktuella roll

Futures Paper Desk är kontrollrummet för harness-testet.

Den innehåller bland annat:

- Översikt
- Strategy Dashboard
- Analytics
- IBKR Paper-konto
- Brokerpositioner
- Ordrar
- Fills & trades
- Runtime
- IBKR Paper Execution
- Godkännande
- Teknisk info

Frontendens viktigaste uppgift under harness-testet är att visa:

- execution target
- datastatus
- scannerstatus
- kandidater
- Entry Contract-status
- `blockedReason`
- strategy approval
- order intent
- IBKR Paper-order
- broker order-ID
- fill
- position
- exit
- PnL
- reconciliation
- restart- och reconnectstatus

Observerade frontendtillstånd som ska verifieras mot kod och API innan de behandlas som slutlig sanning:

- execution target har visats som `ibkr_paper`
- minst en brokerposition har visats
- reconciliation har visats som `degraded`
- vissa account- och kapitalfält har visats som tomma eller streck
- order- och fillhistorik finns i gränssnittet
- Strategy Dashboard visar cirka 34 strategikort
- endast ett mindre antal strategier har komplett performance-evidens
- flera strategier visar behov av producer, market context eller annan evidens

Orsaken till `degraded` reconciliation och tomma kontofält är EJ VERIFIERAT. Gissa inte om det är frontend-, API-, runtime- eller brokerproblem.

Frontend är kontrollrum, inte execution source of truth. Backend, broker och ledger är auktoritativa för orders, fills och positioner.

## Dokumentkonflikter

Följande konflikter identifierades i Fas 0 och kräver försiktighet:

- Äldre dokument pekar på `/var/www/nasdaq-scanner`, men verifierad aktiv mapp är `/var/www/nasdaq-scanner-prod`.
- Äldre Supervisor-plan beskriver `/overview` och `/supervisor` annorlunda än aktuell frontend-routing.
- Äldre Futures Paper-platformdokument beskriver intern simulator som aktiv plattform, medan verifierad kod markerar den som pensionerad.
- IBKR Paper-submit har nyare runtime- och safety-dokumentation än vissa äldre fas-texter.
- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md` och `docs/tradingview-paper-replay-contract.md` är dubbletter som skiljer sig.

## Fortfarande inte verifierat

Följande var inte verifierat i Fas 0 och är fortfarande inte verifierat under Fas 2:

- Faktisk IB Gateway-anslutning och faktiskt brokertillstånd.
- Live trading aktiverat. Detta får inte antas.
- Orsaken till `degraded` reconciliation.
- Orsaken till tomma eller streckade account- och kapitalfält.
- Nginx/static serving direkt.
- Fullständig aktuell API-karta mot alla routes.
- Live-värden för secrets eller env-konfiguration.
- Full korrekthet i varje frontend-action.

## Auktoritativa läsningar

Läs främst:

- `docs/TRADING_OS_SAFETY.md`
- `docs/FUTURES_PAPER_RUNTIME.md`
- `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`
- `docs/DECISIONS.md`
- `docs/RUNBOOK_DEPLOYMENT.md`
- `docs/TRADING_OS_WORK_RULES.md`
- `docs/ai-brain/PROJECT_MAP.md`
- `docs/ai-brain/OPEN_BLOCKERS.md`
