---
description: Kontrollera Paper Trading — runtime, trades, test-separation, caps (read-only)
---

Kontrollera Paper Trading. Allt read-only — starta/stoppa inget, ändra ingen allowlist.

1. **Runtime:** `curl -s http://127.0.0.1:3001/api/paper-trading/status` och `/api/paper-trading/runtime` — enabled? mode paper_only? daily caps-läge (total 30 / narrow 10 / per-strategi 8 / per-narrow 5)?
2. **Trades:** `curl -s "http://127.0.0.1:3001/api/daytrading/paper-trades" | head -c 2000` — öppna positioner + senaste stängda; PnL-sammanfattning per strategi.
3. **Test-separation:** identifiera trades märkta `engine_test`/curl/manual/`simulated_fallback` och bekräfta att de exkluderas ur score (jfr `paperTradingTruthService.js`).
4. **Signaler/skips:** `/api/daytrading/paper-signals` + `/api/daytrading/paper-strategy-diagnostics` — senaste skip-reasons/blockedReason (t.ex. REGULAR_PULLBACK ska skippas med tydlig reason, inga fallbacks för okända signaler).
5. **Allowlist/readiness:** `/api/automation/paper-allowlist/config` — vilka strategier är godkända och runtime-ready?

Rapport: runtime-läge, performance per strategi (exkl. test), testtrade-andel, avvikelser. Ingen POST, ingen ändring.
