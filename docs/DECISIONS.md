# DECISIONS — Beslutslogg

Format: datum, beslut, motiv, konsekvens. Nya beslut läggs överst. Claude ska logga användarens arkitektur-/policybeslut här (inte varje kodfix — git-historiken täcker det).

---

## 2026-07-15 — IB som gemensam futures-datakälla LIVE (FAS 2 av FUTURES_DATA_LAYER.md)
- **Beslut:** Read-only IB-datalager aktiverat i prod (`IB_FUTURES_DATA_ENABLED=true`, clientId 955): `ibFuturesDataAdapterService` (enda modulen som pratar @stoqey/ib för data; contract resolution front-month dynamiskt, streaming quotes, historical 1m med pacing/backoff, read-only account summary — inga order-API:er) → `futuresMarketDataService` (1m-candles + aggregering 2m/5m via candleAggregator, persist till marketDataStore source 'ib' + manifest) → `futuresPaperQuoteSourceService` (composite: IB färsk → IB; stale under öppen marknad → ärlig simulated_fallback; stale under stängd marknad → sista riktiga pris märkt stale). Scannern bytte default-feed till composite. IB paper-kontosaldo (NetLiquidation, DU-konto, maskerat id, SEK) visas som huvudsaldo i Futures Paper; internt simulerat konto hålls separat och dubbelräknas aldrig. `REPLAY_FUTURES_SCOPE_ENABLED=true` — Replay/Batch läser samma MNQ/MES-candles ur storen. `/futures-paper/runtime` fick TTL-cache (60s, stale-while-revalidate + warmup) som fix för 7000ms-timeouten (~9s tung synkron byggnad).
- **Motiv:** En enda futures-datasanning (IB) för desk, 33 strategier, Replay, Batch och Pine; simulerad data får aldrig se ut som riktig IB-data; livekonto får aldrig väljas (endast DU/DF-konton, annars blocker).
- **Konsekvens:** MNQ/MES/NQ/ES realtime-quotes + 1m/2m/5m-candles live; paper-handeln markpricear mot riktiga priser; 24 strategier förblir ärligt PRODUCER_NOT_IMPLEMENTED tills riktiga producers byggs mot IB-candles (separat fas). Rollback: ta bort IB_FUTURES-flaggorna ur .env + restart.

## 2026-07-11 — Pine Research: generell ORB-paritetsadapter + data-readiness-gate
- **Beslut:** Pine Research Factory fick en generell ORB-paritetsadapter (`pineResearchOrbAdapterService`) som ersätter den permanenta parity-stubben. Adaptern är parameterdriven för hela `opening_range_breakout`-familjen (alla 9 versioner: riktning, 15/30m range, breakout/retest, range/fixed stop, RR-target, EMA/volymfilter, entry-fönster, forced close) och speglar Pine v6-fillmodellen (signal på close, fill nästa bar-open, slippage i ticks på market/stop, commission cash/kontrakt/side, TradingView-fillemulatorns intrabar-antagande). Paritet certifieras per regel (exact/equivalent/partial/unsupported/unknown); `certified` kräver alla obligatoriska regler exact/equivalent. Körning gate:as dessutom av separat data-readiness (`dataStatus=ready` kräver riktiga bars i `data/market-data/candles-<tf>/<SYMBOL>`; simulated_fallback räknas aldrig som data). Endast motorn `internal_preview` är certifierad; batch/replay förblir ocertifierade för ORB.
- **Motiv:** TestRuns får aldrig fejkas ("failed: internal_runner_not_connected" ersatt med ärlig exekvering eller ärlig blockering). MNQ/MES saknar helt historikdata i systemet (ingen Databento-nyckel; Alpaca saknar futures) — därför blockeras pilotens TestRun ärligt på `no_mnq_5m_bars_in_shared_candle_store` trots certified paritet, i stället för att köra på simulerad data.
- **Konsekvens:** Baseline-preview (MNQ 5m) = parity certified / data missing / wouldRun=false. Inget TestRun och ingen GPT-5.5-evaluation körs förrän riktig MNQ-historik importerats (t.ex. Databento). UI `/pinescript` visar nu paritetsmatris, dataStatus, blockeringsorsak och baseline-vs-nästa-jämförelse.

## 2026-07-10 — Futures Paper: NQ/ES-kontrakt + avgiftsmodell per köp/sälj
- **Beslut:** Futures Paper stödjer nu fyra kontrakt (MNQ/MES/NQ/ES) via en central katalog `futuresContractCatalogService` (enda källan för `pointValueUsd`, `tickSize`, `tickValueUsd`, `defaultCommissionPerSideUsd`). Simulerad courtage dras per side: entry-fee vid open, exit-fee vid close. `netPnlUsd = grossPnlUsd − totalFees`; realized PnL = net (styr kontot); gross och fees sparas separat per trade och `totalFeesSek` på account. Commission/side: MNQ/MES $1.22, NQ/ES $2.25. **Scope-beslut (användarval):** auto-scanner + signaladapter förblir **micros-only** (`SCANNER_SYMBOLS=['MNQ','MES']`); NQ/ES är endast katalog/manuell paper-simulation/UI — den beslutade riskramen (micros only för automatiken) är orörd.
- **Motiv:** Mer realistisk paper-PnL (courtage påverkar resultatet) och möjlighet att jämföra micro vs. e-mini-kontrakt, utan att öka auto-tradad notional.
- **Konsekvens:** Commit `89b6f44` på `lab-batch-runnability-ui` (9 filer, endast `futuresPaper*`/katalog/UI; regular `/paper-trading` orörd). Tester: nytt `futuresPaperFees.test.js` + uppdaterade ledger/desk-tester (net-siffror). Safety-flaggor oförändrade (paper_only, alla false); inga order-/broker-/IBKR-vägar öppnade. `pm2 restart nasdaq-scanner` kört (ny kod live, NQ/ES syns i runtime); ingen `pm2 save`, ingen push.

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
