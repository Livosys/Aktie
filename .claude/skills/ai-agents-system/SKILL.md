---
name: ai-agents-system
description: De 9 Trading OS-agenterna — roller, gränser, output-format, rapportkatalog. Läs vid agentarbete, agentrapporter eller när en uppgift matchar en agentroll (strategianalys, exits, pine, paper, futures, mini future, regime, scoring, safety/deploy).
---

# AI-agentsystemet

Kanoniska dokument: `AGENTS.md` (rot, generella regler), `docs/AI_AGENTS.md` (detaljroller), `.claude/agents/*.md` (körbara definitioner).

## De 9 agenterna
| Agent | Kärna |
|---|---|
| strategy-research | nya logiker, vinna/förlora-analys, förbättringsförslag |
| risk-exit | SL/TP, trailing, partial/time/volatility exits, risk/reward |
| pine-script | Pine ↔ backend-paritet, versionering |
| paper-trading | paper-resultat, test-separation, godkännande-kandidater |
| futures-paper | Trading OS-strategier på MNQ/MES, härkomstvakt |
| mini-future | produktmapping, knock-out-risk — ALDRIG riktig order |
| market-regime | bullish/bearish/range/volatile/news, regime-filter |
| learning-scoring | ranking, score, health, testkö-prioritering |
| system-safety-deployment | safety-flaggor, PM2/Nginx/deploy-vakt |

## Användning
- Matcha uppgiften mot en agentroll och följ den agentens fil (inputs, förbud, output-format). Spawna som subagent via Agent-verktyget (`subagent_type` = agentnamnet) när användaren ber om det eller vid större fan-out.
- Rapporter: `data/agent-reports/<agent>/<YYYY-MM-DD>.md`, format enligt AGENTS.md (Agent/Datum/Datakällor/Fynd/Förslag/Risker/Safety-bekräftelse).

## Hårda gränser (alla agenter)
Ingen live/broker/order-aktivering; inga frikopplade strategier (allt via Trading OS strategyId, annars `engine_test`); ingen push/commit/pm2 save/env-ändring utan explicit order; replay/test blandas aldrig med riktig performance.

## Verifiering
`bash scripts/harness/agents_harness.sh`; command `/agents-check`.
