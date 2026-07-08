---
description: Kontrollera Futures Paper (MNQ/MES) — runtime, scanner, adapter-härkomst, submit-lås (read-only)
---

Kontrollera Futures Paper enligt docs/FUTURES_PAPER_PLATFORM.md. Allt read-only — rör aldrig IBKR submit, auto-sim eller gates.

1. **Runtime:** `curl -s http://127.0.0.1:3001/api/futures-paper/runtime` — läge, safety (paper_only), auto-sim (default AV — är den fortfarande av?).
2. **Konto/positioner/trades:** `/api/futures-paper/account`, `/positions`, `/trades | head -c 1500` — PnL (signedMoney), max 2 positioner, 1 micro-kontrakt/trade.
3. **Scanner/kandidater:** `/api/futures-paper/scanner` och `/candidates` — senaste kandidater och deras strategyId.
4. **Härkomst (kritiskt):** verifiera att alla kandidater/trades kommer från Trading OS-adaptern (`futuresTradingOsSignalAdapterService.js`) — inga futures-egna strategier. Signaler utan Trading OS-strategyId = avvikelse.
5. **Submit-lås:** `grep IB_PAPER_SUBMIT_ROUTES_ENABLED .env` → måste vara `false`; bekräfta att inga submit-vägar tangerats i dirty filer (`git status --short`).
6. `bash scripts/harness/futures_paper_harness.sh` — PASS/FAIL.

Rapport: runtime-läge, performance per strategyId, härkomstkontroll (ska vara 100 % Trading OS), submit-lås bekräftat. Ingen POST, ingen ändring.
