# Trading OS v2 — AI Work Rules

## Grundregel

Trading OS ska utvecklas säkert, stegvis och spårbart.

Ingen AI-agent får göra stora blandade ändringar utan att först förklara planen.

AI Strategy Control-reglerna i `docs/AI_STRATEGY_CONTROL.md` gäller alltid:
AI får förbättra icke-trade-strategier och read-only strategiunderlag, men får
aldrig röra Interactive Brokers, trade-godkända strategier, order, broker eller
risk utan separat beslut.

## Absoluta förbud

Ändra aldrig följande utan uttryckligt beslut:

```text
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

Bygg aldrig:

- live trading
- broker-aktivering
- orderläggning
- buy/sell-order
- auto-riskändring
- auto-apply av strategiändringar
- TradingView-forwarding till execution utan separat godkänd spec

## Standardarbetssätt

1. Läs aktuell branch och status.
2. Kontrollera vilka filer som är dirty.
3. Stoppa om det finns orelaterade dirty filer.
4. Föreslå liten plan.
5. Ändra få filer.
6. Kör tester.
7. Kör safety-grep.
8. Rapportera exakt vad som ändrades.
9. Fråga innan commit/push/restart.

## Git-regler

Kör alltid före arbete:

```bash
git branch --show-current
git status --short
```

Om arbetskatalogen inte är ren:

- identifiera dirty filer
- avgör om de hör till uppgiften
- rör inte orelaterade dirty filer
- skapa patch-backup vid behov

Exempel patch-backup:

```bash
git diff -- client/src/pages/NarrowStateLabPage.jsx client/src/pages/SupervisorBrainPage.jsx client/src/styles.css > backups/dirty-ui-before-overview-merge.patch
```

Återställ patch:

```bash
git apply backups/dirty-ui-before-overview-merge.patch
```

## Commit-regler

Commits ska vara små och tydliga.

Bra commit-typer:

```text
feat(supervisor): ...
fix(supervisor): ...
feat(ui): ...
docs(tradingview): ...
refactor(ui): ...
test(supervisor): ...
```

Exempel:

```text
fix(supervisor): render overview object values safely
feat(ui): improve supervisor and narrow beginner guidance
```

## Fråga alltid innan

Fråga användaren innan:

- commit
- `git push`
- `pm2 restart`
- merge till main
- delete av filer
- reset/checkout/stash som kan påverka arbete
- större UI-redesign
- backendflödesändring
- TradingView-kod
- schedulerändring
- schedulerändring som kör något nytt automatiskt
- execution/paper queue-ändring
- ändring i Interactive Brokers
- ändring i trade-godkända strategier
- ändring som påverkar order/trade/broker/risk

## AI Strategy Control

AI får arbeta självständigt med:

- nya, svaga och icke-godkända research-strategier
- replay-, batch- och learning-resultat
- parameterförslag, scoring, förklaringar och testplaner
- read-only rapporter och diagnostik

AI får inte:

- flytta strategi till trade-godkänd lista
- auto-godkänna strategi för trading
- använda buy/sell/execution
- ändra risk automatiskt
- skapa orderväg
- röra `/interactive-brokers`, IB-komponenter eller IB-services

Varje AI-rekommendation ska visa vad AI såg, varför det spelar roll, vad AI
vill förbättra, risknivå, `påverkar trading: nej`, och nästa steg på enkel
svenska.

## Tester efter UI-ändring

```bash
npm --prefix client run build
git diff --check
```

Röktesta routes:

```text
/supervisor
/overview
/narrow
```

## Tester efter backend-ändring

```bash
node src/services/supervisorOverviewService.test.js
node src/services/tradeStatsService.test.js
node src/services/narrowTestAutopilotService.test.js
git diff --check
```

Röktesta API:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<PORT>/api/supervisor/overview
```

Bekräfta safety:

```text
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

## Safety-grep

Kör grep mot ändrade filer eller branchdiff.

Sök efter:

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

Farliga ord i docs kan vara okej om de är uttryckligen förbjudande formuleringar, men aldrig i execution-kod.

## UI-regler

UI ska vara read-only tills annat beslutas.

Inga knappar för:

- execute
- live trading
- broker
- order
- riskändring
- auto-apply

UI ska förklara tekniska ord på svenska.

Prioritera:

- enkelhet
- safety
- autopilot-status
- testhistorik
- learning-resultat
- nästa rekommendation
- handlingsplan

## Backend-regler

Backend ska vara fault-isolerad.

En trasig blockkälla får inte krascha hela `/api/supervisor/overview`.

Använd blockstatus:

```text
ok
empty
degraded
error
```

## Rollback-regler

Varje commit ska kunna revertas:

```bash
git revert <sha>
```

Större deploy ska ha tydlig rollback-plan.

## PM2-regler

Fråga innan:

```bash
pm2 restart nasdaq-scanner
```

Efter restart:

```bash
pm2 status nasdaq-scanner
pm2 logs nasdaq-scanner --lines 80 --nostream
```

Röktesta:

```text
/api/supervisor/overview
/supervisor
/overview
/narrow
```
