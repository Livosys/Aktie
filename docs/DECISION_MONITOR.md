# Decision Monitor

Decision Monitor är det live-lager som gör scannerresultat lättare att tolka utan
att ändra själva signalmotorerna. Det samlar aktuell scannerdata, timeframe-läge,
2m-candlebedömning, blockerare, datafräschhet och en svensk beslutstext per
kandidat.

Systemet är beslutsstöd. Det placerar inga order.

## Endpoint

`GET /api/live/decision-monitor`

Valfria query-parametrar:

- `includeAi=1`: lägger till rule-based AI Analyst per candidate.
- `debug=1`: lägger till `tfDebug` med live 2m-candles när de finns.

Responsen innehåller i huvuddrag:

- `ok`
- `candidates`
- `summary`
- `ai` när `includeAi=1`

## Statusnivåer

`status` och `priority` används som samma beslutsnivå i Decision Monitor.

- `active`: systemet ser ett rentare läge där grafen bör granskas manuellt.
- `caution`: nära ett bättre läge, men någon varning finns.
- `watch`: bevaka; villkor finns delvis men något saknas.
- `wait`: vänta; stödet är inte tillräckligt rent.
- `avoid`: jaga inte; risk, avstånd eller blockerare är för tydliga.
- `stale`: data är gammal eller osäker.
- `unknown`: systemet kan inte bedöma läget.

Status är inte samma sak som riktning. Status svarar på frågan: "hur rent och
rimligt är läget just nu?"

## nextMoveBias

`nextMoveBias` beskriver förväntad kort riktning, inte kvalitetsnivå.

Vanliga värden:

- `UP`: kort bias uppåt.
- `DOWN`: kort bias nedåt.
- `NEUTRAL`: neutral riktning.
- `UNCERTAIN`: riktningen är osäker.

Ett exempel: en kandidat kan ha `nextMoveBias=UP` men `status=wait` om 2m saknar
bekräftelse, marknaden är ryckig eller priset är långt från en bra nivå.

## 2m Som Beslutspunkt

2m är den korta beslutspunkten i liveflödet. Större tidsramar kan ge kontext,
men Decision Monitor ska inte lyfta ett läge utan att 2m är rimligt bekräftad.

Viktiga fält:

- `tf2m`: riktningen från 2m-timeframe.
- `candleScore2m`: läser de senaste live 2m-candles när de finns.
- `twoMinuteConflict`: markerar konflikt när timeframe-riktning och senaste
  2m-candles säger emot varandra.

## timeframeAgreement

`timeframeAgreement` är en sammanställning av riktningen i flera tidsramar:

- `tf1h`
- `tf30m`
- `tf15m`
- `tf10m`
- `tf5m`
- `tf2m`

`agreementCount` anger hur många tidsramar som pekar åt samma dominerande håll.
Hög agreement är stöd, men räcker inte ensam om 2m saknar bekräftelse eller om
blockerare finns.

## candleScore2m

`candleScore2m` är en read-only bedömning av de senaste 2m-candles.

Vanliga fält:

- `scoreDirection`: `bullish`, `bearish`, `neutral` eller `unknown`.
- `reasonSv`: svensk förklaring.
- `greenCount5`, `redCount5`: antal gröna/röda candles i senaste fem.
- `greenCount3`, `redCount3`: antal gröna/röda candles i senaste tre.
- `netMovePct5`, `netMovePct3`: nettorörelse.
- `higherHighsCount`, `higherLowsCount`: enkel strukturbedömning.
- `volumeComment`: enkel volymkommentar.

`candleScore2m` ska förklara kort 2m-läge. Det ska inte skapa nya signaler.

## twoMinuteConflict

`twoMinuteConflict=true` betyder att större/timeframe-bilden kan ge stöd, men de
senaste 2m-candles säger emot.

I det läget ska systemet normalt hellre vänta på ny 2m-bekräftelse än att jaga
en rörelse som redan ser svagare ut i den korta beslutspunkten.

## Blockerare

Decision Monitor skiljer på hårda och mjuka blockerare.

`hardBlockers`:

- ska stoppa eller kraftigt begränsa läget.
- exempel: hög fakeout-risk, gammal crypto-data, extremt utsträckt rörelse.

`softBlockers`:

- är varningar som kan göra status mer försiktig.
- exempel: priset är lite långt från bra nivå, volymen är svag, marknaden är
  ryckig, 2m saknar bekräftelse.

Blockerare är beslutsstöd och förklaringsdata. De ska inte ändras automatiskt av
AI-lagret.

## dataFreshness

`dataFreshness` beskriver om livebedömningen kan lita på aktuell data.

Vanliga värden:

- `FRESH`: data är tillräckligt färsk.
- `STALE`: data är gammal.
- `UNKNOWN`: fräschhet kan inte bedömas.

`dataAgeSeconds` visar ålder när den kan beräknas. Crypto har strängare
färskhetskrav än aktier eftersom crypto skannas 24/7.

## Kända Risker

- `timeframeAgreement` kan se starkt ut samtidigt som 2m saknar bekräftelse.
- Stale data kan ge missvisande riktning om den inte stoppas tidigt.
- `candleScore2m` bygger på ett kort candlefönster och kan växla snabbt.
- Blockerare kommer från flera motorer och kan överlappa i innebörd.
- Status är en sammanvägd bedömning, inte en garanti.
- Historiska resultat är beroende av sparad outcome-data och kan sakna vissa
  livefält.
