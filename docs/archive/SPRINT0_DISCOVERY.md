# SPRINT0_DISCOVERY — Trading OS (nasdaq-scanner-prod)

> **Sprint 0 – Discovery (Read-only).** Kartläggning av hela systemet innan ny
> utveckling. Ingen kod ändrad, inga commits, ingen refaktorering. Denna fil är
> en ny rapport (additiv) och ändrar ingen körväg.

**Datum:** 2026-07-18
**Aktiv prod:** `/var/www/nasdaq-scanner-prod`, branch `lab-batch-runnability-ui` @ `6baf057`
**Runtime:** PM2 `nasdaq-scanner` (fork, `server.js`, `127.0.0.1:3001`), 0 restarts, 10h uptime vid kartläggning.

---

## 1. Vad systemet är

**Trading OS** — en forsknings- och tradingplattform (Node/Express-backend + React/Vite-dashboard)
som forskar fram, testar och förbättrar day-trading-strategier baserade på Oliver Velez
2-minuters "narrow state"-logik. Kärnprincipen genomsyrar hela repot:

> **Trading OS är hjärnan.** Alla strategier föds, testas och godkänns i strategikatalogen.
> Paper Trading, Futures Paper och Mini Future är *konsumenter* av strategierna — aldrig egna
> strategikällor. **Ingen live trading finns eller får aktiveras.**

- **Backend:** `server.js` → Express på `127.0.0.1:3001`, hela API:t (`/api/*`, 5 958 rader i
  `src/routes/api.js`) bakom auth (Basic + cookie-session via `tradingOsAuthService`). Extern
  access endast via Nginx.
- **Frontend:** `client/` (Vite, 22 sidor). Byggd `dist/` serveras statiskt → **build = direkt
  prod-deploy**.
- **State:** Redis (best-effort, in-memory fallback) + JSONL/JSON-filer under `data/`. Ingen
  central DB i drift (`pg` finns men `src/db/` = endast migrations).
- **Data:** Alpaca (aktier/Nasdaq 2m), Binance (krypto), IB Gateway (futures MNQ/MES paper),
  Databento (inert backfill).

**Skala:** 159 icke-test service-filer + 111 co-lokaliserade testfiler i `src/services/` (god
testtäckning), ~50 scanner-engines, 22 frontend-sidor, 9 AI-agenter, ~40 dokument i `docs/`.

---

## 2. Kanoniskt flöde (pipelines)

```
DATA (Alpaca/Binance/IB/Databento, data/-store, Redis)
  │
  ▼
LIVE-SCANNER  scheduler.js + cryptoScheduler.js (var 30s)
  → ~50 engines i fast ordning (docs/ENGINE_ORDER.md):
    narrow state → indikatorer → triggers/TFS/elephant → market regime (v3/v2/personality)
    → score/confidence/MTF → learning/memory (edge, DNA, rule-memory, kalibrering)
    → momentum/risk/fakeout/liquidity
  │
  ▼
TRADING OS-KÄRNA  daytradingStrategyCatalogService (single source of truth, strategyId)
  → signalfamiljer, entry-quality-gate, exitEngine, riskEngine, executionSafety
  │
  ├─► FORSKNINGSLOOP (4×/dag målbild, idag intervall/dry-run)
  │     Batch (strategyBatchTestService) → Replay (replayEngine, historiska scenarier)
  │     → Learning & Scoring (strategyScore/researchScore) → förbättrade exits/SL/TP/filter
  │     → förslag tillbaka in i katalogen. Skickar ALDRIG order. Allt märkt replay/backtest.
  │
  ├─► 9 AI-AGENTER analyserar lager ovan, föreslår varianter (aldrig frikopplade strategier)
  │
  ▼
SIGNAL-UT  Pine Script / TradingView-webhook · futuresTradingOsSignalAdapterService
           (enda futures-strategikällan)
  │
  ▼
EXEKVERINGSYTOR (endast paper)
  Paper Trading ──► allowlist/manual approval ──► Futures Paper (MNQ/MES) ──► Mini Future
  │                                                                          (research/paper)
  ▼
FRAMTID: riktig handel — LÅST bakom separat explicit mänskligt godkännande
```

**ID-disciplin (arkitekturens ryggrad):** varje signal/trade bär `strategyId` + `strategyName`
+ version + `signalSource`. Test/curl/replay märks `engine_test` / `simulated_fallback` /
`replay_mode` och exkluderas ur score. Anti-mönstret "okänd signal fallbackar till känd strategi"
är patchat (`ef5afd1`, `894af2e`) och får inte återinföras.

