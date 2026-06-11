# Prod Backfill Runbook — Alpaca 2m / Data Coverage

> Syfte: fylla historisk candle-data så fler symboler blir **test-redo** (replay/batch)
> i prod, utan trading-risk. Allt nedan är **paper/ingestion-only** — inga ordrar,
> ingen broker, ingen livehandel.

---

## 0. Bakgrund / root cause

- Prod (`/var/www/nasdaq-scanner-prod`) har en **egen separat `data/`-katalog**.
- Warnings `alpaca_import_manifest_missing` + `backfill_jobs_file_missing` betyder att
  dessa filer **inte finns i prods data-dir** — de skapas först när en skarp import
  eller ett backfill-jobb faktiskt körts.
- Backfill är **manuell** — ingen scheduler/cron kör den automatiskt.
- `dataJobsStatusService` är **read-only** och skapar aldrig filerna; den rapporterar bara.

Förväntade filvägar (från `src/services/dataJobsStatusService.js`):

| Vad      | Path |
|----------|------|
| Manifest | `data/market-data/imports/alpaca-2m-imports.jsonl` |
| Jobs     | `data/data-coverage/backfill-jobs-v1.json` |
| Candles  | `data/market-data/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl` |

---

## 1. Readiness-trösklar (källa: `dataCoverageExpansionService.js`)

- **Timeframe:** `2m` (`candles-2m`).
- **replay-ready:** `days_covered ≥ 3` **OCH** `candles ≥ 200`
- **batch-ready / ai-ready:** `days_covered ≥ 10` **OCH** `candles ≥ 500`
- **Kvalitet:** good = `≥20 dagar & ≥1000 candles` · medium = `≥7 & ≥500` · weak = `>0` · missing = `0`
- **Föreslagen range:** aktier/etf **30 dagar**, krypto **45 dagar** (till idag).

> Default-symbolerna `MSFT,QQQ,TSLA,AAPL,NVDA,META,AMZN,AMD` blir "weak" om de bara
> har ~1 dag/~200 candles. För batch-redo: fyll minst ~10 handelsdagar.

---

## 2. Provider-täckning (vad som GÅR att backfilla)

| Marknadsgrupp | Provider | Backfillbar? |
|---------------|----------|--------------|
| US stocks / index / etf / nasdaq100 / sp500 / mag7 | alpaca | ✅ |
| crypto (`*USDT`) | binance | ✅ |
| Avanza-certifikat (`BEAR/BULL/MINI ... AVA`), `STOCKHOLM`, hävstångs-ETF (`TQQQ/SQQQ/SOXL/SOXS`) | — | ❌ `missing_provider` |

> ❌-symbolerna kan **inte** fyllas med nuvarande providers. Readiness kan därför
> aldrig nå 100 % av universet — det är förväntat, inte ett fel.

---

## 3. Säkerhetsregler (läs före körning)

- Kör **alltid dry-run först** (steg 4). Den skriver inget.
- Importservicen har `actions_allowed:false / can_place_orders:false / broker_enabled:false`.
- Coverage-jobb har gränser: `maxSymbolsPerJob 50`, `maxDaysPerJob 60`,
  `maxTimeframesPerJob 3`, `maxActiveJobs 1`, `providerCallDelayMs 350`.
- Kräver `ALPACA_ENABLED=true` + `ALPACA_API_KEY_ID/SECRET` i prods `.env` (rör ej hemligheter).
- Backfill = **endast dataintag**. Det aktiverar aldrig handel.

---

## 4. DRY-RUN (read-only, obligatoriskt först)

```bash
cd /var/www/nasdaq-scanner-prod

# A) Import-plan (skriver inget). Verifiera ok:true, dryRun:true, inga warnings.
node scripts/importAlpacaHistorical2m.js

# B) Read-only coverage + prioritering
node -e "const dc=require('./src/services/dataCoverageExpansionService');
const s=dc.getCoverageStatus();
console.log(JSON.stringify({total:s.symbols_total,ready_replay:s.symbols_ready_for_replay,ready_batch:s.symbols_ready_for_batch,missing:s.symbols_missing_data,weak:s.symbols_weak_data,active_jobs:s.active_backfill_jobs},null,2));"

# C) Via API (om servern kör)
curl -s localhost:3000/api/data-coverage/plan | head
curl -s localhost:3000/api/data-jobs/status | head   # justera port/route vid behov
```

