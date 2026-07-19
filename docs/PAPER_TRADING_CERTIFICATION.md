# Paper Trading — End-to-End Certifieringsrapport

**Omfattning:** Hela handelskedjan signal → avslutad trade för Futures Paper / IBKR Paper Execution
**Datum:** 2026-07-17
**Typ:** READ-ONLY verifiering & certifiering (inga nya funktioner, inga fixar applicerade utan godkännande)
**Branch/commit:** `lab-batch-runnability-ui` @ `6baf057` (working tree har omfattande ocommittat futures-arbete — se Risk R5)
**Testsvit:** 27/27 testfiler gröna i paper-kedjan

---

## Sammanfattande bedömning

> ### SLUTBEDÖMNING: **CONDITIONALLY READY (för PAPER PRODUCTION)**
> Kedjans logik är arkitektoniskt robust och bevisad av 27 gröna testsviter + en verklig
> end-to-end IBKR-paper-trade (`fxp_0ce0ef7138e5c96b`, 2026-07-17). Order-submission är
> **för närvarande hårdstängt** (shadow/preview) och endast ETT verkligt avslut finns.
> **EJ READY FOR LIVE** — live-order till skarpt konto är hårdblockerat i design och helt obevisat.

**Kritisk säkerhetspostur (verifierad i `.env` + `ibPaperExecutionConfigService`):**
`IBKR_PAPER_EXECUTION_ENABLED` ej satt → `executionEnabled=false`; `shadowMode=true` (default);
`IBKR_PAPER_ORDER_SUBMISSION_ENABLED` ej satt → `false`; `IB_PAPER_SUBMIT_ROUTES_ENABLED=false`.
Effektiv submission = **false**. Guarden kräver dessutom att **alla** live-flaggor är false.

---

## Metod

- **Read-only.** Ingen kod ändrad. Bevis hämtas ur (a) kedjans befintliga testsviter (fristående
  `node`-körningar), (b) riktad källkodsläsning av gate-/PnL-/reconciliation-logik, (c) en
  isolerad långtidssimulering av ledger-motorn i temp-dir (rör ej prod-data).
- **Två paper-lager, viktig distinktion:**
  1. **IBKR Paper Execution** (riktigt IB paper-broker-konto DU***596) — produktionsvägen. Gate:ad av `ibPaperExecutionGuardService` + `ibPaperBrokerRiskService`.
  2. **Intern simulerings-ledger** (`futuresPaperLedgerService`) — **RETIRED i prod** (commit `edb89c6`); `open/close/mark/reset` returnerar `internal_futures_simulation_retired`. Bär PnL-/fee-matematiken (testbar) men skapar inga positioner i prod.

---

## Steg-för-steg

### Steg 1 — Signalgenerering · **PASS**
- **Bevis:** `futuresPaperScannerService.test.js` + `.familyGate.test.js` gröna. Signaler
  gate:as av family-gate (`ema_trend_family`, `nextAllowedAt` vid block), strategy-cooldown,
  `broker_is_not_allowed`/`live_trading_is_not_allowed`, och kräver `real_market_data`
  (offline-fixtures endast i test). Orchestratorns `normalizeCandidate` kräver
  `closedCandleConfirmed`/`signalStatus='ready'`. Server-sidans kandidat är auktoritativ
  (klient-input ignoreras — se steg 3).
- **Falska signaler:** blockeras — ingen entry utan bekräftad stängd candle + godkänd familj/strategi.
- **Risk:** ingen ny.

### Steg 2 — Riskmotor · **PASS**
- **Bevis:** `ibPaperBrokerRiskService.test.js` + guard-läsning (`ibPaperExecutionGuardService.js`).
- **Positionsstorlek:** hårdlåst — `quantity_must_be_exactly_one` (1 micro-kontrakt); klient-quantity `99`→`1` (orchestrator-test).
- **Max risk / caps:** `max_open_broker_positions`, `spread_within_limit`, symbol-allowlist.
- **Dagliga limiter/caps:** family-gate + strategy-cooldown (30 min) + consecutive-loss-fönster (`consecutiveLossWindowService.test.js`).
- **Kill switch:** guardens `system_not_paused`-check läser `configService.readKillSwitch().pauseNewEntries` → `pause_new_entries_active` blockerar alla nya entries.
- **Datafärskhet:** `account_summary_stale`, `quote_not_realtime_ibkr` (blockerar delayed/simulerad), `reconciliation_degraded`.
- **Risk R1 (LÅG):** `executionSafetyService` (bredare kill switch) är inkopplad i scanner/daytrading/api men **inte** i IBKR-exec-guarden — exec-vägen har sin egen `pauseNewEntries`. Två separata kill switch-mekanismer; verifiera att UI:t manövrerar rätt en.

