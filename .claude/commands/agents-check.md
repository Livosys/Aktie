---
description: Kontrollera de 9 agenterna — definitioner, senaste output, luckor (read-only)
---

Kontrollera agent-systemet enligt docs/AI_AGENTS.md. Allt read-only.

1. **Vilka agenter finns:** lista `.claude/agents/*.md` — förväntat 9: strategy-research, risk-exit, pine-script, paper-trading, futures-paper, mini-future, market-regime, learning-scoring, system-safety-deployment. Rapportera saknade/extra.
2. **Senaste output per agent:** lista `data/agent-reports/<agent>/` (senaste fil + datum per agent). Agenter utan rapporter = "saknar data".
3. **Backend-agentläge:** `curl -s http://127.0.0.1:3001/api/agent/latest-analysis | head -c 500` och `/api/strategy-lab/tradingagents/status | head -c 500`.
4. **Förbättringsbehov:** för varje agent, jämför dess förbättringsmål (docs/AI_AGENTS.md) mot senaste rapport — vilka agenter behöver köras/förbättras?
5. **Safety-bekräftelse:** verifiera att varje agentfil innehåller sina förbud och bekräfta i rapporten: **ingen agent har rätt att aktivera live trading** (live/broker/order är förbjudet i AGENTS.md + per-agent-filer).
6. `bash scripts/harness/agents_harness.sh` — PASS/FAIL.

Rapport: tabell (agent, definition finns, senaste output, saknar data?, nästa åtgärd). Ingen ändring av agentfiler utan explicit order.
