---
description: Kontrollera batch-systemet — senaste körning, schema, resultat (read-only)
---

Kontrollera batch-systemet enligt docs/BATCH_REPLAY_SYSTEM.md. Allt read-only — ändra inte trading/live/order, starta inga batcher.

1. **Hitta batch-systemet:** `src/services/strategyBatchTestService.js`, `batchAutopilotService.js`, `batchStatusService.js`.
2. **Senaste körning:** `curl -s http://127.0.0.1:3001/api/status/batches` och `curl -s "http://127.0.0.1:3001/api/strategy-batches"` — visa senaste batch (id, när, strategier, status). Komplettera med `/api/audit/batches/recent`.
3. **Nästa körning + 4×/dag-frågan:** `curl -s http://127.0.0.1:3001/api/status/batch-autopilot` + env-gates (`ENABLE_BATCH_AUTOPILOT`, `BATCH_AUTOPILOT_INTERVAL_MINUTES`, `BATCH_AUTOPILOT_MAX_PER_DAY`) + `crontab -l`. Rapportera explicit: körs batch 4 gånger per dag? (Målschema: 06/12/18/23 Europe/Stockholm — jämför med verkligheten.)
4. **Resultat från senaste batch:** `curl -s http://127.0.0.1:3001/api/strategy-batches/<senaste-id>/results | head -c 1500` — sammanfatta vilka strategier som förbättrades/försämrades och varför.

Rapport: senaste körning, nästa körning (eller "autopilot OFF"), schema-verklighet vs mål, topp-fynd ur resultaten. Inga POST-anrop, ingen gate-ändring.
