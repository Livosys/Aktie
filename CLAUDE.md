# CLAUDE.md — Trading OS (nasdaq-scanner-prod)

Detta repo är **Trading OS**: en forsknings- och tradingplattform som forskar fram, testar och förbättrar strategier. Trading OS är hjärnan — alla strategier föds, testas och godkänns här. Paper Trading, Futures Paper och den framtida Mini Future-sidan är **konsumenter** av Trading OS-strategier, aldrig egna strategikällor.

## Sessionsstart — gör alltid detta först

Läs Second Brain i denna ordning innan något annat arbete påbörjas:

1. `docs/ai-brain/README.md` — navigering och source-of-truth-princip
2. `docs/ai-brain/CURRENT_STATE.md` — verifierat nuläge (tidsbundet)
3. `docs/ai-brain/WORK_RULES.md` — arbets- och safetyregler
4. `docs/ai-brain/NEXT_ACTION.md` — vad som faktiskt är godkänt just nu
5. `docs/ai-brain/SESSION_HANDOFF.md` — vad föregående session gjorde
6. `docs/ai-brain/PROJECT_MAP.md`, `OPEN_BLOCKERS.md`, `DECISIONS.md`, `REFERENCES.md` — vid behov

Kör därefter read-only Git-preflight i repo-roten:

```bash
git branch --show-current
git rev-parse --short HEAD
git status --short
```

Kontrollera att branch, HEAD, dirty worktree och PM2-status stämmer med `CURRENT_STATE.md`. Statusen där är en ögonblicksbild — den får aldrig återanvändas som sanning utan ny verifiering.

**Stoppa och rapportera** om projektmapp, branch, HEAD, runtime, dirty worktree eller safety-dokumentation avviker väsentligt från dokumenterat nuläge.

Om `NEXT_ACTION.md` saknar explicit implementationstillstånd är **inget** implementationsarbete godkänt. Dokumenterad plan, roadmap eller rekommendation är aldrig i sig ett godkännande att ändra kod, stage:a, committa, pusha, bygga, deploya, starta om PM2 eller påverka trading.

Second Brain-filer får skrivas endast med uttryckligt docs-uppdrag, och först efter `git status --short -- docs/ai-brain`. En annan agents dirty handoff får aldrig skrivas över.

## Kanoniskt flöde (rätt väg)

```
Trading OS-strategi
  → agentanalys (9 agenter, se docs/AI_AGENTS.md)
  → batch/replay (4 ggr/dag, se docs/BATCH_REPLAY_SYSTEM.md)
  → förbättrad logik (exits, SL/TP, filter, risk/reward)
  → Pine Script/signal (docs/PINESCRIPT_WORKFLOW.md)
  → Paper Trading
  → Futures Paper (MNQ/MES via adapter)
  → Mini Future-sidan (research/paper)
  → senare eventuell riktig handel (kräver separat explicit mänskligt godkännande)
```

**Fel väg (förbjuden):** Claude hittar på en ny strategi → ger den ett namn → skickar fake-signal → blandas med riktig strategi-performance. Om en testsignal måste skapas ska den alltid märkas `engine_test` och exkluderas från score/ranking.

## Säkerhetsregler (absoluta)

- Ingen live trading. Ingen broker-aktivering. Ingen IBKR submit. Ingen riktig order. Ingen riktig Mini Future-order.
- Behåll alltid: `mode=paper` / `paper_only`, `live_trading_enabled=false`, `broker_enabled=false`, `actions_allowed=false`, `can_place_orders=false`.
- **Ingen `git push`, ingen `git commit`, ingen `pm2 save`, ingen ändring i live execution utan explicit order från användaren.**
- Backend har hårdkodat skydd: `src/services/executionSafetyService.js` avvisar `mode=live` och `live_trading_enabled=true` på API-nivå. Försök aldrig kringgå det.
- Mini Future real-money trading requires separate explicit human approval.
- Detaljer: `docs/TRADING_OS_SAFETY.md` och `docs/SAFETY_RULES.md`.

## Systemkarta (var saker bor)