---

## 3. Core / Research / Legacy-klassificering

### 🟢 CORE (live-kritiskt, får ej röras blint)

| Domän | Nyckelfiler |
|---|---|
| Server/API/Auth | `server.js`, `src/routes/api.js`, `tradingOsAuthService.js` |
| **Safety-kärna** | `executionSafetyService.js` (hårdkodad avvisning av `mode=live`/`live_trading_enabled`), `redisService.js` |
| Live-scanner | `src/scanner/scheduler.js`, `cryptoScheduler.js`, engine-kedjan (`narrowState`, `engineV3`, `indicators`, `signalFamilyClassifier`, `scoreBreakdown`, `confidenceEngine`, `mtf` …) |
| Data | `src/data/{alpaca,binance}DataService`, `candleAggregator`, `marketDataStore`; `scanner/{alpaca,binance}Client` |
| Strategikatalog | `daytradingStrategyCatalogService.js`, `strategyRegistryService.js` (single source of truth) |
| Paper Trading | `paperTradingRuntimeService/Agent/Status/Truth`, `paperAllowlistService`, `riskEngineService` |
| Futures Paper | `futuresPaper*` (~25 filer), `futuresTradingOsSignalAdapterService`, `ibFuturesDataAdapterService`, `futuresMarketDataService` (**IB-datalagret är LIVE i prod**) |
| Hälsa/larm | `systemHealth.js`, `src/alerts/alertEngine.js` |

### 🟡 RESEARCH (forskning/gated, ej live-kritiskt)

- **Batch/Replay:** `strategyBatchTestService`, `batchAutopilotService` (**gated OFF, dry-run-only**),
  `replayEngine`, `replayAutopilotService`, `replayIntelligenceService`, `milderExitReplayService`
- **Learning:** `learningEngine`, `learningOrchestrator`, `signalLearning`, `historicalEdge`,
  `adaptiveEdgeEngine`, `setupDnaEngine`, `ruleMemoryEngine`, `fakeoutDnaEngine`,
  `scoreCalibrationEngine`, `narrowPerformanceLearningService`
- **Scoring/evolution:** `strategyScoreService`, `researchScoreService`, `strategyEvolutionService`,
  `strategyResearchManagerService`, `strategyLabService`
- **Pine-forskning:** `pineResearch*` (~10 filer), `pineScriptGeneratorService`,
  `pineScriptValidationService`
- **AI-agenter:** 9 st i `.claude/agents/` + `agentReasoningService`, `aiAnalystService`,
  `agentDebateEngineService`, `systemIntelligenceAgentService`
- **Mini Future:** endast `docs/MINI_FUTURE_RESEARCH.md` — **ingen orderväg byggd** (avsiktligt)
- **Inert/förberedelse:** `databento*` (backfill, flagga default OFF),
  `entryFilterForwardValidationService`

### 🔴 LEGACY / konsolideringsskuld

- **IBKR-exekveringsstacken (störst):** ~40 filer i två samexisterande generationer —
  - Gammal: `interactiveBrokersPaper*` (~20 filer: preview/blueprint/bracket), `ibPaper*` legacy
    submit → **hard-blocked** (`legacy_ibkr_submit_disabled`)
  - Ny: `ibPaperExecution*` + `IBKR_*`-flaggor (shadow/readiness, submit avstängt)
  - `futuresInternalSimulationRetirementService` + `internal_simulation`-ledgern = **retired**
- **Repo-topologi:** **17 git-worktrees + 62 branches** under `/var/www/` (deploy-*, entry-quality-*,
  paper-*, ib-paper-futures-*, en mängd `*-before-*`/`*-backup*`-snapshots). GitHub origin avstängt
  (arbete direkt i deploy-worktrees). `main` ↔ `futures-base` divergerar ~164 filer → **ingen ren
  huvudlinje**.
- **Duplicerade docs:** `TRADINGVIEW_PAPER_REPLAY_CONTRACT.md` vs `tradingview-paper-replay-contract.md`.
- **Oanvänt:** `FuturesPaperChart.jsx` (borttagen ur UI men kvar i kod).

---

## 4. Nuvarande säkerhetsläge (verifierat read-only)

✅ **Safety intakt:** `.env` har **inga** live/broker/submit-gates aktiva — endast legacy
`IB_PAPER_EXECUTION_ENABLED=true` (öppnar per design *inte* futures-submit) och
`IB_PAPER_SUBMIT_ROUTES_ENABLED=false`. Nya `IBKR_*`-flaggorna saknas i `.env` → kodens default
(false/shadow). `executionSafetyService` avvisar fortfarande `mode=live`. Kill switch inaktiv.
Paper-pilotens `.env.armed_snapshot_20260718T050213Z` finns men är **inte** aktiv (pilot avarmad).

