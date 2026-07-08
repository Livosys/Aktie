---
name: trading-strategy-adapter
description: Strategi-härkomst och adapter-mönstret — hur Trading OS-strategier flödar till Paper/Futures/Mini Future via adaptrar med strategyId-disciplin. Läs vid signalflödes-, adapter- eller strategikatalogarbete.
---

# Trading Strategy Adapter

## Princip
Trading OS strategikatalog (`daytradingStrategyCatalogService.js`, se `docs/STRATEGY_SINGLE_SOURCE_OF_TRUTH.md`) är enda strategikällan. Varje exekverings-yta (Paper Trading, Futures Paper, framtida Mini Future) konsumerar signaler via en **adapter** — aldrig egen strategilogik.

## Adapter-kontrakt
En adapter ska:
1. Ta emot Trading OS-signal med `strategyId`, `strategyName`, version, `signalSource`, riktning, entry/SL/TP.
2. Översätta till ytans instrument (MNQ/MES-kontrakt, Mini Future-produkt) utan att ändra strategilogiken.
3. Avvisa signaler utan känt strategyId — **ingen fallback till annan strategi** (ef5afd1), ingen gissning av riktning/pris (setup-builder-principen: watch-signal utan verifierad riktning/pris = korrekt blockerad).
4. Märka allt syntetiskt med `engine_test`/`simulated_fallback` så det exkluderas ur score.
5. Rapportera utfall tillbaka med samma strategyId så Learning & Scoring kan jämföra över ytor.

## Befintlig referensimplementation
`src/services/futuresTradingOsSignalAdapterService.js` (Trading OS → Futures Paper). Mini Future-adaptern (framtida) följer samma kontrakt + produktmappningsreglerna i `docs/MINI_FUTURE_RESEARCH.md`.

## Anti-mönster (förbjudna)
- Strategi som bara existerar i en exekverings-yta.
- Adapter som "förbättrar" entries/exits själv (förbättringar går via batch/replay → katalogen).
- Signal utan spårbar härkomst i rapporter/score.

## Verifiering
Härkomstkontroll ingår i `/futures-check` och `futures_paper_harness.sh`; arkitektur: `docs/TRADING_OS_ARCHITECTURE.md`.
