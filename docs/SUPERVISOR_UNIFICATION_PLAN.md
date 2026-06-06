# Supervisor Unification Plan

## Beslut

`/overview` vann arkitekturen.

`/supervisor` vann designen.

Målet är att skapa EN huvud-Supervisor.

## Nuvarande sidor

```text
/supervisor
```

Nuvarande huvudvy. Bygger på `SupervisorBrainPage.jsx`. Har bäst design, nybörjarton och tradingos-komponenter.

```text
/overview
```

Ny testvy. Bygger på `SupervisorOverviewPage.jsx`. Har bäst datamodell eftersom den läser en enda endpoint:

```text
GET /api/supervisor/overview
```

```text
/narrow
```

Narrow State Lab. Ska fortsätta vara separat labbsida.

## Målvyn

`/supervisor` ska bli den nya enade Supervisor-vyn.

Den ska använda:

- `SupervisorBrainPage.jsx` som designbas
- `/api/supervisor/overview` som huvuddatakälla
- render-säkra helpers från `safeRender.js`
- Stitch-inspirerad layout
- tradingos-komponenter
- enkel nybörjarcopy

## Första skärmen ska svara på

1. Är systemet säkert?
2. Är autopilot igång?
3. Vad gör systemet i bakgrunden?
4. När kördes senaste test/planering?
5. När körs nästa?
6. Vad rekommenderas härnäst?

## Huvudsektioner

### 1. Hero + Safety

Visa:

- Supervisor
- kort beskrivning
- Paper Only
- Live Trading Off
- Real Orders Blocked
- Broker Disabled

Undvik att visa råa tekniska flaggor som huvudinformation.

Råa flaggor kan ligga bakom “Visa tekniska detaljer”.

### 2. Autopilot jobbar i bakgrunden

Ska ligga högt upp.

Visa:

- status: aktiv/pausad
- mode: dry-run only
- senaste körning
- nästa körning
- senaste rekommendation
- cooldown-status
- blocked reason
- execution avstängt

Text:

```text
Autopilot planerar nästa test automatiskt. Den köper eller säljer aldrig.
```

### 3. Vad händer just nu?

Fyra stora kort:

- Systemet är säkert
- Autopilot är aktiv
- AI lär sig
- Nästa rekommenderade test

### 4. Senaste tester och körningar

Detta är en huvudsektion.

Visa som timeline eller tabell.

För varje event:

- datum/tid
- typ: scheduled dry-run, manual dry-run, batch, replay, paper
- strategi/testnamn
- symbol/timeframe om det finns
- score-band om det finns
- antal trades/testresultat
- andel lyckade tester
- genomsnittligt resultat
- dryRun
- executed
- reason
- blockedReason
- nästa rekommendation

### 5. Vad AI har lärt sig

Visa:

- antal analyserade resultat
- bästa strategi
- svagaste strategi
- mest lovande marknadsläge
- kort enkel sammanfattning

### 6. Strategiresultat

Visa i standardvyn:

- Fungerar bäst just nu
- Behöver mer testning

Avancerade score-band och confirmations ska inte dominera huvudvyn.

### 7. Risker systemet ser

Visa:

- data saknas
- cooldown aktiv
- få tester
- osäkra strategier
- live trading avstängt
- eventuella degraded/error-block

### 8. Handlingsplan

Visa 3–5 tydliga steg.

Exempel:

1. Vänta in nästa automatiska dry-run.
2. Följ rekommenderat test.
3. Kontrollera datakvalitet.
4. Fortsätt i paper-only.
5. Testa mer innan något ändras.

### 9. Ordlista

Collapsible längst ner.

Förklara:

- Paper only
- Dry-run
- Autopilot
- Scheduler
- Cooldown
- Blocked reason
- Win rate / andel lyckade tester
- Avg result / genomsnittligt resultat
- Narrow State
- Breakout
- Fakeout
- VWAP
- Replay
- Batch
- Confidence

## Byggordning

### Steg 1 — Merga UI-polish

Merga:

```text
feat/supervisor-ui-polish → main
```

Syfte:

- få nybörjarcopy och designkomponenter till main
- backend orört

### Steg 2 — Delad render-säkerhet

Skapa:

```text
client/src/utils/safeRender.js
```

Flytta dit:

- SafeText
- safeString
- formatBand
- fmtPct
- fmtSignedPct
- num

### Steg 3 — recentTests i overview-backend

Lägg additivt till:

```text
recentTests
```

i `/api/supervisor/overview`.

Källa:

```text
data/autopilot/narrow-autopilot-history.jsonl
narrowTestAutopilotService.readNarrowAutopilotHistory()
```

Read-only.

Fault-isolerat.

### Steg 4 — Re-peka SupervisorBrainPage

Byt datalager i `SupervisorBrainPage.jsx` till:

```text
GET /api/supervisor/overview
```

Mappa overview-blocks till befintliga designkomponenter.

### Steg 5 — Autopilot-banner + testhistorik

Lägg in:

- sticky autopilot topbanner
- “Senaste tester och körningar”
- “Vad AI lärde sig”
- “Nästa rekommenderade test”
- risker
- handlingsplan

### Steg 6 — /overview som alias

När unified `/supervisor` är verifierad:

- gör `/overview` till alias/redirect till `/supervisor`
- eller behåll tillfälligt som fallback

### Steg 7 — Cleanup

Ta bort döda sidor i egen commit efter verifiering:

- SupervisorPage.jsx
- SupervisorV2Page.jsx

Skörda bra designidéer först.

## Dubbletter

Målet är att gå från flera Supervisor-sidor till en.

Finns/har funnits:

- SupervisorPage.jsx — död/oroutad
- SupervisorV2Page.jsx — död/oroutad men kan ha bra tradingos-design
- SupervisorBrainPage.jsx — live `/supervisor`
- SupervisorOverviewPage.jsx — live `/overview` testvy

## Tester efter varje steg

```bash
npm --prefix client run build
node src/services/supervisorOverviewService.test.js
node src/services/tradeStatsService.test.js
node src/services/narrowTestAutopilotService.test.js
git diff --check
```

Röktest:

```text
/supervisor
/overview
/narrow
/api/supervisor/overview
```

## Safety

Denna plan är read-only UI + read-only backend-läsning.

Ingen:

- live trading
- broker
- orderläggning
- riskändring
- schedulerändring
- TradingView-kod
