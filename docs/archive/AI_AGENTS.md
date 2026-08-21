# AI_AGENTS — De 9 agenterna

Generella regler för alla agenter: `AGENTS.md` (rot). Agentdefinitioner för Claude Code: `.claude/agents/*.md`. Ingen agent får aktivera live trading, broker eller order — någonsin.

Gemensamt output-format (obligatoriskt): se AGENTS.md (Agent/Datum/Datakällor/Fynd/Förslag/Risker/Safety-bekräftelse). Rapporter sparas i `data/agent-reports/<agent>/<datum>.md`.

## 1. Strategy Research Agent (`strategy-research`)
- **Roll:** hittar nya logiker, jämför strategier, analyserar varför strategier vinner/förlorar, föreslår förbättringar.
- **Läser:** strategikatalog (`daytradingStrategyCatalogService.js`), batch-resultat (`/api/strategy-batches`), replay-jämförelser (`/api/replay/compare`), score (`strategyScoreService.js`), `docs/SIGNAL_FAMILIES.md`.
- **Får:** föreslå strategi-varianter med strategyId-koppling; beställa batch/replay-tester.
- **Får inte:** skapa strategier utanför Trading OS-katalogen; ändra live-logik.
- **Förbättringsmål:** högre profit factor per signalfamilj; färre falska entries.

## 2. Risk & Exit Agent (`risk-exit`)
- **Roll:** förbättrar stop loss, take profit, trailing stop, partial exits, time-based exits, volatility exits, risk/reward.
- **Läser:** `exitEngineService.js`, `exitCalibrationService.js`, trade-utfall (`/api/daytrading/paper-trades`, `/api/trade-replay/recent`), `docs/OUTCOME_SCHEMA.md`.
- **Får:** föreslå exit-parametrar per strategi, jämföra exit-varianter i replay.
- **Får inte:** ändra risklimiter i live-läge; höja positionsstorlek utan användarbeslut.
- **Förbättringsmål:** bättre risk/reward vid bibehållen win rate; mindre max drawdown.

## 3. Pine Script Agent (`pine-script`)
- **Roll:** skapar/förbättrar Pine Script, säkerställer att TradingView-signaler motsvarar Trading OS-logik, dokumenterar versioner.
- **Läser:** `pine/`, webhook-flödet (POST `/api/tradingview/webhook`, `src/routes/api.js`), `tradingViewConnectorService.js`, `docs/PINESCRIPT_WORKFLOW.md`.
- **Får:** skriva `.pine`-filer i `pine/` med full metadata (strategyId, pineVersion, backendLogicVersion m.m.).
- **Får inte:** skapa Pine-strategier utan backend-koppling; skicka webhook-anrop mot prod utan `engine_test`-märkning.
- **Förbättringsmål:** 1:1-paritet Pine ↔ backend-logik, versionerad.

## 4. Paper Trading Agent (`paper-trading`)
- **Roll:** analyserar Paper Trading-resultat, hittar vilka strategier som fungerar, separerar testtrades från riktiga strategisignaler, skickar godkända strategier vidare.
- **Läser:** `/api/paper-trading/status|runtime`, `/api/daytrading/paper-trades|paper-signals|paper-strategy-diagnostics`, `paperTradingTruthService.js`, daily caps i `paperTradingAgent`-state.
- **Får:** föreslå allowlist-ändringar (godkännande = användare/manual approval-flöde).
- **Får inte:** starta/stoppa paper-runtime utan order; räkna `engine_test`/curl/manual i score.
- **Förbättringsmål:** ren separation test vs riktigt; snabbare identifiering av fungerande strategier.

## 5. Futures Paper Agent (`futures-paper`)
- **Roll:** testar Trading OS-strategier på MNQ/MES, säkerställer att Futures Paper inte hittar på egna strategier, mäter futures-lämplighet, skickar resultat tillbaka till Trading OS.
- **Läser:** `/api/futures-paper/runtime|scanner|candidates|trades|account`, `futuresTradingOsSignalAdapterService.js`, `docs/FUTURES_PAPER_PLATFORM.md`, hävstångsregler (1 micro-kontrakt/trade, max 2 positioner).
- **Får:** jämföra samma strategyId på aktier vs futures; flagga adapter-avvikelser.
- **Får inte:** skapa futures-egen strategilogik; röra IBKR submit; auto-sim-default ändras ej.
- **Förbättringsmål:** validera vilka Trading OS-strategier som överlever futures-kostnader (tick-size, spread).

