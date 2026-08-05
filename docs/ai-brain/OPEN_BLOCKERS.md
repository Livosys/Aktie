# Open Blockers

Detta är den aktiva blockerarlistan för Second Brain. Orsaker ska verifieras read-only innan de behandlas som tekniska fakta.

## B1 - Reconciliation har visats som degraded

Berört område:
IBKR Paper / brokerpositioner / frontend

Evidens:
Frontendbilder har visat reconciliation status `degraded`.

Konsekvens:
Trading OS och broker kan vara osynkroniserade, eller så kan statusmappning sakna data.

Nästa säkra steg:
Verifiera bakomliggande API-data, reconciliation service och aktuell brokerstatus read-only innan orsak fastställs.

Status:
EJ VERIFIERAT

## B2 - Account- och kapitalfält saknas

Berört område:
IBKR Paper account summary / frontend

Evidens:
Net liquidation, available funds, buying power och PnL har på vissa vyer visats som streck eller saknade värden.

Konsekvens:
Risk- och kontoöversikten kan vara ofullständig.

Nästa säkra steg:
Spåra fält från IBKR account summary service till API och frontendmapping.

Status:
EJ VERIFIERAT

## B3 - Många strategier saknar komplett runtime-evidens

Berört område:
Strategy Registry / producer / market context / performance / approvals

Evidens:
Strategy Dashboard visar omkring 34 strategier, men endast ett mindre antal har kompletta performancevärden. Flera visar producer- eller market-context-behov.

Konsekvens:
Alla registrerade eller approved strategier är inte nödvändigtvis tekniskt körbara.

Nästa säkra steg:
Klassificera varje strategi efter producer, context, candidate, contract, guard, risk och paper execution readiness.

Status:
VERIFIERAT som frontendobservation, teknisk orsak EJ VERIFIERAT

## B4 - Dirty worktree innehåller kritiskt harness-arbete

Berört område:
Mini Futures, IBKR Paper, market data, frontend, execution och tester

Konsekvens:
Orelaterat arbete kan skriva över eller blanda sig med det tre dagar långa testet.

Nästa säkra steg:
Scope-isolera varje uppdrag och rör inte orelaterade dirty filer.

Status:
VERIFIERAT

## B5 - Faktisk IB Gateway-status är inte verifierad i Second Brain

Berört område:
Broker runtime

Konsekvens:
Second Brain får inte anta att anslutning och API-port är friska.

Nästa säkra steg:
Verifiera i separat read-only runtimekontroll när det behövs för harness-testet.

Status:
EJ VERIFIERAT

## B6 - Restart- och reconnectsäkerhet behöver testperiodsevidens

Berört område:
IBKR Gateway, adapter, orchestrator, reconciliation och scheduler

Konsekvens:
Systemet kan tappa positioner eller skapa dubbla intents/orders efter omstart.

Nästa säkra steg:
Samla evidens från kontrollerade restart-/reconnecthändelser under harness-testet.

Status:
EJ VERIFIERAT
