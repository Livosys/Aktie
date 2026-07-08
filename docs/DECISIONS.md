# DECISIONS — Beslutslogg

Format: datum, beslut, motiv, konsekvens. Nya beslut läggs överst. Claude ska logga användarens arkitektur-/policybeslut här (inte varje kodfix — git-historiken täcker det).

---

## 2026-07-08 — Hävstångstest 10x/15x/20x i Mini Future-research
- **Beslut:** Research ska inte bara undvika hög hävstång utan aktivt testa `leverageTestLevels = [10, 15, 20]` per strategi i paper/simulation. Riskmärkning: 10x=`high`, 15x=`very_high`, 20x=`extreme`; 20x blockeras inte i research men märks alltid. Resultat märks med `leverageLevel`/`riskLevel` (+ `knockOutDistancePct`/`spreadPct` när produktdata finns); score får hävstångsbrutna fält (winRate/pnl/maxDrawdown per nivå) samt `bestLeverageLevel` + `leverageRecommendation`. All real-money med hög hävstång kräver separat explicit human approval.
- **Motiv:** Hitta vilka strategier som klarar att arbeta nära stop/knock-out innan Mini Future-fasen; datadriven hävstångsrekommendation i stället för generell försiktighet.
- **Konsekvens:** `docs/MINI_FUTURE_RESEARCH.md` (kanonisk testmodell + UI-plan), `docs/AI_AGENTS.md` (Mini Future Agent) och `docs/TRADING_OS_SAFETY.md` uppdaterade. Endast docs/plan — ingen kod, ingen order-väg, inget live.

## 2026-07-08 — Claude Code Operating System etablerat
- **Beslut:** Repo får CLAUDE.md + AGENTS.md + docs (arkitektur/safety/batch-replay/agenter/pine/mini future/runbooks/MCP/operating model) + `.claude/agents|commands|skills` + `scripts/harness` + föreslagna hooks (ej auto-aktiverade).
- **Motiv:** Claude ska arbeta långsiktigt med systemet, inte göra engångsändringar; Trading OS dokumenteras som hjärnan, alla exekverings-ytor som konsumenter.
- **Konsekvens:** All framtida agent-/Claude-aktivitet följer AGENTS.md-reglerna; harness är standardverifiering; ingen commit/push/pm2 save gjordes vid etableringen.

## 2026-07-08 — Batch/Replay-målschema 4×/dag
- **Beslut:** Målschema 06:00, 12:00, 18:00, 23:00 Europe/Stockholm för batch + replay (samma tider). Nuvarande autopiloter är intervallbaserade och gated OFF; aktivering av schemat kräver separat explicit order (env/cron-ändring).
- **Motiv:** Fasta tider runt EU-öppning, pre-US, mitt-i-US och post-US ger komplett forskningscykel.
- **Konsekvens:** `docs/BATCH_REPLAY_SYSTEM.md` är kanonisk; ingen gate ändrades ännu.

## 2026-07-08 — Strategikälla-principen
- **Beslut:** Futures Paper och Mini Future-sidan får aldrig ha egen strategilogik; allt kommer från Trading OS via adapter (`futuresTradingOsSignalAdapterService`). Claude-påhittade strategier märks `engine_test` och exkluderas ur score.
- **Motiv:** Undvika att test-/fake-signaler blandas med riktig strategi-performance.
- **Konsekvens:** Agenterna 5 och 6 har detta som hårt förbud; pine-filer kräver strategyId.

## 2026-07-08 — Mini Future real-money låst
- **Beslut:** Mini Future-sidan byggs som research/paper. Real-money trading requires separate explicit human approval; inga ordervägar får existera i koden före den fasen.
- **Motiv:** Paper-first, forskningsbaserad utveckling.
- **Konsekvens:** `mini_future_harness.sh` failar om ordervägar dyker upp i mini-future-kod.

---

## Äldre beslut (från arbetshistorik, för kontext)

- **2026-07-07:** AI Control Room kanonisk i nasdaq-scanner-prod (37f40d6); PM2 repointad + pm2 save körd. Rollback: deploy-2438421.
- **2026-07-07:** trend_continuation-fallback för okända signaler borttagen (ef5afd1); REGULAR_PULLBACK får inte öppna paper-trades (894af2e). ~84 % volymfall i paper = design, inte fel.
- **2026-07-07:** Market-gate crypto-EMA-regeln lämnas orörd (användarbeslut A) — riskregel, inte bugg.
- **2026-07-06:** NARROW_FAKEOUT-detektor aktiverad live; bias-diagnos: strategier utan producent ger 0 trades.
- **2026-07-03:** IB futures FAS1/FAS2: preview-only order-ticket, submit-väg EJ byggd, gates default OFF.
- **Tidigare:** main vs futures-base divergerar (164 filer) — futures-base/deploy är arbetslinje; radera ej futures-base.
