# Next Action

Status:
AKTUELLT HUVUDUPPDRAG ÄR FAS 36 — VERIFIERING AV CANONICAL tradeId

Ersätter tidigare mandat Canonical Shadow Harness, avlöst 2026-08-11 på uttrycklig
order från användaren.

Mål:
Verifiera att den canonical tradeId-ägaren bevarar identiteten genom hela IBKR
Paper-kedjan på en riktig trade, inte bara mot injicerad reconciliation.

## Läge 2026-08-11

Implementationen är klar, testad och live:

- Canonical owner: `src/services/ibPaperExecutionOrchestratorService.js`,
  funktion `buildTradeId` (rad 195-199), mint på rad 898 i `buildShadowExecution`.
- tradeId härleds deterministiskt ur executionId. Ett omkört exekveringsförsök får
  tillbaka samma trade-rot i stället för att skapa en ny.
- Allt nedströms är ren propagering. `lifecycleIdentity.mergeIdentity` bar redan
  fältet; endast de vitlistor som räknar upp identiteterna explicit behövde
  utökas (guard, intent-post, attributeBrokerRows, executionEvidence, desk).
- Commit `b05022b` på branch `fas36/canonical-tradeid-owner`, från `82bc75c`.
- Backend omstartad 2026-08-11T13:19:24Z. Koden är live i pm2-processen
  `nasdaq-scanner` (script `/var/www/nasdaq-scanner-release-d109135/server.js`,
  `NODE_PATH=/var/www/nasdaq-scanner-prod/node_modules`).
- 124 tester gröna. 6 fel är verifierat preexisterande — samma sex fallerar på ren
  baslinje utan FAS 36.
- Identity preservation 100 %, join coverage 100 %, 0 broken joins, 0 orphan nodes,
  1 distinkt trade-rot. Mätt mot injicerad reconciliation, ännu inte mot en riktig
  trade.

## Kvarstående uppgift

Verifiera första riktiga trade och rapportera:

- strategyId
- candidateId
- lifecycleId
- intentId
- executionId
- tradeId
- brokerOrderId
- execId
- timestamp

Verifiera att samma trade utan manuell import syns i Trades, Orders, Positions,
Ledger, Dashboard och Analytics.

## Kända gap

- Signal Intelligence, Counterfactual och Evidence Graph existerar inte i
  kodbasen — noll träffar i hela repot inklusive `client/src`. De kan inte
  verifieras och får inte byggas inom FAS 36.
- 62 intents skapade före FAS 36 bär `tradeId: null`. Det är avsiktligt. FAS 36 är
  framåtriktad; en backfill kräver ett separat beslut.

## Konsekvens för Canonical Shadow Harness

Evidensperioden är ogiltig. Orchestratorns identitetsväg ändrades 2026-08-11, så
insamlad evidens före det datumet får inte återanvändas. Perioden måste startas om
från och med första hela RTH-dagen efter `b05022b`.

Tillåtna handlingar:

- read-only observation av kandidater, intents, fills och trades
- läsa reconciliation- och desk-payloads
- verifiera identitetsjoin på riktig trade
- dokumentera evidens

Förbjudet:

- ändra Canonical Engine
- ändra produktionslogik
- byta routing
- migrera scheduler
- migrera IBKR execution
- ändra Entry Contract
- ändra Guard eller Risk
- aktivera live trading
- ändra order submission
- skapa fler tradeId-generatorer, fallback-tradeIds eller backfill-jobb
- återaktivera intern futures-simulering
- PineScript-arbete
- Batch-/Replay-migration
- frontendredesign
- orelaterad felsökning
- commit, push, restart eller deploy utan separat godkännande

Commit tillåten:
NEJ — b05022b var engångsgodkänd för FAS 36

Push tillåten:
NEJ

Restart tillåten:
NEJ — omstarten 13:19:24Z var engångsgodkänd för FAS 36

Dokumenterad nästa åtgärd är inte samma sak som godkänd implementation.
