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
