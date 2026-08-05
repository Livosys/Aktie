# Project Map

Denna karta sammanfattar verifierad projektstruktur från Fas 0 och senare Second Brain-uppdateringar. Den ersätter inte kod, runtime, broker, ledger eller jämförelserapporter som source of truth.

## Nuvarande produktion

Aktuell produktion använder fortfarande befintlig produktionslogik för readiness- och executionbeslut.

```text
TradingOS / Native producers
-> befintlig produktionslogik
-> Entry Contract
-> Guard / Risk
-> IBKR Paper
```

Viktigt:

- produktionen använder inte Canonical Engine som routingkälla
- scheduler har inte migrerats
- IBKR Paper-kedjan har inte migrerats
- riskregler får inte ändras under evidensperioden
- live trading får inte antas vara aktivt

## Nuvarande shadow harness

Aktuellt huvudmål är Canonical Shadow Harness.

```text
TradingOS / Native producers
-> Canonical adapters
-> Canonical Signal
-> Canonical Execution Readiness Engine
-> jämförelserapport
```

Shadow harness ska inte:

- skicka order
- ändra routing
- påverka produktionsbeslut
- ändra risk
- ändra positioner

Syftet är att under 2-3 hela RTH-dagar visa att Canonical Execution Readiness Engine ger exakt samma beslut och reasonCodes som befintlig produktionslogik för samma kandidater.

Dagliga kriterier:

- antal kandidater
- antal identiska beslut
- identitetsprocent
- beslutsskillnader
- reasonCode-skillnader
- första avvikande kandidat
- nya eller okända reasonCodes

Målet är 0 beslutsskillnader och 0 reasonCode-skillnader över 2-3 oberoende hela RTH-dagar.

## Framtida målarkitektur

Den långsiktiga riktningen är:

```text
TradingOS
Native Futures
Pine
Batch
Replay
-> Canonical Signal
-> Execution Readiness Engine
-> Entry Contract
-> Guard / Risk
-> executionmiljö
```

Migreringsordningen är ännu inte ett aktivt implementationsuppdrag. Routing, scheduler, IBKR execution, Batch, Replay, PineScript, Dashboard och AI får migreras först efter verifierad shadow-evidens och separata godkända uppdrag.

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
- market context som används av både befintlig logik och Canonical adapters

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

Under Canonical Shadow Harness är den primära frågan inte om alla strategier kan exekvera, utan om Canonical Engine och befintlig produktionslogik ger identiska beslut och reasonCodes för samma kandidater.

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

IBKR Paper execution, account summary, fills, positions och reconciliation är viktiga operativa systemområden. De är inte huvudmåttet för Canonical Shadow Harness så länge Canonical Engine endast kör shadowjämförelse.

## Research

Research- och labbytor:

- Batch Lab
- Replay Lab
- PineScript
- TradingView
- analytics

PineScript- och TradingView-automation är senare arbete. Batch-/Replay-migration till Canonical Signal är också senare migration och inte aktuell huvudprioritet.

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

AI och Supervisor får analysera och rekommendera, men de får inte själva godkänna routingbyte, migration, riskändring, live trading eller executionändring.

## Frontend

Futures Paper Desk är kontrollrum för Mini Futures- och IBKR Paper-status.

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

Frontend ska ses som kontrollrum, inte execution source of truth. Backend, broker och ledger är auktoritativa för orders, fills och positioner. Canonical Shadow Harness-resultat ska verifieras mot jämförelserapporter och relevanta backendartefakter.

## Supervisor

Supervisor sammanfattar:

- safety
- runtime
- resultat
- blockerare
- nästa rekommendation

Supervisor får inte behandlas som ett självständigt godkännande att ändra risk, gates, brokerläge, kod, routing eller tradingstatus.
