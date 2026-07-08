---
description: Helhetsstatus för Trading OS — safety, PM2, batch, replay, paper, futures paper (read-only)
---

Ge en helhetsstatus för Trading OS. Allt read-only — ändra ingenting.

Kör och sammanfatta:

1. `git status --short` och aktuell branch (flagga dirty filer som kan tillhöra parallell session).
2. `pm2 status` (endast läsning) — är `nasdaq-scanner` online? uptime? restarts?
3. `curl -s http://127.0.0.1:3001/api/safety/status` — bekräfta `mode:"paper"`, `live_trading_enabled:false`, kill switch-läge.
4. `curl -s http://127.0.0.1:3001/api/status/batches | head -c 500` och `/api/status/replay | head -c 500`.
5. `curl -s http://127.0.0.1:3001/api/paper-trading/status | head -c 500` och `/api/futures-paper/runtime | head -c 500`.
6. `bash scripts/harness/safety_harness.sh` — rapportera PASS/FAIL.

Rapportera som kompakt tabell: komponent, status, senaste aktivitet, avvikelse. Avvikelser och FAIL överst. Ingen commit, ingen push, ingen pm2 save, inga POST-anrop.
