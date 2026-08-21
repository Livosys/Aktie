# Futures Paper Platform

## Översikt

Futures Paper Platform är en separat, intern paper-simulation för futures i
Trading OS / Livosys.

Den är byggd för att simulera handel i:

- `MNQ` - Nasdaq 100 Micro E-mini Futures
- `MES` - S&P 500 Micro E-mini Futures

Plattformen använder befintliga strategier, scannerresultat och AI-underlag som
read-only signal- och kandidatkälla. Den skapar aldrig riktiga order.

## Safety

Detta är en ren paper-only-miljö.

Följande måste alltid vara false i både API-svar och intern state:

```text
mode=paper_only
actions_allowed=false
can_place_orders=false
live_trading_enabled=false
broker_enabled=false
```

Det finns inte:

- ingen broker
- ingen IB-submit
- ingen live trading
- ingen riktig order
- ingen auto buy/sell
- ingen execution
- ingen auto-apply av trading-flöden

## Faser

### FAS 1 - Runtime

FAS 1 byggde själva runtime-skalet för Futures Paper Desk.

Resultat:

- separat runtime för `MNQ` och `MES`
- Globex-session som read-only sessionram
- koppling till befintliga strategier som kandidatkälla
- paper-only safety i runtime-svaret

### FAS 2 - Simulerat konto

FAS 2 byggde ett falskt konto för futures-deskens paper-simulation.

Data ligger under:

- `data/futures-paper/account-config.json`
- `data/futures-paper/account-state.json`
- `data/futures-paper/events.jsonl`
- `data/futures-paper/equity-curve.jsonl`

Kontot stödjer:

- startkapital
- cash
- equity
- realized PnL
- unrealized PnL
- total PnL
- drawdown
- buying power
- margin-översikt
- FX USD/SEK

### FAS 3 - Ledger, positioner och trades

FAS 3 byggde intern ledger för simulerade futures-positioner.

Data ligger under:

- `data/futures-paper/positions.json`
- `data/futures-paper/trades.jsonl`

Ledgern stödjer:

- öppna simulerade positioner
- stängda simulerade trades
- PnL-beräkning
- konto- och equity-uppdatering
- event-loggning
- manuell öppna/stänga-simulering

### FAS 5 - Scanner, candidate queue och auto-simulation (paper-only)

FAS 5 kopplade in en intern paper-only scanner för MNQ/MES.

Resultat:

- `src/services/futuresPaperPriceFeedService.js` - simulerad fallback-prisfeed
  (random walk runt rimliga MNQ/MES-nivåer, alltid märkt `simulated_fallback`)
- `src/services/futuresPaperScannerService.js` - scanner, candidate queue och
  auto-simulation med hård paper-only-gate (`assertPaperOnly`)
- mark-to-market i ledgern (`markOpenPositionsToMarket`) och automatisk
  stängning på stop loss / take profit
- kandidater använder befintlig strategy performance; utan performance skapas
  en dummy-kandidat märkt `testOnly: true`
- auto-simulation är default AV, styrs via API/UI och kör bara intern
  simulation (scanner -> kandidat -> paper position -> mark-to-market)

Data ligger under:

- `data/futures-paper/scanner-state.json`
- `data/futures-paper/candidates.json`
- `data/futures-paper/price-feed-state.json`

### FAS 6 - Automation Engine (paper-only)

FAS 6 gjorde scannern strategidriven med samma godkännandekedja som interna
Paper Trading.

Regler:

- strategikälla: `paperAllowlistService` (automationApprovalService) +
  `strategyPerformanceReadService`; strategier utan data skippas med orsak
- max trades per strategi: `FUTURES_PAPER_MAX_TRADES_PER_STRATEGY` (default 10),
  block reason `max_strategy_trades_reached`
- cooldown per strategi: `FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES` (default 60),
  block reason `strategy_cooldown_active` med `lastTradeAt`/`nextAllowedAt`/
  `cooldownMinutesRemaining`
- scan history: `FUTURES_PAPER_SCAN_HISTORY_LIMIT` (default 10) i
  `data/futures-paper/scan-history.json`
