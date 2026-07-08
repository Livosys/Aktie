# pine/ — Pine Script-källor för Trading OS

Kanoniskt flöde och regler: `docs/PINESCRIPT_WORKFLOW.md`. Ansvarig agent: `.claude/agents/pine-script.md`.

## Struktur

```
pine/
  README.md                                   ← denna fil
  templates/trading_os_strategy_template.pine ← mall med obligatoriskt metadata-block
  strategies/<strategyId>/
    v1.pine, v2.pine, ...                     ← en fil per pineVersion
    CHANGELOG.md                              ← ändring + backendLogicVersion + paritetsstatus
```

## Regler

1. Varje `.pine` speglar en strategi i Trading OS-katalogen (`strategyId` måste finnas i `daytradingStrategyCatalogService.js`). Pine-strategier lever aldrig separat.
2. Metadata-blocket (se template) är obligatoriskt: strategyId, strategyName, pineVersion, backendLogicVersion, signalSource, timeframe, direction, entry, stopLoss, takeProfit, exitLogic, riskModel.
3. Webhook-payload från TradingView-alerts bär samma metadata → POST `/api/tradingview/webhook`.
4. Paritetsavvikelse mot backend → märk `DIVERGED` i CHANGELOG; filen får inte mata Paper Trading förrän fixad.
5. Testsignaler märks `signalSource: "engine_test"`.

## Index

(inga strategier ännu — läggs till per strategyId)
