---
name: futures-paper-engine
description: Futures Paper-motorn (MNQ/MES) — scanner, desk, ledger, auto-sim, adapter-härkomst, riskram och submit-lås. Läs vid arbete med futures paper, MNQ/MES eller futures-signaler.
---

# Futures Paper-motorn

## Komponenter
- Services: `futuresPaperScannerService.js`, `futuresPaperDeskService.js`, `futuresPaperLedgerService.js`, `futuresPaperAccountService.js`, `futuresPaperPriceFeedService.js` (fallback-feed), `futuresPaperStorageService.js`.
- **Adapter (enda strategikällan):** `futuresTradingOsSignalAdapterService.js` — Trading OS-signaler in, futures-kandidater ut. Futures Paper får ALDRIG egen strategilogik.
- Endpoints: `/api/futures-paper/runtime|account|positions|trades|scanner|candidates`.
- UI: `client/src/pages/FuturesPaperDeskPage.jsx` (obs: ofta dirty i parallell session — rör ej).

## Riskram (beslutad)
1 micro-kontrakt per trade; max 2 positioner (~4,1x total notional); SL ~0,3 % (~1,9k SEK MNQ / ~1,2k MES); marginmodell 10 %; 250k SEK-konto. Notional ≈ 2,5x (MNQ) / 1,6x (MES) equity. Ändringar av ramen = användarbeslut.

## Regler
1. Auto-sim default AV — slås inte på utan explicit order.
2. IBKR submit låst: `IB_PAPER_SUBMIT_ROUTES_ENABLED=false`; futures-submit-gate (`IB_FUTURES_SUBMIT_ROUTES_ENABLED`) reserverad, EJ byggd — bygg inte.
3. Varje kandidat/trade måste bära Trading OS-strategyId; härkomstlösa signaler = avvikelse att larma om.
4. Resultat rapporteras tillbaka till Learning & Scoring, separerat från aktie-paper.
5. PnL = signedMoney (teckenfix gjord — verifiera vid PnL-ändringar).

## Verifiering
`bash scripts/harness/futures_paper_harness.sh`; command `/futures-check`. Docs: `docs/FUTURES_PAPER_PLATFORM.md`.
