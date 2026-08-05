# Project Map

Denna karta sammanfattar verifierad projektstruktur från Fas 0 och Fas 2. Den ersätter inte kod, runtime, broker eller ledger som source of truth.

## Övergripande modell

```text
Market Data
-> Signal Producers
-> Candidates
-> Strategy Registry
-> Entry Contracts
-> Guard
-> Risk
-> Execution Intent
-> IBKR Paper Adapter
-> Orders
-> Fills
-> Broker Positions
-> Reconciliation
-> Exit
-> Results
-> Learning
-> Supervisor
```

## Market Data

Trading OS använder futures market data i Mini Futures- och Futures Paper-flödena.

Verifierade områden från Fas 0:

- IBKR futures market data finns i kod via `src/services/ibFuturesDataAdapterService.js`.
- Samlad futures market data exponeras via `src/services/futuresMarketDataService.js`.
- Quote source-lager finns i `src/services/futuresPaperQuoteSourceService.js`.
- Market hours hanteras i `src/services/futuresMarketHoursService.js`.
- Candles och bars finns under `data/market-data/`.
- MNQ och MES är verifierade som micro-futures i scanner- och executionflödet.
- NQ och ES finns i projektets futures-kataloger/dokumentation, men exakt runtime-roll ska verifieras per uppdrag.

Kritiska datapunkter:

- symbol- och contractmapping
- freshness
- market hours/session
- realtidskälla kontra fallback
- delayed/simulated-markering

## Strategy Layer

Strategilagret består av:

- Strategy Registry: `src/services/strategyRegistryService.js`
- Strategy Store: `client/src/stores/strategyStore.js`
- daytrading-katalog: `src/services/daytradingStrategyCatalogService.js`
- Futures Paper strategy approval: `src/services/futuresPaperStrategyApprovalService.js`
- Entry Contracts: `src/services/paperStrategyEntryContractService.js`
- Futures Paper scanner/candidates: `src/services/futuresPaperScannerService.js`

Observerad målbild/observation:

- Strategy Dashboard visar cirka 32-34 strategier.
- Exakt antal måste verifieras mot registren innan det behandlas som teknisk sanning.
- Alla registrerade eller approved strategier är inte nödvändigtvis körbara.

Readiness bör klassificeras per strategi:

- producer evidence
- market context
- signal
- candidate
- Entry Contract
- Guard
- Risk
- paper execution readiness
- performance evidence

## Harness-test

Det tre dagar långa Mini Futures harness-testet är aktuellt huvudmål.

Syftet är att verifiera Trading OS egna strategier genom hela IBKR Paper-kedjan:

```text
marknadsdata
-> strategi
-> signal
-> kandidat
-> Entry Contract
-> Guard
-> Risk
-> execution intent
-> IBKR Paper-order
-> fill
-> brokerposition
-> reconciliation
-> exit
-> resultat
-> learning
```

Kriterier:

- färsk marknadsdata når strategierna
- egna strategier producerar giltiga signaler och kandidater
- stoppade kandidater får tydliga `blockedReason`
- giltiga kandidater passerar Entry Contract, Guard och Risk
- säkra paper-order når IBKR Paper när alla krav är uppfyllda
- fills, brokerpositioner, exits, PnL och reconciliation registreras korrekt
- reconnect och restart skapar inte dubbla intents eller orders

## Execution

Executionmiljö:

- Futures Paper använder IBKR Paper som brokerkopplad paper execution.
- Intern futures-simulator är pensionerad och ska inte visas som aktiv executionmotor.
- Live broker och live trading får inte antas vara aktiva.

Kritiska komponenter:

- orchestrator: `src/services/ibPaperExecutionOrchestratorService.js`
- intent: `src/services/ibPaperExecutionIntentService.js`
- guard: `src/services/ibPaperExecutionGuardService.js`
- config/kill switch: `src/services/ibPaperExecutionConfigService.js`
- adapter: `src/services/ibPaperExecutionAdapterService.js`
- reconciliation: `src/services/ibPaperBrokerReconciliationService.js`
- account summary: `src/services/ibPaperAccountSummaryService.js`
- routes: `src/routes/api.js`

Executionkedjan måste bevisa:

- execution intent
- broker order-ID
- IBKR Paper-order
- fill
- brokerposition
- reconciliation
- exit
- PnL

## Research

Research- och labbytor:

- Batch Lab
- Replay Lab
- PineScript
- TradingView
- analytics

PineScript- och TradingView-automation är senare arbete. De är inte aktuell huvudprioritet och får inte störa Mini Futures harness-testet.

## AI och Learning

Learning finns i data- och serviceflöden, bland annat `data/learning-connector/` och learning-dokumentation.

Målbilden innehåller cirka 8-9 specialiserade AI-roller:

- strategy analyst
- risk analyst
- market regime analyst
- PineScript analyst
- batch analyst
- replay analyst
- execution analyst
- learning/optimizer
- Supervisor AI

Antal och exakta namn är EJ VERIFIERAT tills AI-konfiguration och kod inventerats.

## Frontend

Futures Paper Desk är kontrollrummet för harness-testet.

Flikar/ytor:

- Översikt
- Strategy Dashboard
- Analytics
- IBKR Paper-konto
- Brokerpositioner
- Ordrar
- Fills & trades
- Runtime
- IBKR Paper Execution
- Godkännande
- Teknisk info

Frontend ska ses som kontrollrum, inte execution source of truth. Backend, broker och ledger är auktoritativa för orders, fills och positioner.

## Supervisor

Supervisor sammanfattar:

- safety
- runtime
- resultat
- blockerare
- nästa rekommendation

Supervisor får inte behandlas som ett självständigt godkännande att ändra risk, gates, brokerläge, kod eller tradingstatus.
