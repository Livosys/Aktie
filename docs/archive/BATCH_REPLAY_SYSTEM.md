# BATCH_REPLAY_SYSTEM — Batch + Replay 4 gånger per dag

## Syfte

**Batch**: samla resultat, läsa nya trades, analysera strategy performance, uppdatera ranking, upptäcka svagheter, föreslå förbättringar, skapa strategi-varianter, förbättra exits/SL/TP/risk-reward, uppdatera agenternas arbetsunderlag, förbereda strategier för Paper Trading / Futures Paper / Mini Future-sidan.

**Replay**: spela upp tidigare marknadsdata/signaler/trades, testa strategier mot historiska scenarier, kontrollera om nya exits fungerar bättre, jämföra gammal vs ny strategi, testa volatilitet/trend/range/nyhetsrörelser, ge underlag till agenternas förbättringsarbete.

Ingen av dem skickar order. Någonsin.

## Befintligt system (inventering 2026-07-08)

| Komponent | Fil | Status |
|---|---|---|
| Batch-motor | `src/services/strategyBatchTestService.js` | Aktiv, körs manuellt/via Lab-UI |
| Batch-autopilot | `src/services/batchAutopilotService.js` | **PÅ i dry-run-läge** i prod (2026-07-08: enabled=true, dryRunOnly=true, intervall 360 min, maxPerDay 2 → 2 plan-körningar/dag). Producerar endast planförslag; exekvering medvetet oimplementerad (`executionEnabled:false`). Default i koden är OFF |
| Batch-status | `src/services/batchStatusService.js`; GET `/api/status/batches`, `/api/strategy-batches`, `/api/status/batch-autopilot`, `/api/audit/batches/recent` | Aktiv |
| Replay-motor | replay-engine/sessions; GET `/api/replay/sessions`, `/api/replay/runs`, `/api/replay/compare`, `/api/status/replay` | Aktiv |
| Replay-autopilot | `src/jobs/replayAutopilotScheduler.js` + `replayAutopilotService.js` | **PÅ i dry-run-läge** i prod (2026-07-08: enabled=true, dryRunOnly=true, intervall 360 min, maxPerDay 3). Endast planförslag; exekvering oimplementerad |
| Batch↔Replay-orkestrator | batch-replay autopilot (5 pass/dag) byggd i separat worktree | Gated OFF, EJ deployad hit |
| Trade-replay (per trade) | GET `/api/trade-replay/recent`, `/:tradeId/...` | Aktiv |
| Cron idag | `crontab`: 22:30 UTC read-only entry-filter forward validation | Aktiv, read-only |

**Rapport om tider:** systemet kör idag INTE 4 fasta tider — autopiloterna är intervallbaserade (360 min) med maxPerDay 2 (batch) / 3 (replay), dvs. i praktiken 2–3 dry-run-planer per dag på glidande tider (senast 07:53 UTC, nästa 13:53 UTC den 2026-07-08). Riktiga batch-/replay-körningar sker manuellt/via Lab-UI. Fast 4×/dag-schema med verkliga körningar är målbilden nedan.

## Målschema (föreslaget)

Europe/Stockholm, batch och replay vid samma tider:

| Tid | Motiv |
|---|---|
| 06:00 | Före EU-öppning: gårdagens US-session fullständig, natt-data klar |
| 12:00 | Efter EU-förmiddag, före US-öppning: pre-market-läge |
| 18:00 | Mitt i US-sessionen (15:30–22:00 CET): intradag-avstämning |
| 23:00 | Efter US-stängning: dagens fulla facit, tyngsta passet |

Rekommenderad aktivering (kräver explicit order — ändrar env/cron):
- Antingen env-gates: `ENABLE_BATCH_AUTOPILOT=true` + `BATCH_AUTOPILOT_DRY_RUN_ONLY=true` (fortsatt dry-run) och motsvarande replay-gates, med intervall-läge,
- eller (bättre för fasta tider) 4 cron-rader som kör en säker runner-wrapper och loggar till `logs/batch-replay-YYYYMMDD.log`.

## Krav på varje körning

1. Skriver logg + resultat (till `data/` och/eller `logs/`).
2. Visar vilka strategier som förbättrades och varför (delta i score/exit-parametrar).
3. Märker allt som `replay`/`backtest`/`simulation` — blandas aldrig med live-resultat (`executionSafetyService` blockerar dessutom replay-exekvering: `replay_mode_blocked`).
4. Skickar resultat vidare till strategi-analys och agentrapporter (Learning & Scoring Agent är mottagare).
5. Inga order, ingen broker, ingen env-ändring.

## Verifiering

```bash
bash scripts/harness/batch_replay_harness.sh
# eller manuellt:
curl -s http://127.0.0.1:3001/api/status/batches | head -c 400
curl -s http://127.0.0.1:3001/api/status/replay | head -c 400
curl -s http://127.0.0.1:3001/api/status/batch-autopilot
curl -s http://127.0.0.1:3001/api/status/replay-autopilot
```

Commands: `/batch-check`, `/replay-check`.
