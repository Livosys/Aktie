# Open Blockers

Detta är den aktiva blockerarlistan för Second Brain. Orsaker ska verifieras read-only innan de behandlas som tekniska fakta.

## B1 - Canonical shadow-evidens saknas över flera fulla RTH-dagar

Berört område:
Canonical Execution Readiness Engine

Evidens:
Historisk och en livejämförelse har rapporterats som 100 %, men 2-3 oberoende hela RTH-dagar har ännu inte slutförts.

Konsekvens:
Migration och routingbyte får inte påbörjas.

Nästa säkra steg:
Kör `shadowReadinessCompare` efter varje full RTH-session och dokumentera resultatet.

Status:
AKTIV BLOCKERARE

## B2 - Första framtida avvikelse är ännu okänd

Berört område:
Canonical adapters, market context, readiness och reasonCodes

Evidens:
Ingen aktuell avvikelse är rapporterad.

Konsekvens:
Ingen förebyggande kodändring är motiverad.

Nästa säkra steg:
Ändra ingenting tills en konkret avvikelse finns. Om en uppstår, undersök endast den första avvikande kandidaten.

Status:
VÄNTAR PÅ EVIDENS

## B3 - Dirty worktree innehåller kritiskt harness-arbete

Berört område:
Mini Futures, IBKR Paper, market data, frontend, execution och tester

Konsekvens:
Orelaterat arbete kan skriva över eller blanda sig med Canonical Shadow Harness eller befintligt Mini Futures-arbete.

Nästa säkra steg:
Scope-isolera varje uppdrag och rör inte orelaterade dirty filer.

Status:
VERIFIERAT

## Operativa IBKR Paper-blockerare

Dessa blockerare påverkar IBKR Paper execution och frontendstatus, men de är inte den primära framgångsmätaren för det aktuella Canonical Shadow Harness-testet.

## B4 - Reconciliation har visats som degraded

Berört område:
IBKR Paper / brokerpositioner / frontend

Evidens:
Frontendbilder och tidigare read-only runtimekontroll har visat reconciliation status `degraded`.

Konsekvens:
Trading OS och broker kan vara osynkroniserade, eller så kan statusmappning sakna data. Detta måste hållas separat från Canonical reasonCode-identitet.

Nästa säkra steg:
Verifiera bakomliggande API-data, reconciliation service och aktuell brokerstatus read-only innan orsak fastställs.

Status:
EJ VERIFIERAT

## B5 - Account- och kapitalfält saknas

Berört område:
IBKR Paper account summary / frontend

Evidens:
Net liquidation, available funds, buying power och PnL har på vissa vyer visats som streck eller saknade värden.

Konsekvens:
Risk- och kontoöversikten kan vara ofullständig, men detta är inte samma sak som en Canonical Shadow Harness-avvikelse.

Nästa säkra steg:
Spåra fält från IBKR account summary service till API och frontendmapping.

Status:
EJ VERIFIERAT

## B6 - `max_open_broker_positions` har observerats som operativ blockerare

Berört område:
IBKR Paper guard / brokerpositioner / orchestration

Evidens:
Tidigare read-only runtimekontroll observerade `guard_not_passed` med `max_open_broker_positions`.

Konsekvens:
IBKR Paper-orderflödet kan stoppas av befintlig guard. Det ska inte tolkas som att Canonical Engine har misslyckats utan jämförelserapport.

Nästa säkra steg:
Verifiera aktuell brokerposition, guard-input och jämförelserapport read-only innan teknisk orsak fastställs.

Status:
VERIFIERAT som tidigare runtimeobservation, teknisk orsak EJ VERIFIERAT

## B7 - Många strategier saknar komplett runtime-evidens

Berört område:
Strategy Registry / producer / market context / performance / approvals

Evidens:
Strategy Dashboard visar omkring 34 strategier, men endast ett mindre antal har kompletta performancevärden. Flera visar producer- eller market-context-behov.

Konsekvens:
Alla registrerade eller approved strategier är inte nödvändigtvis tekniskt körbara. Detta är separat från om Canonical Engine matchar befintlig produktionslogik för kandidater som faktiskt uppstår.

Nästa säkra steg:
Klassificera varje strategi efter producer, context, candidate, contract, guard, risk och paper execution readiness i separat godkänt uppdrag.

Status:
VERIFIERAT som frontendobservation, teknisk orsak EJ VERIFIERAT

## B8 - Faktisk IB Gateway-status är inte verifierad i Second Brain

Berört område:
Broker runtime

Konsekvens:
Second Brain får inte anta att anslutning och API-port är friska.

Nästa säkra steg:
Verifiera i separat read-only runtimekontroll när det behövs för det operativa IBKR Paper-spåret.

Status:
EJ VERIFIERAT

## B9 - Restart- och reconnectsäkerhet behöver separat evidens

Berört område:
IBKR Gateway, adapter, orchestrator, reconciliation och scheduler

Konsekvens:
Systemet kan tappa positioner eller skapa dubbla intents/orders efter omstart.

Nästa säkra steg:
Samla evidens från kontrollerade restart-/reconnecthändelser i separat godkänt operativt spår.

Status:
EJ VERIFIERAT
