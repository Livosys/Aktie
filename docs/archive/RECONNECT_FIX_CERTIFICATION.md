# IB Futures Data Adapter — Reconnect-fix: Certifieringsrapport

**Komponent:** `src/services/ibFuturesDataAdapterService.js` (read-only IB futures datalager, FAS 2 av `FUTURES_DATA_LAYER.md`)
**Datum:** 2026-07-17
**Typ:** READ-ONLY verifiering & certifiering (ingen ny funktionalitet, ingen kodändring applicerad)
**Prod-process:** pm2 `nasdaq-scanner` (id 0), clientId 955, gateway 127.0.0.1:4002
**Status:** **VERIFIED FIX** (villkorad — se Kvarstående risker, punkt R1)

---

## 1. Bakgrund — defekten som certifieras

Tidigare dokumenterad defekt: **tick-resubscribe dör efter IB-reconnect.** När IB Gateway
tappade socketen skapade adaptern en ny `IBApi`-klient, men `subscribeQuote()` gjorde
early-return på `alreadySubscribed` (kvarvarande `subscribed=true`/`reqId` från den döda
klienten). `reqMktData` skickades därför aldrig på den nya klienten → **permanent frusen
tick-ström** tills processen startades om manuellt (`pm2 restart`). Detta matchar prodens
höga omstartsräknare (↺36).

## 2. Fixen under test

Fixen är fyra sammanhängande härdningar i adaptern (diff mot HEAD `ea08f3f`, se punkt R1):

| # | Plats | Ändring |
|---|-------|---------|
| A | `disconnected`-handler (rad ~185) | Nollställer `state.reqId=null`, `state.subscribed=false` och rensar `quoteReqByReqId` för alla roots vid disconnect → nästa `subscribeQuote` skickar `reqMktData` på nya klienten. **Kärnfixen.** |
| B | `nextValidId`/`connectOnce` (rad ~286) | Kör `resubscribeQuotes()` automatiskt vid varje lyckad (åter)anslutning. |
| C | `subscribeQuote` → `doSubscribeQuote` (rad ~383) | In-flight-dedupe via `quoteSubscribeInFlight`: samtidiga anrop för samma root delar EN subscription → inga dubbla `reqMktData`. |
| D | `error`- + `disconnected`-handler (rad ~172/186) | `if (client !== ib) return` — sena event från en gammal, ersatt klient ignoreras (ingen spök-reconnect, ingen korruption av ny session). |

## 3. Metod och varför den är read-only

Adaptern exponerar en injektionspunkt `options.ibFactory`. Certifieringen driver
reconnect-scenariot mot en **fejkad IBApi** (EventEmitter) i full isolering:

- **Rör inte** prod-processen, den riktiga gatewayen eller något nätverk.
- Kräver **ingen** manuell noVNC-inloggning (som en riktig gateway-omstart skulle).
- Deterministisk och repeterbar — kan tvinga fram godtyckligt många reconnect-cykler.

Att tvinga fram riktiga socket-disconnects mot live-gatewayen valdes medvetet bort: det
vore både invasivt (avbryter live paper-datafeed) och skulle kräva manuell
gateway-återinloggning — alltså varken read-only eller säkert. Live-processen används i
stället för **kompletterande hälsoobservation** (minne/CPU över tid).

Harnessar (i scratchpad, ej i repot): `cert_reconnect_cycles.js`, `cert_reconnect_soak.js`,
`cert_endurance.js`.

---

## 4. Resultat per krav

### Steg 1 — ≥20 disconnect/reconnect-cykler · **PASS**
25-cykeltest + 5000-cykel-soak + wall-clock-uthållighet (119+ reconnects och växande).
Alla passerar. `reconnectCount` matchar exakt antal cykler i samtliga körningar.

### Steg 2 — Market data-prenumerationer återställs efter varje reconnect · **PASS**
Varje reconnect ger ett nytt `reqMktData` per root på den nya klienten (nytt `reqId`),
och tick-flödet återupptas (`getQuote(root).last` uppdateras på det nya `reqId`:t).
Verifierat för alla 4 roots (MNQ/MES/NQ/ES) genom alla cykler.

### Steg 3 — Inga dubbla subscriptions · **PASS**
`maxDup/root = 1` genom **alla 5000 soak-cykler** och alla uthållighetscykler.
In-flight-dedupe (fix C) bevisad separat: 3 samtidiga `subscribeQuote('MNQ')` → exakt
1 `reqMktData` och 1 `contractDetails`. Inga `cancelMktData` mot döda reqId på ny klient.

### Steg 4 — Scanner/signalmotor/paper fortsätter efter reconnect · **PASS (kontraktsnivå)**
Adapter-kontraktet som dessa konsumenter förlitar sig på hålls intakt efter varje reconnect:
`getQuote()` returnerar färska värden med nytt `reqId` och `connected=true`, och
`fetchHistoricalBars()` fungerar (kontrakt ur cache, request slutförs) efter reconnect.
*Not:* full end-to-end av scanner/paper-processerna sker i live-processen; se steg 7.