⚠️ **Övervakningslucka:** `scripts/harness/safety_harness.sh` rapporterar tre falska FAIL
(`mode` / `live_trading_enabled` / `manual_armed`) eftersom dess curl saknar auth-creds och träffar
auth-väggen. Harnessen kan därför inte se den faktiska live-safety-statusen via API. `.env`-kontrollerna
och `executionSafetyService`-kontrollen i samma harness PASSar dock.

---

## 5. Risker & konsolideringsmål

| # | Risk | Målbild |
|---|---|---|
| R1 | **65 ocommittade filer** i prod-worktree (blandade sessioner) — drift/oåterkallelighet | Ren working tree; selektiva commits per domän |
| R2 | 17 worktrees / 62 branches, origin av, `main`↔`futures-base`-divergens | En kanonisk huvudlinje; arkivera frozna snapshots; återupprätta origin |
| R3 | Dubbel IBKR-stack (~40 filer, legacy hard-blocked + ny shadow) | Retire legacy-generationen bakom en tydlig submit-boundary; en väg |
| R4 | Config-namndrift (`.env IB_PAPER_*` vs kod `IBKR_PAPER_*`) hårdstänger submission | Enhetlig config-namnrymd + validering vid boot |
| R5 | `api.js` monolit (5 958 rader) | Modularisera per domän (safety/paper/futures/batch/replay) |
| R6 | Harness ser inte live-safety (auth-vägg) | Auth-undantagen intern safety-probe för harness |

---

## 6. Föreslagen målarkitektur (7 lager)

Repots egen `TRADING_OS_ARCHITECTURE.md` definierar redan en sund 7-lagersmodell som bör kodifieras
som mål. Sammanfattning med konsolidering ovanpå:

```
1. DATA         Alpaca/Binance/IB/Databento → normaliserad candle-store + Redis
2. TRADING OS   Strategikatalog (single source of truth) · scanner-engines · entry-quality
                · exit/risk · executionSafety (kärna)
3. FORSKNING    Batch + Replay (4×/dag) → Learning & Scoring → förslag in i katalogen
4. AGENTER      9 roller analyserar lager 2–3, föreslår varianter (aldrig frikopplade strategier)
5. SIGNAL-UT    Pine/TradingView-webhook · futures-signaladapter (enda futures-källan)
6. EXEKVERING   Paper Trading → Futures Paper → Mini Future  (ALLT paper, en submit-boundary)
7. FRAMTID      Riktig handel — LÅST bakom separat explicit mänskligt godkännande
```

**Konkreta konsolideringsdrag** (ingen implementeras i Sprint 0):

1. **Enhetlig strategi-ryggrad** — allt bär `strategyId`; katalogen är enda källan; bevara
   anti-fallback-gaten.
2. **En IBKR-väg** — retire legacy `interactiveBrokers*`/`ibPaper*`-submit, behåll
   `ibPaperExecution*` + `IBKR_*` bakom `executionSafetyService` som sista lager. Enhetlig
   config-namnrymd.
3. **Modularisera `api.js`** per domän-router.
4. **Repo-hygien** — en huvudlinje, arkivera `*-before-*`/`*-backup*`-worktrees, återupprätta origin.
5. **Safety-observability** — intern probe så harnessen ser faktisk live-safety.

---

## 7. Sammanfattning

Systemet är väldokumenterat och safety-first, med en tydlig och sund "hjärna → konsumenter"-arkitektur
som redan finns nedskriven. Kärnan (scanner, katalog, safety, paper-ytor) är solid och testtäckt. Den
huvudsakliga skulden är **konsolidering, inte design**: en dubbel IBKR-stack, kraftig worktree/branch-sprawl,
en monolitisk `api.js`, config-namndrift och en stor ocommittad working tree.

**Nästa steg (förslag, kräver explicit order):** prioritera R1 (ren working tree) och R2 (huvudlinje)
före all ny funktionsutveckling, eftersom de annars förstärker driften för varje sprint.

---

*Relaterade dokument:* `TRADING_OS_ARCHITECTURE.md`, `SYSTEM_ARCHITECTURE.md`, `BATCH_REPLAY_SYSTEM.md`,
`AI_AGENTS.md`, `TRADING_OS_SAFETY.md`, `IBKR_PAPER_EXECUTION.md`, `ENGINE_ORDER.md`,
`STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`.