| Del | Nyckelfiler |
|---|---|
| Server | `server.js` (port 3001, bunden till 127.0.0.1), API under `/api` i `src/routes/api.js` |
| Safety | `src/services/executionSafetyService.js`, GET `/api/safety/status`, `/api/safety/config` |
| Batch | `src/services/strategyBatchTestService.js`, `batchAutopilotService.js` (gated OFF, dry-run only), `batchStatusService.js`; GET `/api/status/batches`, `/api/strategy-batches`, `/api/status/batch-autopilot` |
| Replay | `src/jobs/replayAutopilotScheduler.js`, `src/services/replayAutopilotService.js`, `replayStatusService.js`; GET `/api/status/replay`, `/api/replay/sessions`, `/api/replay/runs` |
| Paper Trading | `src/services/paperTradingRuntimeService.js`, `paperTradingStatusService.js`, `paperTradingTruthService.js`; GET `/api/paper-trading/status`, `/api/paper-trading/runtime` |
| Futures Paper | `src/services/futuresPaper*.js`, `futuresTradingOsSignalAdapterService.js` (adapter = enda strategikällan); GET `/api/futures-paper/runtime`, `/scanner`, `/candidates`, `/trades` |
| TradingView/Pine | POST `/api/tradingview/webhook` (`src/routes/api.js`), `tradingViewConnectorService.js`, `tradingViewPaperReplayPreviewService.js`; Pine-källor i `pine/` |
| Learning/Scoring | `strategyScoreService.js`, `daytradingLearningEngineService.js`, `learningConnectorService.js`, `researchScoreService.js` |
| Agenter | `.claude/agents/` (9 st), agentnära backend: `agentReasoningService.js`, `aiAnalystService.js`, `agentDebateEngineService.js` |
| Mini Future | Research/preparation-fas — se `docs/MINI_FUTURE_RESEARCH.md` (ingen ordervägar byggd, ska så förbli tills explicit order) |
| Deploy | PM2 `ecosystem.config.js`, Nginx `nginx-aktier.conf`; se `docs/RUNBOOK_DEPLOYMENT.md` |

## Batch + Replay: 4 gånger per dag

Målschema (Europe/Stockholm): **06:00, 12:00, 18:00, 23:00** — batch och replay vid samma tider. Nuvarande autopiloter är intervallbaserade och **gated OFF by default** (`ENABLE_BATCH_AUTOPILOT`, dry-run-only). Se `docs/BATCH_REPLAY_SYSTEM.md` för status, schema och aktiveringsregler. Batch/replay får aldrig skicka order; replay-resultat märks alltid replay/backtest/simulation och blandas aldrig med live-resultat.

## De 9 agenterna

Strategy Research, Risk & Exit, Pine Script, Paper Trading, Futures Paper, Mini Future, Market Regime, Learning & Scoring, System Safety & Deployment. Roller, inputs, outputs och förbud: `docs/AI_AGENTS.md` + `.claude/agents/*.md`. Generella regler för alla agenter: `AGENTS.md`. Ingen agent får aktivera live trading.

## Arbetsregler för Claude i detta repo

1. **Läs innan du skriver.** Grunda alla påståenden i faktiska filer/endpoints, inte antaganden.
2. **Parallella sessioner förekommer.** Rör aldrig andra sessioners dirty filer; committa (när beordrat) alltid med explicit pathspec.
3. **Frontend-build = direkt prod-deploy** (dist serveras statiskt). Kör aldrig `npm run build` i client som bieffekt. Backend-ändring kräver `pm2 restart nasdaq-scanner` (ok), men **aldrig `pm2 save`** utan order.
4. **Verifiera med harness:** `scripts/harness/*.sh` (read-only, exit 1 vid farlig status). Kör `safety_harness.sh` efter varje ändring som tangerar trading-vägar.
5. **Testresultat är testresultat.** Blanda aldrig `simulated_fallback`/`engine_test`/replay med riktig performance i rapporter.
6. **Beslut loggas** i `docs/DECISIONS.md`.
7. Hur Claude ska jobba långsiktigt: `docs/CLAUDE_CODE_OPERATING_MODEL.md`.

## Snabbkommandon

`/status`, `/safety-check`, `/batch-check`, `/replay-check`, `/paper-check`, `/futures-check`, `/agents-check`, `/pine-check`, `/mini-future-check`, `/safe-commit` — se `.claude/commands/`.
