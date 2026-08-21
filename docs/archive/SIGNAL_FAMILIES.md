# Signal Families

Signal Families är planerade etiketter som ska göra signaler mer spårbara över
liveflöde, historik, outcomes och AI Analyst. De ska inte i sig ändra regler.

Målet är att varje signal kan kopplas till en familj med tydligt syfte,
indikatorer, timeframe-kontext och outcome-fält.

## Signal Families v1

V1 klassificerar bara två familjer aktivt:

- `EMA_TREND_PULLBACK`
- `VWAP_RECLAIM_REJECTION`

Om ingen av dem matchar sparas `UNKNOWN`, förutom när ett redan existerande
giltigt `signalFamily` följer med från äldre data. Klassificeringen finns i
`src/scanner/signalFamilyClassifier.js` och ändrar inte live-status,
thresholds eller tradingregler.

## Gemensamma Outcome-Fält

När Signal Families införs bör outcomes spara:

- `signalFamily`
- `familyReasonSv`
- `familyConfidence`
- `familyTimeframes`
- `entryContext`
- `tf2m`
- `timeframeAgreement`
- `candleScore2m`
- `extensionLevel`
- `hardBlockers`
- `softBlockers`
- `dataFreshness`
- outcome efter 5/10/20 perioder.
- om signalen var tidig, sen eller blockerad.

## EMA_TREND_PULLBACK

Syfte:

Fånga trendfortsättning efter rekyl när priset håller sig i linje med en
dominerande trend.

V1-klassificering:

- riktning kan härledas som uppåt eller nedåt.
- minst två större tidsramar, eller en större tidsram plus tydligt stöd, lutar
  åt samma håll.
- `tf2m` eller `candleScore2m` börjar bekräfta samma riktning.
- pris är nära EMA21, EMA50 eller VWAP när dessa fält finns.
- `extensionLevel` är inte `extreme`.
- data är inte `STALE`.
- högst en hard blocker finns.

Subtypes:

- `EMA_PULLBACK_UP`
- `EMA_PULLBACK_DOWN`

Indikatorer:

- EMA/SMA-relationer.
- slope eller trendlutning.
- pris mot kortare medelvärde.
- 2m-candlebekräftelse.
- volymstöd.

Tidsramar:

- 1h och 30m för trendkontext.
- 15m/10m/5m för stöd.
- 2m som beslutspunkt.

Svensk förklaring:

`Trenden lutar åt samma håll i flera tidsramar och priset försöker fortsätta efter rekyl. 2m behöver bekräfta att rekylen håller.`

Spara i outcomes:

- trendriktning.
- avstånd till EMA/SMA.
- pullback-djup.
- 2m-candlebekräftelse.
- om rekylen fortsatte eller bröt ned.

## VWAP_RECLAIM_REJECTION

Syfte:

Fånga lägen där priset återtar VWAP eller avvisas från VWAP med tydlig 2m-reaktion.

V1-klassificering:

- `vwap` finns.
- `vwapDistancePct` finns eller kan beräknas från pris och VWAP.
- pris ligger nära VWAP.
- `tf2m` eller `candleScore2m` stödjer riktningen.
- volymen är inte tydligt svag.
- `extensionLevel` är inte `extreme`.

Subtypes:

- `VWAP_RECLAIM_UP`
- `VWAP_REJECTION_DOWN`

Indikatorer:

- VWAP.
- pris över/under VWAP.
- candle-close runt VWAP.
- volym vid återtag/avvisning.
- fakeout-risk.

Tidsramar:

- 15m/10m/5m för intraday-kontext.
- 2m för återtag eller rejection.

Svensk förklaring:

`Priset testar VWAP. Systemet vill se om nivån återtas eller avvisas med tydlig 2m-reaktion och stöd från volym.`

Spara i outcomes:

- VWAP-avstånd.
- reclaim eller rejection.
- candle-close relativt VWAP.
- volymförändring.
- efterföljande rörelse efter 5/10/20 perioder.

## BREAKOUT_RETEST

Syfte:

Fånga ett utbrott som återtestar tidigare nivå och sedan försöker fortsätta.

Indikatorer:

- tidigare high/low eller breakout-nivå.
- prisavstånd till nivå.
- candle-close över/under nivån.
- volym vid breakout och retest.
- fakeout-risk.

Tidsramar:

- 30m/15m för nivå och bredare struktur.
- 10m/5m för retest.
- 2m för ny bekräftelse.

Svensk förklaring:

`Priset har brutit en nivå och återtestar den. Läget blir renare om 2m visar att nivån håller efter retestet.`

Spara i outcomes:

- breakout-nivå.
- retest-avstånd.
- om nivån höll eller tappades.
- fakeout efter retest.
- max rörelse och drawdown efter signal.

## NARROW_COMPRESSION

Syfte:

Identifiera ihoptryckta lägen där priset kan börja expandera, men där riktningen
ofta behöver inväntas.

Indikatorer:

- narrow score.
- range compression.
- ATR/volatilitet.
- volym.
- timeframeAgreement.
- 2m-break från kompression.

Tidsramar:

- 15m/10m/5m för kompression.
- 2m för första riktade bekräftelse.

Svensk förklaring:

`Priset är ihoptryckt och kan börja röra sig. Systemet ska vänta på tydlig 2m-riktning innan läget tolkas som rent.`

Spara i outcomes:

- compression-score.
- range-storlek.
- breakout-riktning.
- om expansionen höll.
- tid från compression till rörelse.

## LATE_MOVE_BLOCK

Syfte:

Markera lägen där rörelsen redan gått för långt och systemet hellre skyddar mot
att jaga sent.

Indikatorer:

- `extensionLevel`.
- priceToZoneAtr.
- recentMoveAtr.
- fatigueScore.
- breakoutAlreadyOccurred.
- threeFingerSpread.

Tidsramar:

- 5m/10m/15m för hur långt rörelsen gått.
- 2m för om kort bekräftelse fortfarande finns eller har försvagats.

Svensk förklaring:

`Rörelsen har redan gått långt. Systemet vill inte jaga utan behöver rekyl eller ny ren 2m-bekräftelse.`

Spara i outcomes:

- extensionLevel.
- primär blockerare.
- prisavstånd till nivå.
- om blockeringen skyddade mot svag rörelse.
- om blockeringen missade fortsatt rörelse.

## UNKNOWN

Syfte:

Fallback när signalen inte kan klassas säkert.

Indikatorer:

- befintliga signal- och state-fält.
- blockerare.
- timeframeAgreement.
- 2m-candledata om den finns.

Tidsramar:

- alla tillgängliga, men utan familjespecifik tolkning.

Svensk förklaring:

`Systemet har inte tillräckligt med strukturerad familjedata för att klassificera signalen. Bedömningen ska hållas försiktig.`

Spara i outcomes:

- rå signal.
- state.
- status.
- varför familjen blev unknown.
- vilka fält som saknades.
