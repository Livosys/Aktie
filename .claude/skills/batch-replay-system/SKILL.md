---
name: batch-replay-system
description: Batch- och replay-systemet i Trading OS — motorer, autopiloter, status-endpoints, 4×/dag-schemat, resultatmärkning. Läs vid arbete med batch-tester, replay-sessioner, autopiloter eller forskningsschemat.
---

# Batch/Replay-systemet

Kanoniskt dokument: `docs/BATCH_REPLAY_SYSTEM.md`.

## Komponenter
- Batch-motor: `src/services/strategyBatchTestService.js`; status via `/api/status/batches`, `/api/strategy-batches` (+ `/:id/results`, `/:id/compare`), `/api/audit/batches/recent`.
- Batch-autopilot: `src/services/batchAutopilotService.js` — gated OFF default (`ENABLE_BATCH_AUTOPILOT`), dry-run-only, exekvering medvetet oimplementerad. Status: `/api/status/batch-autopilot`.
- Replay: sessions/runs via `/api/replay/sessions`, `/api/replay/runs`, `/api/replay/compare`, `/api/status/replay`; per-trade: `/api/trade-replay/...`.
- Replay-autopilot: `src/jobs/replayAutopilotScheduler.js` + `replayAutopilotService.js` — dry-run/plan-scheduler, env-gated.

## Schema
Mål: batch + replay 4×/dag vid 06:00, 12:00, 18:00, 23:00 Europe/Stockholm (samma tider för båda). Verklighet: autopiloter intervallbaserade och OFF. Aktivering = env/cron-ändring = **explicit order krävs**.

## Regler
1. Batch/replay skickar aldrig order (replay-exekvering blockeras dessutom av `executionSafetyService`: `replay_mode_blocked`).
2. Allt replay-resultat märks replay/backtest/simulation och blandas aldrig med live-paper-resultat.
3. Varje körning loggar resultat och visar vilka strategier som förbättrades och varför.
4. Batch/replay läser lokal store (`data/`) — "för lite historik" betyder backfill behövs, inte att kopplingen är trasig.
5. Resultat går vidare till Learning & Scoring och agentrapporter.

## Verifiering
`bash scripts/harness/batch_replay_harness.sh`; commands `/batch-check`, `/replay-check`.