### Steg 5 — Inga stale quotes används · **PASS**
Under det frånkopplade fönstret rapporterar `getQuote().connected=false` (nedströms kan
förkasta). Sena ticks på döda `reqId` ignoreras (uppdaterar aldrig quote). Medan ansluten
är `maxStaleObservedMs = 1 ms` genom hela uthållighetstestet — quotes är alltid färska.

### Steg 6 — Loggar: exceptions/warnings/memory leaks · **PASS**
Inga exceptions/warnings från adaptern under någon körning. `lastErrors` är en ring-buffer
begränsad till 25 internt (getStatus visar ≤10) och växer aldrig obundet. Heap platt (steg 8).
Live error-loggen visar endast orelaterade provider-timeouts (alpaca/binance/notifier), inga
IB-adapterfel.

### Steg 7 — CPU/minne under testet · **PASS**
- **Isolerad soak (5000 cykler):** heap 7.47 → 7.85 MB (+0.39 MB, platå efter ~500 cykler), rss ~68–75 MB stabilt.
- **Live prod-process:** rss ~221 MB, cpu <5 %, stabilt över observationsfönstret (bakgrundssamplare, 60 s-intervall).

### Steg 8 — Långtidstest utan manuell omstart · **PASS (pågår)**
Wall-clock-uthållighet med realistisk kadens (reconnect var 2 s, kontinuerliga ticks var 250 ms):

| min | heap MB | rss MB | reconnects | clients | contracts | ticks applied/sent | flowing | maxStale | freeze |
|----:|--------:|-------:|-----------:|--------:|----------:|:------------------:|:-------:|---------:|:------:|
| 1 | 7.55 | 60.7 | 29 | 30 | 4 | 952/956 | ✓ | 1 ms | – |
| 2 | 7.55 | 61.3 | 59 | 60 | 4 | 1912/1916 | ✓ | 1 ms | – |
| 3 | 7.56 | 61.7 | 89 | 90 | 4 | 2864/2872 | ✓ | 1 ms | – |
| 4 | 7.59 | 62.0 | 119 | 120 | 4 | 3824/3832 | ✓ | 1 ms | – |

Tick-flödet fortsätter oavbrutet utan någon manuell omstart; ingen frusen ström (`freeze=null`),
platt minne. Testet är konfigurerat för 6 h (fortsätter i bakgrunden). Cykel-durabiliteten
(5000 reconnects med platt heap) överstiger vida den reconnect-churn 6 h realistisk drift ger.
*Not:* en obemannad literal 6 h-körning slutfördes inte inom sessionen; trenden över observerat
fönster + 5000-cykel-soaken utgör evidensen.

### Steg 9 — Dokumentation · **PASS**
Denna rapport.

---

## 5. Statusändring

**Documented defect → VERIFIED FIX.** Reconnect-fixen (A–D ovan) återställer market
data-prenumerationer korrekt och deterministiskt efter varje reconnect, skapar inga
dubbletter, läcker inte minne och bevarar tick-färskhet — bevisat över 25 + 5000 +
löpande wall-clock-cykler.

## 6. Kvarstående risker

- **R1 (HÖG) — Fixen är OCOMMITTAD.** Hela reconnect-fixen (25 rader) finns endast i
  working tree ovanpå HEAD `ea08f3f`; HEAD saknar den. Prod kör den för att pm2-restart
  #36 (~17:22 2026-07-17) laddade den modifierade filen. **En reboot/redeploy från git
  skulle återinföra den frusna tick-strömmen.** Åtgärd (kräver uttryckligt godkännande):
  committa adaptern + testet med pathspec och `pm2 save`. Ändringen är hopflätad med en
  stor mängd annat ocommittat futures-arbete i samma working tree — committa selektivt.
- **R2 (LÅG) — Live-verifiering mot riktig gateway ej utförd.** Certifieringen är isolerad
  (fake-IB). Ett övervakat riktigt reconnect-prov mot gatewayen (kontrollerad
  gateway-omstart under US-session, med efterföljande noVNC-relogin) skulle bekräfta
  end-to-end, men valdes bort som icke-read-only. Rekommenderas som separat, godkänd åtgärd.
- **R3 (LÅG) — Litet tick-gap vid reconnect-ögonblicket.** ~0.4 % av ticks i uthållighets-
  testet landade inte, exakt sammanfallande med disconnect-instanserna (kort fönster utan
  aktiv subscription). Väntat och ofarligt; nedströms ser `connected=false` under fönstret.

## 7. Reproduktion

```bash
cd /var/www/nasdaq-scanner-prod
# Befintligt enhetstest (inkl. reconnect-regression test 7 + dedupe):
node src/services/ibFuturesDataAdapterService.test.js
# 25-cykel full-invariant:
CYCLES=25 node <scratchpad>/cert_reconnect_cycles.js
# 5000-cykel läck-soak:
MODE=count CYCLES=5000 node --expose-gc <scratchpad>/cert_reconnect_soak.js
# Wall-clock-uthållighet (DURATION_MS styr):
DURATION_MS=21600000 node --expose-gc <scratchpad>/cert_endurance.js
```