- closed trades-vy: `FUTURES_PAPER_CLOSED_TRADES_LIMIT` (default 100), nyast först
- auto-intervall: `FUTURES_PAPER_AUTO_INTERVAL_SECONDS` (default 60)

Nya endpoints:

- `GET /api/futures-paper/strategy-status`
- `GET /api/futures-paper/scan-history`
- `GET /api/futures-paper/closed-trades`

### FAS 4A - Trading Chart

FAS 4A byggde den första chart-sektionen på `/futures-paper`.

Resultat:

- `client/src/components/FuturesPaperChart.jsx`
- chart-sektion i `client/src/pages/FuturesPaperDeskPage.jsx`
- `lightweight-charts`
- val mellan `MNQ` och `MES`
- preview-serie från FAS 3-data när trades finns
- empty-state när chartdata saknas
- markers för:
  - Entry
  - Exit
  - Stop Loss
  - Take Profit
  - Strategy
- sidopanel för öppna positioner och senaste stängda trades

Charten är read-only och kan inte skicka order.

## API-endpoints

Följande read-only eller paper-only endpoints används av Futures Paper Platform:

### Runtime och konto

- `GET /api/futures-paper/runtime`
- `GET /api/futures-paper/account`
- `POST /api/futures-paper/account/reset`
- `POST /api/futures-paper/account/set-balance`

### Ledger

- `GET /api/futures-paper/positions`
- `GET /api/futures-paper/trades`
- `POST /api/futures-paper/manual/open`
- `POST /api/futures-paper/manual/close`

### Scanner och simulation (FAS 5, paper-only)

- `GET /api/futures-paper/scanner`
- `POST /api/futures-paper/scanner/run-once`
- `GET /api/futures-paper/candidates`
- `POST /api/futures-paper/candidates/simulate`
- `POST /api/futures-paper/simulation/tick`
- `POST /api/futures-paper/auto-simulation`
- `GET /api/futures-paper/price-feed`

Alla POST-endpoints blockerar request-bodies som försöker sätta
`live_trading_enabled`, `broker_enabled`, `can_place_orders`,
`actions_allowed` eller `mode != paper_only`.

## Datafiler

Plattformen använder separata futures-paper-filer:

- `data/futures-paper/account-config.json`
- `data/futures-paper/account-state.json`
- `data/futures-paper/events.jsonl`
- `data/futures-paper/equity-curve.jsonl`
- `data/futures-paper/positions.json`
- `data/futures-paper/trades.jsonl`

## UI

Huvudytan finns på:

- `/futures-paper`

Den visar:

- kontoöversikt
- marknadsläge
- instrumentfokus
- strategiöversikt
- öppna positioner
- stängda trades
- Trading Chart
- manuell paper-simulation
- teknisk runtime-data

## Uttryckligt förbjudet

Futures Paper Platform får aldrig kopplas till:

- broker
- Interactive Brokers submit
- live trading
- riktiga order
- order execution
- TradingView-forwarding till execution

## Nästa planerade faser

Planerade nästa steg är:

1. FAS 5 - Strategy Candidates
2. FAS 6 - Performance
3. FAS 7 - AI Decision Journal

## Commit-set för senare

En ren futures-paper-commit bör normalt innehålla:

- `client/src/components/FuturesPaperChart.jsx`
- `client/src/pages/FuturesPaperDeskPage.jsx`
- `src/services/futuresPaperStorageService.js`
- `src/services/futuresPaperStorageService.test.js`
- `src/services/futuresPaperAccountService.js`
- `src/services/futuresPaperAccountService.test.js`
- `src/services/futuresPaperLedgerService.js`
- `src/services/futuresPaperLedgerService.test.js`
- `src/services/futuresPaperDeskService.js`
- `src/services/futuresPaperDeskService.test.js`
- relevant futures-only routing om och när den filen kan separeras rent

Det här dokumentet kan också ingå i samma commit om det är avsett för futures-
plattformen och inget annat spår blandas in.
