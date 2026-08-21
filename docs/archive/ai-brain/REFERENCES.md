# References

Detta är Second Brain-indexet över dokument och verifieringskällor. Läs referenserna i sitt sammanhang och verifiera gamla uppgifter mot kod och runtime.

## Primära auktoritativa källor

- `docs/TRADING_OS_SAFETY.md`
- `docs/TRADING_OS_WORK_RULES.md`
- `docs/SAFETY_RULES.md`
- `docs/DECISIONS.md`
- `docs/FUTURES_PAPER_RUNTIME.md`
- `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`
- `docs/RUNBOOK_DEPLOYMENT.md`
- `AGENTS.md`
- `CLAUDE.md`

## Aktiva systemspecifikationer

- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md`
- `docs/BATCH_REPLAY_SYSTEM.md`
- `docs/LEARNING_PIPELINE.md`
- `docs/PINESCRIPT_WORKFLOW.md`

TradingView/PineScript-arbetet är inte aktuell huvudprioritet. Mini Futures harness-testet är högsta prioritet tills testperioden är avslutad eller användaren ändrar prioritet.

## Historiska eller delvis inaktuella dokument

- `docs/TRADING_OS_AI_CONTEXT.md`
- `docs/SUPERVISOR_UNIFICATION_PLAN.md`
- `docs/FUTURES_PAPER_PLATFORM.md`
- `docs/API_MAP.md`
- `README.md`

Dessa får läsas som historik men måste verifieras mot kod och runtime innan de används som aktuell projektkontext.

## Koddokumentation och verifieringskällor

Frontend:

- `client/src/App.jsx`
- `client/src/pages/FuturesPaperDeskPage.jsx`
- `client/src/pages/InteractiveBrokersPage.jsx`
- `client/src/pages/PinescriptPage.jsx`
- `client/src/pages/SupervisorV2Page.jsx`
- `client/src/components/Sidebar.jsx`
- `client/src/MobileBottomNav.jsx`
- `client/src/components/dashboard/DashboardKit.jsx`

Backend routes:

- `server.js`
- `src/routes/api.js`

Market data:

- `src/services/ibFuturesDataAdapterService.js`
- `src/services/futuresMarketDataService.js`
- `src/services/futuresPaperQuoteSourceService.js`
- `src/services/futuresMarketHoursService.js`
- `data/market-data/`

Strategy och candidates:

- `src/services/strategyRegistryService.js`
- `src/services/daytradingStrategyCatalogService.js`
- `src/services/futuresPaperStrategyApprovalService.js`
- `src/services/futuresPaperScannerService.js`
- `src/services/paperStrategyEntryContractService.js`
- `client/src/stores/strategyStore.js`

Execution och broker:

- `src/services/ibPaperExecutionConfigService.js`
- `src/services/ibPaperExecutionGuardService.js`
- `src/services/ibPaperExecutionIntentService.js`
- `src/services/ibPaperExecutionOrchestratorService.js`
- `src/services/ibPaperExecutionAdapterService.js`
- `src/services/ibPaperBrokerReconciliationService.js`
- `src/services/ibPaperAccountSummaryService.js`
- `src/services/futuresInternalSimulationRetirementService.js`

Learning och resultat:

- `data/learning-connector/`
- `docs/LEARNING_PIPELINE.md`
- `data/futures-paper/`
- `data/replay/`
- `data/strategy-batches/`
