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

## Beslut 2 - Mini Futures harness-testet är högsta prioritet

Status: BESLUT FRÅN ANVÄNDAREN

Beslut:
Det tre dagar långa Mini Futures harness-testet är projektets nuvarande huvudmål.

Konsekvens:
PineScript, TradingView-automation och orelaterad frontendutveckling ska inte störa testet.

## Beslut 3 - Strategier måste bevisa hela kedjan

Status: BESLUT FRÅN ANVÄNDAREN

Beslut:
En strategi räknas inte som fungerande bara för att den är registrerad eller approved. Den måste kunna producera signal, passera gates, exekveras i IBKR Paper, reconcileras och ge registrerat resultat.

## Beslut 4 - Signal är inte order

Status: VERIFIERAT

Beslut:
Signal, kandidat, preview och AI-rekommendation får inte behandlas som order.

Referenser:

- `docs/TRADING_OS_SAFETY.md`
- `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md`
- `docs/SAFETY_RULES.md`

## Beslut 5 - AI får rekommendera men inte själv godkänna riskfyllda ändringar

Status: BESLUT FRÅN ANVÄNDAREN

Beslut:
AI-rollerna får analysera, jämföra och rekommendera, men får inte själv aktivera live trading, ändra risk eller kringgå execution-gates.

Referenser:

- `docs/TRADING_OS_SAFETY.md`
- `AGENTS.md`
- `CLAUDE.md`
