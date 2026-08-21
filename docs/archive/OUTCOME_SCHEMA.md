# Outcome Schema

Outcome-records skrivs som JSONL till:

`data/signals/outcomes/<YYYY-MM-DD>.jsonl`

Writern finns i:

`src/scanner/signalOutcomeAnalyzer.js`

Den läser historiska signaler från:

`data/signals/history/<YYYY-MM-DD>.jsonl`

Signalrecords skapas i:

`src/scanner/historicalScanner.js`

## Bakåtkompatibilitet

Gamla outcome-records saknar flera fält från Outcome Fields v1. Läsare ska därför
alltid tåla saknade fält, `null`, `unknown` och tomma arrays. Signal Quality
använder fallbackvärden när nya fält saknas.

## Identity

- `signalId`
- `symbol`
- `marketType`
- `timestamp`

## Grundfält

- `status`
- `priority`
- `score`
- `tradeScore`
- `narrowScore`
- `confidenceScore`
- `nextMoveBias`
- `direction`
- `signal`
- `eventType`
- `signalFamily`
- `signalSubtype`
- `primaryReason`
- `decisionTextSv`
- `entryPrice`
- `priceAtSignal`

`entryPrice` är det äldre prisfältet. `priceAtSignal` är ett nytt alias för
tydligare rapportering.

## Risk Och Timing

- `priceToZoneAtr`
- `extensionLevel`
- `dataFreshness`
- `dataAgeSeconds`
- `fakeoutRiskLevel`
- `volumeState`
- `rvol`
- `atr14`
- `vwapDistancePct`

Om live-only fält saknas i historical pipeline sparas `null` eller `unknown`.

## 2m Och Timeframes

- `candleScore2m`
- `twoMinuteConflict`
- `tf2m`
- `tf5m`
- `tf10m`
- `tf15m`
- `tf30m`
- `tf1h`
- `timeframeAgreement`
- `agreementCount`

I historical pipeline finns inte alltid samma timeframe-context som i live
Decision Monitor. Då sparas `unknown` eller `null`.

## Blockers

- `hardBlockers`
- `softBlockers`
- `blockers`

När historiska signaler saknar blockerare sparas tomma arrays.

## Regime Och Context

- `marketRegime`
- `marketDirection`
- `choppyState`
- `marketPersonality`
- `narrowState`
- `narrowType`
- `state`

## Indicators

Sparas när de redan finns i signalrecord:

- `ema9`
- `ema21`
- `ema50`
- `sma20`
- `sma50`
- `sma200`
- `vwap`
- `rsi`
- `rsi14`

## Signal Families

Tillåtna värden:

- `EMA_TREND_PULLBACK`
- `VWAP_RECLAIM_REJECTION`
- `BREAKOUT_RETEST`
- `NARROW_COMPRESSION`
- `LATE_MOVE_BLOCK`
- `UNKNOWN`

Om ingen säker klassificering finns sparas `UNKNOWN`.

V1 klassificerar aktivt:

- `EMA_TREND_PULLBACK`
- `VWAP_RECLAIM_REJECTION`

Fältet `signalFamilyReasonSv` kan sparas när klassificeringen har en kort svensk
förklaring. `signalSubtype` sätts till familjens subtype när den kan härledas,
annars befintlig subtype/eventType eller `UNKNOWN`.

## Dedup

`src/scanner/signalOutcomeAnalyzer.js` läser dagens outcome-fil innan append och
bygger en set med befintliga `signalId`. Om samma `signalId` redan finns skippar
analyzer ny append och räknar upp `skippedDuplicates` i körningssummaryn.

## Outcome-Horisonter

Nuvarande analyzer beräknar:

- `outcome3`
- `outcome5`
- `outcome10`
- `outcome20`
- `outcome30`

Varje outcome innehåller:

- `priceChangePct`
- `maxMoveUp`
- `maxMoveDown`
- `candlesAvail`

## Success-Fält

- `success`: `true`, `false` eller `null`.
- `failureReason`: t.ex. `insufficient_data`, `non_directional_signal`,
  `stopped_out`, `no_follow_through`.

## Fält Som Ofta Saknas I Historical Pipeline

Följande fält finns främst i live Decision Monitor och kan vara `null` eller
`unknown` i historical outcomes:

- `confidenceScore`
- `decisionTextSv`
- `dataAgeSeconds`
- `fakeoutRiskLevel`
- `candleScore2m`
- `twoMinuteConflict`
- `tf10m`
- `tf30m`
- `tf1h`
- `hardBlockers`
- `softBlockers`
- `marketPersonality`
- `ema9`
- `ema21`
- `ema50`
- `sma50`
- `vwap`
