# TRADING_OS_ARCHITECTURE — Helhetsarkitektur

> Kompletterar `docs/SYSTEM_ARCHITECTURE.md` (teknisk detalj) med forsknings-/OS-perspektivet. Trading OS är hjärnan; alla exekverings-ytor är konsumenter.

## Lager

```
┌─────────────────────────────────────────────────────────────┐
│ 1. DATA         Alpaca 2m-historik, lokal store (data/),    │
│                 fallback-feeds, market regime-underlag       │
├─────────────────────────────────────────────────────────────┤
│ 2. TRADING OS   Strategikatalog (daytradingStrategyCatalog), │
│    (hjärnan)    scanner, signal-familjer, entry-quality,     │
│                 exitEngine, executionSafety                  │
├─────────────────────────────────────────────────────────────┤
│ 3. FORSKNING    Batch (strategyBatchTestService) + Replay    │
│                 (replayEngine/replayAutopilot) 4 ggr/dag,    │
│                 Learning (strategyScore, learningConnector)  │
├─────────────────────────────────────────────────────────────┤
│ 4. AGENTER      9 roller (.claude/agents, docs/AI_AGENTS.md) │
│                 analyserar lager 2–3, föreslår förbättringar │
├─────────────────────────────────────────────────────────────┤
│ 5. SIGNAL-UT    Pine Script/TradingView-webhook,             │
│                 futuresTradingOsSignalAdapterService         │
├─────────────────────────────────────────────────────────────┤
│ 6. EXEKVERINGS- Paper Trading │ Futures Paper (MNQ/MES) │    │
│    YTOR (paper) Mini Future-sidan (research/paper)           │
├─────────────────────────────────────────────────────────────┤
│ 7. FRAMTID      Riktig Mini Future-handel — LÅST, kräver     │
│                 separat explicit mänskligt godkännande       │
└─────────────────────────────────────────────────────────────┘
```

## Strategins livscykel

1. **Födelse**: strategi definieras i Trading OS strategikatalog (`daytradingStrategyCatalogService.js`) med `strategyId`, `strategyName`, version. Single source of truth: `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`.
2. **Analys**: agenterna läser performance/regime-data och föreslår varianter (nya exits, SL/TP, filter, risk/reward).
3. **Batch-test**: varianten körs i batch mot lokal historik (`strategyBatchTestService`), resultat till `data/` + `/api/strategy-batches`.
4. **Replay-validering**: samma variant spelas mot historiska scenarier (volatilitet, trend, range, nyheter) via replay-motorn; jämförelse gammal vs ny.
5. **Scoring**: Learning & Scoring uppdaterar win rate, profit factor, drawdown, strategy health (`strategyScoreService`, `researchScoreService`).
6. **Godkännande**: paper-allowlist (`paperAllowlistService`, manual approval) släpper strategin till Paper Trading.
7. **Futures-validering**: `futuresTradingOsSignalAdapterService` översätter godkända signaler till MNQ/MES i Futures Paper. Futures Paper skapar ingen egen logik.
8. **Mini Future-prep**: Mini Future Agent mappar strategin till produkt (hävstång, knock-out, spread) — endast research/paper.
9. **Riktig handel**: framtida steg, låst bakom separat explicit mänskligt godkännande.

## Dataflöden (ID-disciplin)

Alla signaler/trades bär `strategyId` + `strategyName` + version + `signalSource`. Test/curl/manual märks (`engine_test`, `simulated_fallback`) och exkluderas ur score. Replay-resultat märks `replay_mode: true` och blandas aldrig med live-paper-resultat (`executionSafetyService` blockerar dessutom replay-exekvering).

## Anti-mönster

- Ny strategi som bara finns i Futures Paper/Mini Future-koden → förbjudet.
- Signal utan strategyId → får inte ge paper-entry (jfr `can_create_paper_trade`-gaten, commit 894af2e).
- Okänd signal som fallbackar till en känd strategi → fixat i ef5afd1; återinför aldrig fallback.

## Relaterade dokument

`TRADING_OS_SAFETY.md`, `BATCH_REPLAY_SYSTEM.md`, `AI_AGENTS.md`, `PINESCRIPT_WORKFLOW.md`, `MINI_FUTURE_RESEARCH.md`, `FUTURES_PAPER_PLATFORM.md`, `LEARNING_PIPELINE.md`, `SYSTEM_ARCHITECTURE.md`.
