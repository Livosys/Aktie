# Roadmap

Den här roadmapen beskriver säkra nästa steg utan att ändra signalregler
automatiskt. Varje fas bör levereras med små, verifierbara ändringar.

## 1. Outcome Fields v1

Mål:

Spara mer strukturerad context i historical outcomes så analys och AI Analyst kan
bli mer specifika.

Fält att lägga till:

- `signalFamily`
- `timeframeAgreement`
- `tf2m`
- `candleScore2m`
- `twoMinuteConflict`
- `extensionLevel`
- `hardBlockers`
- `softBlockers`
- `dataFreshness`
- `primaryReason`
- `nextMoveBias`
- `confidenceScore`

Risk:

Backfill och gamla outcomes kan sakna dessa fält. All läsning måste tåla null.

## 2. Signal Families v1

Mål:

Införa stabil `signalFamily` på live candidates och historical outcomes.

Första familjer:

- `EMA_TREND_PULLBACK`
- `VWAP_RECLAIM_REJECTION`
- `BREAKOUT_RETEST`
- `NARROW_COMPRESSION`
- `LATE_MOVE_BLOCK`
- `UNKNOWN`

Risk:

Familjeklassning får inte ändra status eller thresholds i första versionen. Den
ska bara märka och förklara.

## 3. Stock Feed Fix

Mål:

Minska stale stock-data och göra `dataFreshness` mer pålitlig för aktier.

Arbete:

- verifiera Alpaca live-feed.
- logga feed-fel tydligare.
- särskilj marknad stängd från trasigt dataflöde.
- visa dataålder konsekvent.

Risk:

Aktier har marknadstider medan crypto kör 24/7. Samma freshness-regel kan inte
tolkas likadant för båda.

## 4. Extern AI Senare

Mål:

Använd extern AI bara för svensk textkvalitet, inte för signalbeslut.

Krav före aktivering:

- stabilt analyst-context-schema.
- förbjudna ord-test.
- inga hemliga nycklar i context eller loggar.
- fallback till rule-based output.
- tydlig markering av AI-läge i UI.

Risk:

Extern AI kan formulera sig för starkt eller dra slutsatser utanför context. All
output måste saneras och vara spårbar till backendfält.

## 5. Multi-Period Calibration

Mål:

Kalibrera signaler över flera utfallshorisonter i stället för att överbetona en
enskild period.

Perioder:

- 5 perioder.
- 10 perioder.
- 20 perioder.
- eventuell separat intraperiod drawdown/max move.

Risk:

En signal kan se bra ut på 5 perioder men dålig på 20, eller tvärtom. UI och AI
måste visa skillnaden utan att förenkla för hårt.

## 6. Performance / Lazy Loading

Mål:

Minska frontend-bundle och göra tunga paneler snabbare.

Arbete:

- lazy-load Review Chart.
- lazy-load Machine/History/Quality tunga vyer.
- dela upp stora page-komponenter.
- undvik att hämta AI-analysis för symboler som inte visas.

Risk:

Lazy loading får inte bryta Basic Auth-flödet, routing eller live-refresh.

## Leveransprinciper

- En fas i taget.
- Inga automatiska regeländringar utan separat granskning.
- Dokumentera nya fält samtidigt som de införs.
- Verifiera API-output före frontendändringar.
- Behåll rule-based fallback även när extern AI kommer senare.
