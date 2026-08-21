# Current State

Senast verifierat: 2026-08-05T08:35:45Z via read-only Git-preflight. Bygger på godkänd Fas 0-inventering, Fas 1 Second Brain-kärna, Fas 2 docs-only projektkarta, Canonical Shadow Harness-korrigering och senare docs-only synkronisering.

Denna status är tidsbunden. Branch, HEAD, upstream, index, runtime, PM2-status och dirty worktree måste verifieras om vid varje ny session innan arbete fortsätter.

## Repo och runtime

Verifierat 2026-08-05T08:35:45Z:

- Projektmapp: `/var/www/nasdaq-scanner-prod`
- Git-root: `/var/www/nasdaq-scanner-prod`
- Alternativ mapp `/var/www/nasdaq-scanner`: saknades vid Fas 0
- Branch: `lab-batch-runnability-ui`
- HEAD: `a44d8ae`
- Upstream: `origin-disabled/lab-batch-runnability-ui`
- Ahead/behind: `ahead 67`, `behind 0`
- Index: tomt efter senaste commit
- PM2-process: `nasdaq-scanner`, enligt Fas 0 och senare read-only PM2-kontroll
- PM2-status senast verifierad före Fas 2: `online`
- Runtime working directory: `/var/www/nasdaq-scanner-prod`

Git-, PM2- och runtimestatus ovan är tidsbundna ögonblicksbilder. De får inte återanvändas som sanning i en ny session utan ny read-only verifiering.

Historisk referens:

- Vid Fas 0 var HEAD `14a7265` med `ahead 64`, `behind 0`.
- `82338a1 docs(ai-brain): add minimal multi-agent project context` är en lokal docs-only commit ovanpå `14a7265`.
- `8763148 docs(ai-brain): document mini futures harness priority` är en lokal docs-only commit ovanpå `82338a1`.
- `a44d8ae docs(claude): lägg till Second Brain-läsordning vid sessionsstart` är en lokal docs-only commit ovanpå `8763148`. Den lägger till läsordning och Git-preflight i `CLAUDE.md` så att varje ny session får dem automatiskt.
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

## Aktuellt huvudmål - Canonical Shadow Harness

Trading OS befinner sig i en 2-3 RTH-dagar lång evidensperiod för den nya Canonical Execution Readiness Engine.

Syftet är att jämföra:

```text
befintlig produktionslogik
mot
Canonical Execution Readiness Engine i shadow mode
```

för samma kandidater.

Varje dag ska följande verifieras:

- antal kandidater
- antal identiska beslut
- identitetsprocent
- beslutsskillnader
- reasonCode-skillnader
- första avvikande kandidat, om någon finns
- nya eller okända reasonCodes

Mål:

- 0 beslutsskillnader
- 0 reasonCode-skillnader
- stabilt resultat över 2-3 oberoende hela RTH-dagar

Redan rapporterad evidens, markerad som ANVÄNDARRAPPORTERAD EVIDENS eftersom Git, tester och rapportfiler inte verifierades direkt under detta docs-only-uppdrag:

- VWAP- och strategyId-fixen verifierad
- Canonical Signal byggd
- Canonical adapters byggda
- Execution Readiness Engine byggd
- 143 tester gröna
- historisk shadowjämförelse: 2374/2374 identiska
- live shadowjämförelse: 243/243 identiska
- verifieringsfel kring marketContext upptäcktes och rättades
- efter rättningen var jämförelsen fortsatt 100 %
- refererad commit för detta läge: `66fb766`

Tydliga begränsningar under evidensperioden:

- produktionen använder fortfarande den gamla logiken
- Canonical Engine kör endast shadowjämförelse
- ingen routing har bytts
- scheduler har inte migrerats
- IBKR Paper-kedjan har inte migrerats
- ingen live trading har aktiverats
- ingen riskregel ska ändras
- PineScript, Batch, Replay, Dashboard och AI ska migreras först senare
- IBKR Paper execution och reconciliation är viktiga systemområden men inte huvudsyftet med detta harness-test

## Daglig körning

Planerad daglig kontroll:

```bash
node scripts/shadowReadinessCompare.js --day YYYY-MM-DD
```

Den ska normalt köras efter att hela RTH-sessionen är avslutad, så att hela dagens kandidater finns i jämförelseunderlaget.

Om resultatet är 100 %:

- gör ingen kodändring
- samla nästa fulla RTH-dag

Om en avvikelse finns:

- undersök endast den första avvikande kandidaten
- ändra inte flera orelaterade saker
- refaktorera inte
- optimera inte
- migrera inte routing

## Verifierad systemmodell

Trading OS är en lokal produktionskörd research-, strategi-, paper-execution- och learning-plattform.

Nuvarande produktion använder fortfarande befintlig produktionslogik för execution readiness-beslut. Canonical Execution Readiness Engine kör endast shadowjämförelse och får inte påverka routing, scheduler, risk, order, positioner eller brokerstatus under evidensperioden.

Futures Paper execution beskrivs som IBKR Paper enligt aktuell runtime-dokumentation och verifierad kod. Paper broker är inte live broker. IBKR Paper execution och reconciliation är ett separat operativt spår, inte den primära framgångsmätaren för Canonical Shadow Harness.

Intern futures-simulator är pensionerad enligt verifierad kod och får inte behandlas som aktiv utan ny evidens.

Live trading får inte antas vara aktivt.

Faktisk IB Gateway-status: EJ VERIFIERAT under detta Fas 2 read-only docs-uppdrag.

## Frontendens aktuella roll

Futures Paper Desk är kontrollrum för Mini Futures- och IBKR Paper-status, men inte source of truth för Canonical Shadow Harness-beslut.

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

Frontendens viktigaste uppgift för det operativa IBKR Paper-spåret är att visa:

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

Frontend är kontrollrum, inte execution source of truth. Backend, broker och ledger är auktoritativa för orders, fills och positioner. Shadowjämförelser och reasonCode-identitet ska verifieras från jämförelserapporter och relevanta backendartefakter, inte från frontendens sammanfattningar.

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
- De användarrapporterade Canonical Shadow Harness-siffrorna mot Git, tester och rapportfiler.
- Fulla 2-3 oberoende RTH-dagar med 0 beslutsskillnader och 0 reasonCode-skillnader.
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