### Steg 3 — Orderskapande · **PASS**
- **Bevis:** `ibPaperExecutionAdapterService.test.js` (`buildOrderPlan`).
- **Rätt instrument:** kontrakt-validering (FUT/CME/USD/conId/giltig expiry/ej continuous).
- **Rätt sida:** long→BUY entry / SELL exit; short→SELL entry / BUY exit.
- **Rätt antal:** exakt 1; fraktion (`0.1`)→`quantity_must_be_exactly_one`.
- **Rätt nivåer:** bracket med tick-avrundning till 0.25 (stop `28782.59`→`28782.5`, target `28524.32`→`28524.25`); `take_profit_required` om target saknas; entry/TP/SL delar OCA-grupp.

### Steg 4 — Orderflöde (exactly-once) · **PASS**
- **Bevis:** adapter- + orchestrator- + guard-tester.
- **Exakt en gång:** intent-status persisteras **före** `placeOrder`; om persist fallerar → `submit_started_persist_failed` och **0 order lagda**. Idempotency-nyckel + `duplicate_intent`-block. Race: duplicate `createIntent` → `updateStatus` körs aldrig.
- **Inga dubbletter:** `submitCalls===0` vid blockerad/duplicerad; `expectedOrderIds=[9000,9001,9002]` registreras.
- **Execution-evidence:** fingerprint krävs; `missing`/`fingerprint_mismatch`/`expired` blockerar alla submit → skydd mot replay/tampering.
- **Timeout:** connect-timeout + request-timeout hanteras (reconnecting-state), reconciliation-timeout → degraded.
- **Retry:** exec-runtime reconnect med backoff (`reconnectCount>=1`, ny klient) — se separat [reconnect-certifiering](RECONNECT_FIX_CERTIFICATION.md).

### Steg 5 — Fill-hantering · **PASS**
- **Bevis:** adapter-test.
- **Partiella:** `normalizeIbStatus('Submitted',filled=0.5,rem=0.5)`→`partially_filled`; orderStatus-event verifierat.
- **Fulla:** `Filled`,rem=0 → `filled`.
- **Avvisade:** IB error 321 (Read-Only) → intent `rejected`, `ibkr_order_rejected`, `ibErrorCode=321`, `rejectedOrderId`.
- **Cancellerade:** ägd order → cancel ok (`cancelOrderCalls=[9000]`); ej ägd → `order_not_owned_by_ibkr_paper_execution`; shadow-mode → `shadow_mode_active_no_cancel`.

### Steg 6 — Positionshantering · **PASS**
- **Bevis:** `futuresPaperLedgerService.test.js` (öppna/uppdatera/stäng, `totalOpen`/`totalClosed`), `ibPaperBrokerReconciliationService.test.js`.
- **Öppnas/uppdateras/stängs:** verifierat i ledger (open→mark→close, exposure/margin/equity).
- **Ingen ghost position:** reconciliation upptäcker `internal_order_missing_at_ib` (lokal utan broker), `ib_order_missing_locally` (broker utan lokal), `unprotected_position` (position utan skydd) → degraderat läge blockerar nya entries.

### Steg 7 — Exit-logik · **PASS (med not)**
- **Stop Loss / Take Profit:** bracket STP + LMT i OCA-grupp — hittas på broker-sidan (adapter-test). SL-benet transmit=true (aktiverar hela bracketen atomiskt).
- **Time exit:** pre-entry-färskhet `candidate_fresh` (ageMs≤maxSubmitAgeMs, default 120000)→`stale_signal`; öppen-positions-tidsexit i den retirerade sim-motorn (exitReason `rth_exit`/`manual_close`).
- **Emergency exit:** `cancelPaperOrder` (ägd order) + kill switch `pauseNewEntries`. **Not R2 (MEDEL):** ingen dedikerad "flatten-all/emergency-close"-funktion för öppna positioner i exec-vägen bekräftad — emergency = broker-bracket (OCA) + manuell cancel. Verifiera att en enknapps-nödstängning finns eller dokumentera manuell procedur.

### Steg 8 — Ledger & PnL · **PASS**
- **Bevis:** `futuresPaperLedgerService.test.js` + `futuresPaperFees.test.js`.
- **Realiserad PnL:** net = gross − totala fees; ex MNQ 10p×$2=$20 brutto, fees $2.44, net $17.56 = 184.38 SEK.
- **Orealiserad PnL:** `unrealizedPnlUsd/Sek` mark-to-market på öppna positioner.
- **Courtage/avgifter:** dras vid open (entry-fee) + close (exit-fee). MNQ/MES $1.22/side ($2.44 RT); NQ/ES $2.25/side ($4.50 RT). Okänt kontrakt→`invalid_root`.
- **Statistik:** cash/equity/exposure/margin/totalFees + `FUTURES_POSITION_OPENED/CLOSED`-events + trades.jsonl persisteras. FX 10.5 SEK/USD.

