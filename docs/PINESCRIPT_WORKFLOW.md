# PINESCRIPT_WORKFLOW — Pine Script, TradingView, webhook, versionering

## Nuläge (inventering 2026-07-08)

- **Inga `.pine`-filer finns i repot ännu.** Struktur skapad: `pine/` (se nedan).
- **Webhook finns:** `POST /api/tradingview/webhook` i `src/routes/api.js` (~rad 4520).
- **Relaterade services:** `tradingViewConnectorService.js`, `tradingViewPaperReplayPreviewService.js`, `tradingViewPreviewLogService.js`.
- **Kontrakt:** `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md` (webhook→paper/replay-preview).

## Princip

Pine Script-strategier lever ALDRIG separat. Varje Pine-fil är en spegel av en Trading OS-strategi och kopplas via `strategyId`/`strategyName`/version. Pine Script Agent ansvarar för att TradingView-signalen matchar backend-logiken (paritetstest via replay-preview).

## Katalogstruktur

```
pine/
  README.md                       — regler + index
  templates/
    trading_os_strategy_template.pine
  strategies/
    <strategyId>/
      v1.pine, v2.pine, ...       — en fil per pineVersion
      CHANGELOG.md                — vad ändrades, mot vilken backendLogicVersion
```

## Obligatorisk metadata

Varje Pine-fil inleds med ett metadata-block, och varje webhook-payload ska bära samma fält:

```json
{
  "strategyId": "narrow_fakeout_reversal_v1",
  "strategyName": "Narrow Fakeout Reversal",
  "pineVersion": "1.0.0",
  "backendLogicVersion": "<git-sha eller katalogversion>",
  "signalSource": "tradingview_pine",
  "timeframe": "2m",
  "direction": "long|short",
  "entry": 0,
  "stopLoss": 0,
  "takeProfit": 0,
  "exitLogic": "fixed|trailing|partial|time|volatility",
  "riskModel": "r_multiple_0_3pct"
}
```

Payload utan `strategyId` eller med okänt id får aldrig skapa paper-trade (ingen fallback till annan strategi — jfr fix ef5afd1). Testanrop märks `signalSource: "engine_test"`.

## Flöde

```
Trading OS-strategi (katalog, backendLogicVersion)
  → Pine Script Agent skriver/uppdaterar pine/strategies/<id>/vN.pine
  → TradingView-alert med webhook-payload (metadata ovan)
  → POST /api/tradingview/webhook
  → paritetskontroll (replay-preview: ger Pine-signal samma entry/exit som backend?)
  → Paper Trading (om strategyId är allowlistad)
  → senare: Mini Future-sidan (research/paper)
```

## Paritetskontroll (Pine ↔ backend)

1. Kör samma historiska fönster i replay med backend-strategin.
2. Jämför signaltidpunkter/riktning/nivåer mot Pine-alerts (preview-loggen).
3. Avvikelse >tolerans → Pine-filen märks `DIVERGED` i sin CHANGELOG och får inte mata Paper Trading förrän fixad.

## Förbud

- Ingen Pine-fil utan strategyId-koppling.
- Ingen webhook-payload som utger sig för att vara en strategi den inte är.
- Webhook får aldrig trigga ordervägar — endast paper/preview (skyddas av `executionSafetyService`).

Verifiering: `bash scripts/harness/pinescript_harness.sh`, command `/pine-check`.