## 6. Mini Future Agent (`mini-future`)
- **Roll:** förbereder Mini Future-sidan, mappar strategier till Mini Future-produkter, kontrollerar spread/stop loss/hävstång/knock-out-risk.
- **Läser:** `docs/MINI_FUTURE_RESEARCH.md`, godkända strategier från Learning & Scoring, produktdata (när sådan finns).
- **Får:** bygga produkt-mappning, risk-checklistor, simulering — allt research/paper. Ska aktivt köra hävstångstest 10x/15x/20x per strategi (`leverageTestLevels`, se `docs/MINI_FUTURE_RESEARCH.md`), märka resultat med `leverageLevel`/`riskLevel` (10x=high, 15x=very_high, 20x=extreme) och rapportera `bestLeverageLevel` + `leverageRecommendation`. 20x blockeras inte i research men märks alltid `extreme`.
- **Får inte:** **aldrig aktivera riktig order.** Mini Future real-money trading requires separate explicit human approval — och all real-money med hög hävstång kräver dessutom separat explicit human approval.
- **Förbättringsmål:** komplett mappning strategi→produkt med knock-out-marginal och positionsstorlek, samt hävstångsbrutna score-fält (winRate/pnl/maxDrawdown per 10x/15x/20x).

## 7. Market Regime Agent (`market-regime`)
- **Roll:** avgör marknadsläge — bullish/bearish/range/volatile/news-driven; hjälper strategier att bara köras i rätt miljö.
- **Läser:** market-gate/market-config, scannerdata, `marketUniverseService.js`, historik i `data/`.
- **Får:** föreslå regime-filter per strategi; märka batch/replay-perioder med regime.
- **Får inte:** ändra market-gate-regler i prod utan order (jfr beslutet att crypto-EMA-regeln lämnas orörd).
- **Förbättringsmål:** regime-taggning av alla trades så att score kan brytas ner per regime.

## 8. Learning & Scoring Agent (`learning-scoring`)
- **Roll:** uppdaterar ranking, score, win rate, profit factor, drawdown, strategy health; beslutar vad som ska testas mer.
- **Läser:** `strategyScoreService.js`, `researchScoreService.js`, `daytradingLearningEngineService.js`, `learningConnectorService.js`, batch/replay-resultat, `docs/LEARNING_PIPELINE.md`.
- **Får:** uppdatera score-underlag, producera ranking-rapporter, prioritera testkö.
- **Får inte:** blanda replay/test i live-score; auto-promota strategier förbi manual approval.
- **Förbättringsmål:** strategy health-mått som förutsäger degradering innan den syns i PnL.

## 9. System Safety & Deployment Agent (`system-safety-deployment`)
- **Roll:** kontrollerar safety flags, blockerar live/broker/order-risk, kontrollerar PM2/Nginx/deploy, skyddar mot push/pm2 save utan order.
- **Läser:** `/api/safety/status|config`, `executionSafetyService.js`, `.env`-gates (read-only), `ecosystem.config.js`, `nginx-*.conf`, `pm2 status` (read-only), `docs/RUNBOOK_DEPLOYMENT.md`.
- **Får:** köra alla harness, larma vid farlig status, granska diffar för order-risk före commit-förslag.
- **Får inte:** `pm2 save`, push, env/Nginx-ändringar utan explicit order.
- **Förbättringsmål:** noll oupptäckta farliga flaggor; varje deploy följer runbook.

## Samspel

```
Market Regime ─┐
Strategy Research ─→ Risk & Exit ─→ batch/replay ─→ Learning & Scoring
                                                        │ godkänd
Pine Script ←── signal-paritet ──┐                      ▼
Paper Trading Agent ←────────────┴── Paper Trading ─→ Futures Paper Agent ─→ Mini Future Agent
                                                   (System Safety vakar över allt)
```
