# Futures Data Layer — IB som gemensam dataplattform (FAS 1-design)

Status: DESIGN (FAS 1). Ingen kod i detta dokument är byggd ännu utom
verifieringsproben `scripts/verifyIbFuturesData.js`.

Beslut som designen bygger på:

- Interactive Brokers är den centrala futures-datakällan för hela Trading OS.
- Det ska finnas EN gemensam futures-datakälla. Ingen modul får bygga egna
  candles eller använda egen marknadsdata.
- Databento avvecklas ur futures-flödet om IB-verifieringen (proben) bekräftar
  att IB levererar det som behövs. Databento-koden är redan inert
  (`DATABENTO_ENABLED=false`, aldrig körd, ingen data importerad).
- Paper only. Ingen execution, ingen broker-aktivering, inga riktiga order.

## 1. Nuläge (inventerat 2026-07-15)

```text
AKTIER/KRYPTO (live):  Alpaca/Binance → scheduler (bygger egna candles i minnet)
                        → 20+ engines → signaler → paper trading
AKTIER/KRYPTO (hist):  Alpaca/Binance-import → data/market-data/* (marketDataStore)
                        → replay/batch-coverage/pine/narrow-autopilot

FUTURES (live):        futuresPaperPriceFeedService = SIMULERAD random walk
                        → futuresPaperScannerService (quotes, inga candles)
FUTURES (signaler):    aktie-scannerns signaler (QQQ/SPY-proxy) mappas via
                        futuresTradingOsSignalAdapterService till MNQ/MES
FUTURES (hist):        FINNS INTE. marketDataStore har 0 MNQ/MES-candles.
                        databentoFuturesImportService = byggd men inert.
IB idag (prod):        endast connection-readiness + gated paper-execution-kedja.
                        IB MARKNADSDATA används inte i prod-appen alls.
IB futures-md-kod:     finns färdig i deploy-fas43b/ib-paper-worktrees
                        (contract resolution + reqMktData-snapshot, gated).
Lab Batch:             saveSimulatedStrategyTest → deterministicTestResult =
                        SYNTETISKA resultat (sha256-hash), läser inga candles.
Replay:                replayEngine → marketDataStore.loadCandles (riktiga candles).
Pine Research:         pineResearchOrbAdapterService → marketDataStore.
```

Kända dubbla candle-vägar som designen eliminerar för futures:

1. Live-scannerns egen in-memory-aggregering (candleAggregator på Alpaca 1m).
2. Simulerad futures-feed (random walk).
3. Databento-importvägen (inert).

## 2. Målarkitektur

```text
IB Gateway (4002, manuell login, paper)
  ↓
ibFuturesDataAdapterService          ← ENDA modulen som pratar @stoqey/ib för data
  (egen clientId, reconnect/backoff, contract-cache, pacing-guard)
  ↓
futuresMarketDataService             ← Market Data Service (realtime)
  (reqMarketDataType(1) + reqRealTimeBars 5s / reqMktData snapshot
   → candleBuilder 1m → aggregering 2m/5m/15m/1h via befintlig candleAggregator)
  ↓
futuresHistoricalDataService         ← Historical Service (backfill + gap-fill)
  (reqHistoricalData 1m/2m/…/1d, manifest, calendarDates —
   återanvänder databentoFuturesImportServices plan/manifest-mönster)
  ↓
marketDataStore                      ← Trading OS Data Bus (befintlig, utökas
  (data/market-data/candles-*/MNQ …)   med source 'ib' bredvid alpaca/binance)
  ↓
Scanner (futures-producers) → 33 strategier → Futures Paper
  ↓                                    ↓
Replay Lab ── Batch Lab ── Pine Research ── AI/Learning ── Supervisor
```

Regler:

- Alla candles för MNQ/MES/ES/NQ skapas av candleBuilder i
  futuresMarketDataService eller futuresHistoricalDataService — ingen annanstans.
- Alla konsumenter läser candles ur marketDataStore (samma objektform som idag:
  `{timestamp, open, high, low, close, volume}`).
- Sessionsklassning görs ENDAST av futuresMarketHoursService (Globex-korrekt,
  America/Chicago, verifierad med tester 2026-07-15). Ingen aktie-session får
  användas i futures-flödet.
- futuresPaperPriceFeedService behålls enbart som tydligt märkt fallback
  (`simulated_fallback`) när IB-feeden inte levererar; UI/ledger märker redan
  källan per trade.

## 3. Nya/ändrade moduler (byggordning FAS 2)

1. `src/services/ibFuturesDataAdapterService.js` (NY)
   - Portera contract-resolution från fas43b `interactiveBrokersFuturesContractService`
     (front month via reqContractDetails, verifierade conIds, rollover-datum).
   - Connection-hantering: egen clientId (`IB_FUTURES_DATA_CLIENT_ID`, default 955),
     reconnect med backoff, statusobjekt för Supervisor.
   - Läser ALDRIG order-API:er. Endast reqContractDetails / reqMktData /
     reqRealTimeBars / reqHistoricalData / reqHistoricalTicks.
