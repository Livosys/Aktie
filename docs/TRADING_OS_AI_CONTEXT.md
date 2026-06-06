# Trading OS v2 — AI Project Context

## Syfte

Trading OS v2 / Nasdaq Scanner är inte primärt ett live trading-system.

Det är en lärande forskningsplattform vars mål är att:

- testa strategier
- mäta strategier
- jämföra resultat
- förbättra strategier
- identifiera svagheter
- föreslå nästa test
- bygga en framtida självgående Learning Engine

## Absoluta safety-regler

Live trading är alltid avstängt.

Följande ska alltid gälla:

```text
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

Systemet får:

- analysera
- paper-trada
- replay-testa
- batch-testa
- lära sig
- optimera
- rekommendera

Systemet får aldrig:

- lägga riktiga order
- köpa
- sälja
- aktivera broker
- ändra risk automatiskt
- auto-apply:a strategiändringar
- bygga live trading-flöden

## Projektplats

Serverprojekt:

```text
/var/www/nasdaq-scanner
```

Frontend:

```text
client/
```

Backend:

```text
src/
```

## Aktuell status

Main innehåller nu:

- narrowAutopilotScheduler.js
- tradeStatsService
- supervisorOverviewService
- `/api/supervisor/overview`
- `/overview` frontend-sida
- render-fix för `/overview`
- TradingView paper/replay-spec som dokumentation, ingen kod

Viktiga commits på main:

```text
5a24557 merge: canonical trade stats + supervisor overview into main
1e092c5 fix(supervisor): render overview object values safely
```

Separat UI-branch:

```text
feat/supervisor-ui-polish
```

Innehåller:

```text
ed11e52 feat(ui): improve supervisor and narrow beginner guidance
```

Den branchen innehåller UI-polish för:

- client/src/pages/SupervisorBrainPage.jsx
- client/src/pages/NarrowStateLabPage.jsx
- client/src/styles.css

## Viktiga sidor

```text
/supervisor
```

Nuvarande huvud-Supervisor. Har bäst design och nybörjarton.

```text
/overview
```

Read-only testvy. Har bäst arkitektur eftersom den läser en samlad endpoint:

```text
GET /api/supervisor/overview
```

```text
/narrow
```

Narrow State Lab. Ska fortsätta vara separat labbsida.

## Beslut

`/overview` vann arkitekturen.

`/supervisor` vann designen.

Slutmålet är att skapa EN huvud-Supervisor:

- data från `/api/supervisor/overview`
- design från `SupervisorBrainPage.jsx`
- Stitch-inspirerad layout
- autopilot-status högst upp
- testhistorik tydligt
- learning-resultat
- risker
- handlingsplan

## Viktiga datakällor

```text
GET /api/supervisor/overview
GET /api/autopilot/narrow/status
GET /api/learning/narrow-performance
GET /api/daytrading/learning-summary
```

Målet är att `/supervisor` senare helst bara ska läsa:

```text
GET /api/supervisor/overview
```

## Testhistorik som behövs

Vi vill visa:

- vilka tester/körningar som har gjorts
- när de gjordes
- typ: scheduled dry-run, manual dry-run, batch, replay, paper
- strategi/test
- symbol/timeframe om det finns
- score-band om det finns
- antal trades/testresultat
- win rate / andel lyckade tester
- avg result / genomsnittligt resultat
- dryRun=true/false
- executed=true/false
- blockedReason om något stoppades
- varför systemet valde testet
- nästa rekommendation efter testet

Källa att undersöka:

```text
data/autopilot/narrow-autopilot-history.jsonl
narrowTestAutopilotService.readNarrowAutopilotHistory()
supervisorOverviewService
```

## Viktig render-lärdom

`/overview` kraschade tidigare eftersom React försökte rendera ett objekt direkt:

```text
{band, scoreRange, winRate, avgPnl}
```

Det fixades i:

```text
client/src/pages/SupervisorOverviewPage.jsx
```

Nästa steg är att flytta render-säkerhet till en delad util:

```text
client/src/utils/safeRender.js
```

Innehåll:

- SafeText
- safeString
- formatBand
- fmtPct
- fmtSignedPct
- num

## Viktiga tester

Frontend:

```bash
npm --prefix client run build
```

Backend:

```bash
node src/services/supervisorOverviewService.test.js
node src/services/tradeStatsService.test.js
node src/services/narrowTestAutopilotService.test.js
```

Övrigt:

```bash
git diff --check
```

Safety-grep bör kontrollera att inget introducerar:

```text
placeOrder
submitOrder
broker
live_trading_enabled: true
can_place_orders: true
actions_allowed: true
buy
sell
order
execute
```

## Arbetsregel

Jobba i små steg.

En ändring per commit.

Rapportera alltid:

- ändrade filer
- vad ändringen gör
- tester
- safety-bekräftelse
- git status --short
- rollback-plan

Fråga innan:

- push
- pm2 restart
- merge till main
- delete av filer
- större UI-ombyggnad
- ändring av backendflöden
