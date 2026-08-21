# Signal Quality

Signal Quality analyserar historiska outcome-rader och sammanfattar hur tidigare
signaler fungerade. Det används som kalibrerings- och förklaringsdata för UI och
AI Analyst.

Outcome-schema dokumenteras separat i `docs/OUTCOME_SCHEMA.md`.

## Endpoint

`GET /api/history/signal-quality`

Vanliga query-parametrar:

- `days`: antal dagar bakåt, max 30.
- `limit`: antal recent-rader, max 500.

Responsen innehåller:

- `ok`
- `analyzedDays`
- `totalAnalyzed`
- `summary`
- `byStatus`
- `bySymbol`
- `bySignalFamily`
- `byExtensionLevel`
- `byDataFreshness`
- `byPrimaryReason`
- `byTwoMinuteConflict`
- `recent`

## Inputdata

Signal Quality läser outcome-filer från:

`data/signals/outcomes/<YYYY-MM-DD>.jsonl`

Varje outcome-rad kan innehålla:

- symbol och timestamp.
- signal och state.
- status och priority.
- score och confidenceScore.
- nextMoveBias och direction.
- signalFamily och signalSubtype.
- primaryReason och decisionTextSv.
- tradeScore och narrowScore.
- entryPrice.
- priceAtSignal.
- risk/timing-fält som extensionLevel, priceToZoneAtr och dataFreshness.
- timeframe-fält som tf2m/tf5m/tf10m/tf15m/tf30m/tf1h.
- blockers.
- outcome efter 5/10/20 perioder.
- marknadsriktning.

## Analys Efter 5/10/20 Candles

Outcome-fälten heter:

- `outcome5`
- `outcome10`
- `outcome20`

Signal Quality beräknar bland annat:

- prisförändring efter respektive period.
- om riktningen stämde.
- om signalen kom för sent.
- om en blockering skyddade mot svag rörelse.
- om blockeringen missade en rörelse.

Nuvarande quality-etiketter:

- `Träffade riktning`
- `Bra blockering`
- `Missad möjlighet`
- `Kom för sent`
- `Osäker`
- `Data saknas`

## Statuskalibrering

Historiska outcome-rader mappas till status för jämförelse.

Nuvarande förenklade mapping:

- `active`: triggered signal med `tradeScore >= 70`.
- `watch`: triggered signal med `tradeScore` 50-69.
- `watch`: score >= 30 eller signal som innehåller `WATCH`.
- `avoid`: avoid-state eller `NO_TRADE`.
- `wait`: fallback när inget ovan gäller.

Det här är en analysmapping. Den ska inte förväxlas med livebeslutets fulla
Decision Monitor-logik.

## Active Score >= 70

Triggered signaler med `tradeScore >= 70` räknas som `active` i signal quality.
Syftet är att mäta hur de starkaste historiska signalerna presterade jämfört med
lägre statusnivåer.

## Watch Score 50-69

Triggered signaler med `tradeScore` mellan 50 och 69 räknas som `watch`.
Det gör det möjligt att jämföra om watch-lägen historiskt var bättre eller sämre
än active-lägen.

## Avoid-Skydd

Vissa states räknas som avoid:

- `THREE_FINGER_SPREAD_AVOID`
- `WIDE_AVOID`
- `BREAKOUT_ALREADY_OCCURRED`
- `NO_TRADE`

För avoid analyseras om blockeringen var skyddande:

- `Bra blockering`: priset rörde sig inte tydligt i förväntad riktning.
- `Missad möjlighet`: priset rörde sig ändå tydligt i förväntad riktning.

Det här används för att se om blockerare skyddar mot svaga lägen eller om de
ibland stoppar för mycket.

## Summary-Fält

`summary` innehåller bland annat:

- total analyserade outcomes.
- antal med directional bias.
- directional correct efter 5/10/20.
- procent rätt riktning.
- snittrörelse efter 5/10/20.
- antal sena signaler.
- antal bra och missade blockeringar.
- bästa och sämsta historiska status när data räcker.
- `narrativeSv`, en svensk sammanfattning.

## Nya Grupperingar

Outcome Fields v1 lägger till grupperingar i `/api/history/signal-quality`:

- `bySignalFamily`: visar utfall per signalfamilj, inklusive `UNKNOWN`.
  Gruppen innehåller count, directionalCorrect5/10/20, avgMove5/10/20,
  bestSymbol/worstSymbol när data räcker, vanligaste status och vanligaste
  primaryReason.
- `byExtensionLevel`: visar om sena/utsträckta rörelser skiljer sig från rena
  lägen.
- `byDataFreshness`: visar om outcomes har färsk, gammal eller okänd data.
- `byPrimaryReason`: visar de vanligaste primära orsakerna och deras utfall.
- `byTwoMinuteConflict`: visar om 2m-konflikt påverkar resultat när fältet finns.

Gamla records som saknar fälten hamnar i `UNKNOWN` eller `unknown`.

## Kända Begränsningar

- Analysen är beroende av att outcome-filer finns och är färska.
- Mapping från historiska signaler till status är förenklad.
- Alla livefält finns inte alltid i historiska outcomes.
- Signal family används inte fullt ut ännu.
- Många äldre records hamnar i `UNKNOWN`/`unknown` i nya grupperingar.
- Resultat efter 5/10/20 perioder säger inte allt om intraperiod-risk.
- Directional correctness är grov och säger inget om faktisk exekvering.
- Quality-data ska användas som beslutsstöd, inte som automatisk regeländring.
