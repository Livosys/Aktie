# Decisions

Detta är ett kort Second Brain-index över bestående beslut. Det ersätter inte den fullständiga auktoritativa beslutshistoriken i `docs/DECISIONS.md`.

## Beslut 1 - IBKR Paper är Futures Papers executionmiljö

Status: VERIFIERAT

Beslut:
Futures Paper använder IBKR Paper som brokerkopplad paper execution.

Konsekvens:
Den pensionerade interna futures-simulatorn får inte presenteras som aktiv executionmotor.

Referenser:

- `docs/FUTURES_PAPER_RUNTIME.md`
- `docs/TRADING_OS_SAFETY.md`
- `docs/DECISIONS.md`

## Beslut 2 - Canonical Engine ska verifieras före migration

Status:
BESLUT FRÅN ANVÄNDAREN

Beslut:
Canonical Execution Readiness Engine ska först bevisa 0 beslutsskillnader och 0 reasonCode-skillnader under 2-3 hela RTH-dagar.

Konsekvens:
Ingen routing, scheduler, IBKR execution, Batch, Replay, PineScript, Dashboard eller AI ska migreras under evidensperioden.

## Beslut 3 - Avvikelsehantering ska vara enkelspårig

Status:
BESLUT FRÅN ANVÄNDAREN

Beslut:
Om shadowjämförelsen visar en avvikelse ska dagens enda tekniska uppgift vara att förklara den första avvikande kandidaten.

Konsekvens:
Ingen bred refaktorering, optimering eller parallell felsökning får startas.

## Beslut 4 - Canonical Architecture är den långsiktiga riktningen

Status:
BESLUT FRÅN ANVÄNDAREN

Beslut:

```text
TradingOS
Native Futures
Pine
Batch
Replay
    ↓
Canonical Signal
    ↓
Execution Readiness Engine
    ↓
Entry Contract
    ↓
IBKR
```

är den långsiktiga arkitekturen.

Konsekvens:
Migrering sker först efter verifierad shadow-evidens och i separata godkända steg.

## Beslut 5 - Signal är inte order

Status: VERIFIERAT

Beslut:
Signal, kandidat, preview och AI-rekommendation får inte behandlas som order.

Referenser:

- `docs/TRADING_OS_SAFETY.md`
- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md`
- `docs/SAFETY_RULES.md`

## Beslut 6 - AI får rekommendera men inte själv godkänna riskfyllda ändringar

Status: BESLUT FRÅN ANVÄNDAREN

Beslut:
AI-rollerna får analysera, jämföra och rekommendera, men får inte själv aktivera live trading, ändra risk eller kringgå execution-gates.

Referenser:

- `docs/TRADING_OS_SAFETY.md`
- `AGENTS.md`
- `CLAUDE.md`