**Stoppkriterier:** om dry-run visar `ALPACA_ENABLED=false` eller
`alpaca_credentials_missing` → fixa `.env` (utanför denna runbook) innan skarp körning.

---

## 5. SKARP backfill (skriver data — kör först efter godkänd dry-run)

### 5a. Aktier/index/etf via Alpaca-import (rekommenderad väg)

Fyller candles + skapar manifest. 30 dagar gör default-symbolerna batch-redo,
DIA + GOOGL fylls från noll:

```bash
cd /var/www/nasdaq-scanner-prod
node scripts/importAlpacaHistorical2m.js \
  --execute \
  --from "$(date -u -d '30 days ago' +%F)" \
  --to "$(date -u +%F)" \
  --symbols MSFT,QQQ,TSLA,AAPL,NVDA,META,AMZN,AMD,DIA,GOOGL
```

Förväntat: per symbol en manifest-rad med `status:"ok"`, `candles_written > 0`.
Verifiera: `tail -n 20 data/market-data/imports/alpaca-2m-imports.jsonl`

### 5b. Crypto via coverage-jobb (binance, 45 dagar)

```bash
# 1) Skapa jobb (skriver backfill-jobs-v1.json)
curl -s -X POST localhost:3000/api/data-coverage/backfill \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT"],
       "timeframes":["2m"],"provider":"binance",
       "from_date":"'"$(date -u -d '45 days ago' +%F)"'","to_date":"'"$(date -u +%F)"'"}'
# → notera job_id

# 2) Kör jobbet (max 1 aktivt åt gången)
curl -s -X POST localhost:3000/api/data-coverage/backfill/<JOB_ID>/run

# 3) Följ status
curl -s localhost:3000/api/data-coverage/backfill/<JOB_ID>
```

---

## 6. Verifiering efter backfill

```bash
cd /var/www/nasdaq-scanner-prod
# Filer ska nu finnas:
ls -la data/market-data/imports/alpaca-2m-imports.jsonl
ls -la data/data-coverage/backfill-jobs-v1.json

# Coverage ska visa fler ready_replay/ready_batch, färre weak:
node -e "const dc=require('./src/services/dataCoverageExpansionService');
const s=dc.getCoverageStatus();
console.log('ready_replay',s.symbols_ready_for_replay,'ready_batch',s.symbols_ready_for_batch,'weak',s.symbols_weak_data,'missing',s.symbols_missing_data);"
```

Mål: de 8 default-symbolerna + DIA + GOOGL → `good`/batch-redo; crypto → `good`.
Kvarvarande `missing_provider` (Avanza/Swedish/hävstång) lämnas — ej backfillbara.

---

## 7. Felsökning

| Symptom | Trolig orsak | Åtgärd |
|---------|--------------|--------|
| `ALPACA_ENABLED=false` i plan | env ej satt i prod | sätt i prods `.env`, starta om processen (utanför denna runbook) |
| `Provider saknar nyckel` i jobb-errors | Alpaca-credentials saknas/fel | kontrollera nycklar (visa ej hemligheter) |
| `max_active_jobs` | redan ett jobb kör | vänta / `…/stop` på gamla jobbet |
| manifest fortf. saknas efter import | körde utan `--execute` | kör om med `--execute` |
| symbol ger `missing_provider` | ingen provider stödjer instrumentet | förväntat — hoppa över |

---

## 8. Vad denna runbook INTE gör

- Ingen `git commit/push/merge/PR`, ingen deploy, ingen `pm2 restart/save`.
- Ändrar inte `.env` eller Nginx.
- Aktiverar aldrig broker/livehandel/order.
- Skapar ingen paper/replay-queue.
- Backfill = endast historiskt dataintag (paper/ingestion-only).