2. `src/services/futuresMarketDataService.js` (NY)
   - 5s realtime bars → 1m-candles → candleAggregator → 2m/5m/15m/1h.
   - Skriver till marketDataStore (source 'ib') + liten in-memory-cache med
     senaste quote/candle för scanner och desk.
   - Flagga: `IB_FUTURES_DATA_ENABLED` (default false = inert).
3. `src/services/futuresHistoricalDataService.js` (NY)
   - Backfill + daglig gap-fill för MNQ/MES (ES/NQ vid behov) 1m→2m.
   - Återanvänder plan/manifest/calendarDates-strukturen från
     databentoFuturesImportService (som sedan raderas i FAS 3).
4. `futuresPaperScannerService` (ÄNDRAS)
   - `priceFeedService` byts till futuresMarketDataService-quotes när flaggan är
     på; behåller simulated_fallback som explicit märkt reserv.
5. Futures-producers (ÄNDRAS/NYA)
   - Producers för de 24 strategier som saknar producer körs mot IB-candles ur
     marketDataStore i stället för aktie-proxy-signaler. (Separat fas; se
     strategikartan i FAS 1-rapporten.)
6. Replay/Batch/Pine (ÄNDRAS, små steg)
   - Replay: `REPLAY_FUTURES_SCOPE_ENABLED=true` när MNQ/MES-candles finns i
     store (koden är redan byggd och gated).
   - Batch: ersätt deterministicTestResult med replay-baserad körning mot
     riktiga candles för futures-grupper (större omplanering, egen fas).
   - Pine Research: ingen ändring — läser redan marketDataStore.

## 4. Feature flags

```text
IB_FUTURES_DATA_ENABLED=false        # master-switch för hela datalagret
IB_FUTURES_DATA_CLIENT_ID=955        # egen clientId, krockar aldrig med appen
IB_FUTURES_MD_TYPE=1                 # 1=realtime (CME Real-Time finns på kontot)
IB_FUTURES_BACKFILL_ENABLED=false    # historical backfill-jobb
REPLAY_FUTURES_SCOPE_ENABLED=false   # befintlig; slås på när data finns
DATABENTO_ENABLED=false              # förblir false; koden tas bort i FAS 3
```

## 5. Vad IB klarar / inte klarar (API-fakta, verifieras av proben)

Klarar (för MNQ/MES/ES/NQ på CME):

- Realtime: reqMktData (snapshot/stream) + reqRealTimeBars (5s) med CME
  Real-Time (Non-Pro) — kontot har prenumerationen.
- Historical bars: 1 min, 2 mins, 5 mins, 15 mins, 1 hour, 1 day m.fl.
- Historical ticks: reqHistoricalTicks (max 1000/anrop).
- Kontinuerlig kontraktshistorik: secType CONTFUT (endast historical).

Begränsningar (måste hanteras i adaptern):

- Pacing: max ~60 historical-requests/10 min; identiska requests ska cachas;
  proben använder 2s paus mellan requests.
- Historikdjup är kontraktsbundet: utgångna kontrakt har data ~2 år bakåt;
  längre serier kräver CONTFUT eller stitching vid rollover.
- 1m-data hämtas i chunkar (max ~1 dag/request svar beroende på barSize/duration).
- API-porten är öppen ENDAST när gatewayen är manuellt inloggad; daglig/veckovis
  omstart av gatewayen stänger porten tills ny login sker. Datalagret måste
  därför alltid kunna falla tillbaka till "stale + tydligt märkt" läge.
- Tick-strömmar (tick-by-tick) är begränsade i antal samtidiga prenumerationer.

Exakta siffror per timeframe/symbol fylls i av
`node scripts/verifyIbFuturesData.js --deep` (kräver inloggad gateway) →
`scratchpad/ib-futures-data-verification.json`.

## 6. Databento-avveckling (FAS 3, efter grön probe)

1. Verifiera att futuresHistoricalDataService fyllt samma datumintervall som
   databento-planen skulle ha gjort (manifest-jämförelse).
2. Ta bort `databentoDataService` + `databentoFuturesImportService` + tester i
   egen commit (revert-bar).
3. Rensa `DATABENTO_*` ur `.env.example`/docs.
4. Ingen dataflytt behövs — Databento har aldrig skrivit någon data.

## 7. Safety

Datalagret är read-only mot IB: inga order-API:er importeras i data-modulerna.
Alla nya services exponerar samma SAFETY-objekt som övriga systemet:

```text
mode=paper_only, actions_allowed=false, can_place_orders=false,
live_trading_enabled=false, broker_enabled=false
```

Submit-kedjan (interactiveBrokersPaper*) berörs inte av detta arbete.