### Steg 9 — Recovery · **PASS**
- **Bevis:** `futuresPaperStorageService.test.js`, reconciliation-test, reservation-test.
- **Restart under öppen position:** state (positions/trades/account/reservationer) persisteras till disk och läses tillbaka; reservationer + queue överlever restart (FAS17-minne).
- **Reconnect under öppen position:** exec-runtime reconnectar med backoff och verifierar `nextValidId`/paper-konto; degraderad reconciliation blockerar nya entries tills verifierat.
- **Ingen dataförlust / state återställs:** `submit_started`-intent utan broker-order → `unknown_submit_state` fångas av reconciliation (crash mid-submit). Fail-safe: okänt broker-läge ⇒ `newEntriesAllowed=false`.

### Steg 10 — Långtidstest · **PASS (med LÅG-fynd)**
- **Test:** `cert_paper_longrun_fast.js` — **1000** open/close-cykler genom den riktiga
  ledger/account/PnL/fee-motorn för alla fyra instrument (MNQ/MES/NQ/ES), i bundna batcher
  (färsk ledger per 50 trades) så den retirerade sim-motorns O(n²)-artefakt inte dominerar;
  processens heap mäts över hela körningen. Isolerade temp-dirs, rör ej prod-data.
- **Resultat (loggutdrag):**
  ```
  trade  1000  heap=4.76MB  rss=116MB  wins=446 losses=554 ghost=0  feeOk=1000 netOk=1000
  ghost positions : 0        fee-matematik ok : 1000/1000   net-matematik ok : 1000/1000
  baseline heap 3.97 MB → slut 4.75 MB (tillväxt 0.78 MB); första/sista halvan 5.18/4.72 MB
  tid 101.5 s (~101 ms/trade, jämn takt)
  ```
  - **Minnesläcka:** ingen — heap platt (+0.78 MB), sista halvan *lägre* än första (GC-sågtand).
  - **CPU-stabilitet:** jämn takt hela körningen; ingen accelererande kostnad.
  - **Ingen degradering:** 0 ghost positions genom alla 1000; PnL/fee-matematik exakt (net=gross−fees, per-root-avgift, SEK-konvertering) i **1000/1000** trades.
- **Fynd R3 (LÅG):** en *singel-ledger*-körning (`cert_paper_longrun.js`) avslöjade att ledgerns
  `writePositions` skriver om hela den växande `closed`-arrayen per stängning → **O(n²) disk-I/O**
  (positions.json ~1 MB vid 224 trades, ~100 ms→sekunder/trade). Endast i den **retirerade**
  interna sim-motorn; prod-IBKR-vägen appendar till `trades.jsonl` (O(1)) och berörs ej. Ingen
  minnesläcka. Minimal fix (endast om sim återaktiveras): flytta stängda trades ur positions.json
  till append-only-logg. **Ingen fix applicerad.**

---

## Kvarstående risker

| # | Sev | Risk | Åtgärd |
|---|-----|------|--------|
| R1 | LÅG | Två separata kill switch-mekanismer (exec-guard `pauseNewEntries` vs `executionSafetyService`) | Verifiera att ops-UI:t manövrerar exec-vägens switch |
| R2 | MEDEL | Ingen bekräftad dedikerad emergency-flatten för öppna exec-positioner | Bekräfta eller dokumentera manuell nödstängningsprocedur |
| R3 | LÅG | O(n²) positions.json-skrivning i retirerad sim | Ingen prod-påverkan; fix endast om sim återaktiveras |
| R4 | MEDEL | Endast **ett** verkligt IBKR-paper-avslut; submission gated off | Övervakad paper-pilot med fler verkliga avslut innan skarp paper-produktion |
| R5 | HÖG (drift) | Stor ocommittad working tree (~52 futures-filer) — reproducerbarhet/deploy-risk | Committa selektivt eller frys ett känt-gott träd |

---

## Slutbedömning (motiverad)

- **NOT READY** — nej: kärnlogiken är test-bevisad och ett verkligt avslut finns.
- **CONDITIONALLY READY (för PAPER PRODUCTION)** — **JA.** Villkor: (a) övervakad paper-pilot
  med fler verkliga avslut (R4), (b) bekräftad nödstängningsprocedur (R2), (c) frys ett
  känt-gott kodträd (R5).
- **READY FOR PAPER PRODUCTION** — inte fullt ut ännu; blockeras av R4 (endast ett verkligt avslut) + R2/R5.
- **READY FOR LIVE** — **NEJ.** Live-submission är hårdblockerad i design (guardens `live_flags_false`,
  submit-routes off) och helt obevisad. Ingen evidens stödjer live.

## Reproduktion
```bash
cd /var/www/nasdaq-scanner-prod
for t in futuresPaper ibPaper paperTrading riskEngine strategyTradeControl consecutiveLoss; do
  for f in src/services/*$t*.test.js; do node "$f"; done; done      # 27/27 gröna
node --expose-gc <scratchpad>/cert_paper_longrun.js                  # steg 10 (TRADES=1000)
```
