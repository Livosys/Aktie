---
description: Kontrollera replay-systemet — senaste replay, schema-synk med batch, resultat (read-only)
---

Kontrollera replay-systemet enligt docs/BATCH_REPLAY_SYSTEM.md. Allt read-only — ändra inte trading/live/order, starta inga replays.

1. **Hitta replay-systemet:** `src/jobs/replayAutopilotScheduler.js`, `src/services/replayAutopilotService.js`, `replayStatusService.js`, replay-endpoints i `src/routes/api.js`.
2. **Senaste replay:** `curl -s http://127.0.0.1:3001/api/status/replay` + `curl -s "http://127.0.0.1:3001/api/replay/sessions"` och `/api/replay/runs` — visa senaste session/run (id, när, omfattning, status).
3. **Nästa replay + schema-synk:** `curl -s http://127.0.0.1:3001/api/status/replay-autopilot` + env-gates. Rapportera explicit: körs replay vid samma tider som batch? (Krav: samma 4 tider — 06/12/18/23.)
4. **Replay-resultat:** senaste run/summary (`/api/replay/sessions/<id>/summary`, `/api/replay/compare`) — sammanfatta jämförelser gammal vs ny strategi/exit. Verifiera att resultaten är märkta replay/backtest/simulation och inte blandas med live-resultat.

Rapport: senaste replay, nästa replay (eller "autopilot OFF/dry-run"), synk med batch-schemat, topp-fynd. Inga POST-anrop, ingen gate-ändring.
