# IB Gateway Watchdog

Övervakar IB Gateway och Trading OS:s IB-koppling. **Endast övervakning och larm.**

Byggd efter incidenten 2026-07-28, då Gateway satt kvar på inloggningsskärmen i 8,5 timmar
utan att någon märkte det: port 4002 öppnades aldrig och Trading OS körde tyst vidare på
simulerad fallback. Watchdogen finns för att den tystnaden aldrig ska upprepas.

> **Var koden bor:** watchdogen ligger i `/opt/ib-watchdog/`, alltså **utanför** detta repo —
> medvetet, så att den kan larma även när Trading OS ligger nere. Detta dokument är den
> versionshanterade kopian av `/opt/ib-watchdog/README.md`. **Uppdatera båda vid ändring.**

---

## Säkerhetsgarantier

Watchdogen **kan inte** göra något av följande — det finns ingen kodväg för det:

| Garanti | Status |
|---|---|
| Startar aldrig om Gateway, IBC eller Trading OS | ✅ ingen restart-kod |
| Skickar, ändrar eller avbryter aldrig ordrar | ✅ ingen orderkod |
| Skriver aldrig till Trading OS kod, konfig eller state | ✅ endast läsning |
| Ingen självläkning av något slag | ✅ ej implementerad |
| Påverkar inte handelslogiken | ✅ separat process |

Detta exponeras även i klartext på `/status` under `safety`.

> `Restart=always` i systemd-enheten gäller **watchdogen själv**, inte Gateway.
> Om watchdog-processen dör startas den om — Gateway rörs aldrig.

Att lägga till automatisk omstart eller självläkning kräver uttryckligt godkännande
och en medveten ändring i `watchdog.js`.

---

## Arkitektur

Watchdogen är en **fristående process utanför Trading OS**. Det är ett medvetet val:

1. **Noll risk för handelslogiken** — ingen rad Trading OS-kod ändras eller importeras
   utöver den befintliga notifieraren.
2. **Den kan larma när Trading OS självt ligger nere.** En watchdog som bor inuti
   Trading OS tystnar samtidigt som det den ska övervaka.
3. **Egen livscykel** — kan startas om utan att röra handeln.

```
  ib-watchdog.service (root, sandboxad)
      │
      ├─ TCP-probe ────────────────► IB Gateway :4002
      ├─ IB API-handskakning ──────► IB Gateway :4002  (clientId 987, read-only)
      ├─ pgrep + systemctl ────────► ibc-gateway.service
      ├─ HTTP GET ─────────────────► Trading OS :3001  (readiness, price-feed)
      │
      ├─ health-endpoint ──────────► 127.0.0.1:3020  /health  /status
      ├─ JSON-logg ────────────────► /var/log/ib-watchdog/watchdog.log + journald
      └─ larm ─────────────────────► Telegram (Trading OS befintliga notifierare)
```

### Filer

| Fil | Roll |
|---|---|
| `watchdog.js` | Daemon, cykelloop, health-endpoint, CLI |
| `checks.js` | De åtta kontrollerna |
| `alerter.js` | Larmlogik, flap-skydd, tysta fönster |
| `config.js` | Konfiguration (process.env → Trading OS `.env` → default) |
| `logger.js` | JSON-lines-logg |
| `/etc/systemd/system/ib-watchdog.service` | Tjänstedefinition |
| `/etc/logrotate.d/ib-watchdog` | Loggrotation, 14 dagar |

---

## De åtta kontrollerna

Körs var 60:e sekund. Varje kontroll är oberoende — en fallerande kontroll döljer aldrig en annan.

| # | ID | Kontrollerar | Fallerar när |
|---|---|---|---|
| 1 | `gateway_port_open` | TCP-anslutning till 4002 | Porten refuserar eller timeout |
| 2 | `gateway_process_running` | `pgrep` + `systemctl is-active` | 0 instanser, >1 instans, eller unit ej `active` |
| 3 | `ib_api_connection` | Riktig API-handskakning, clientId 987 | Ingen handskakning inom 20 s |
| 4 | `ib_managed_accounts` | `managedAccounts` levereras | Callback uteblir |
| 5 | `ib_next_valid_id` | `nextValidId` levereras | Callback uteblir |
| 6 | `connection_readiness` | `/api/interactive-brokers/connection-readiness` | `ok`, `ibApiVerified`, `gatewayReachable` eller `paperAccountVerified` ≠ true |
| 7 | `runtime_state` | Samma payload | `runtimeState` = `DEGRADED`, saknas, ≠ `READY`, eller `blockedReason=ready_sequence_incomplete` |
| 8 | `simulated_fallback` | `/api/futures-paper/price-feed` | `feed.simulated`/`feed.fallback` = true, simulerad per-symbol-källa, eller simulerade quotes |

Kontroll 3–5 delar **en** IB-anslutning per cykel som öppnas och stängs direkt.
Om port 4002 är stängd hoppas de över och markeras som fallerande med orsak —
det undviker 20 sekunders onödig timeout per cykel.

**Kontroll 2 fallerar även vid fler än en Gateway-instans.** Dubbla instanser ger
konkurrerande sessioner och är en verklig felkälla, inte bara frånvaro av process.

---

## Health-endpoint

Lyssnar på `127.0.0.1:3020` (endast localhost).

### `GET /health`
Kompakt status. **HTTP 200** när allt är grönt, **HTTP 503** annars — direkt användbart
för extern uppwatch eller nginx.

```bash
curl -s http://127.0.0.1:3020/health | python3 -m json.tool
```

```json
{
  "service": "ib-gateway-watchdog",
  "status": "ok",
  "ok": true,
  "lastCheckedAt": "2026-07-28T09:12:03.114Z",
  "lastCheckAgeMs": 8231,
  "failedCount": 0,
  "failed": [],
  "alerting": false
}
```

`status` är `ok`, `failing`, `starting` eller `stale`.
**`stale`** betyder att ingen cykel slutförts på över 3 minuter — då är watchdogen själv
opålitlig och `/health` svarar 503. En watchdog som tyst slutar mäta är värre än ingen alls.

### `GET /status`
Full detalj: alla åtta kontroller med `detail` och `meta`, larmstatus, konfigurerade mål,
drifttid och säkerhetsgarantier.

```bash
curl -s http://127.0.0.1:3020/status | python3 -m json.tool
```

---

## Larm

Går till **befintlig Telegram-kanal** via Trading OS egen `src/alerts/telegramNotifier.js`.
Om den modulen inte kan laddas används en inbyggd reserv mot samma bot och chat —
watchdogen tystnar aldrig bara för att en sökväg ändrats.

### Flap-skydd

| Beteende | Standard | Env |
|---|---|---|
| Cykler i rad med fel innan första larm | 2 | `IB_WATCHDOG_FAILURES_BEFORE_ALERT` |
| Påminnelse medan felet kvarstår | var 30:e min | `IB_WATCHDOG_REALERT_MINUTES` (0 = av) |
| Nytt larm när *uppsättningen* fallerande kontroller ändras | alltid | — |
| Återställningsmeddelande när allt blir grönt | alltid | — |

### Tysta fönster

Gateway startar om automatiskt varje natt och är då nere ~1 minut. Utan skydd hade det
larmat varje natt. Standard är därför `23:43-23:53` (serverns lokaltid).

Under ett tyst fönster loggas fel som vanligt och syns på `/health` — **endast utskicket**
undertrycks, och undertryckandet loggas som `alert_suppressed`.

```bash
IB_WATCHDOG_QUIET_WINDOWS="23:43-23:53,02:00-02:05"   # flera fönster
IB_WATCHDOG_QUIET_WINDOWS=""                          # inga tysta fönster
```

### Larmets utseende

```
🔴 IB GATEWAY WATCHDOG — LARM
Tid: 2026-07-28T09:14:02.881Z
Misslyckade kontroller: 4/8
Cykler i rad med fel: 2

FALLERANDE:
  ✗ gateway_port_open: kan inte ansluta till 127.0.0.1:4002: ECONNREFUSED
  ✗ ib_api_connection: hoppades över: port 4002 är stängd
  ✗ ib_managed_accounts: hoppades över: port 4002 är stängd
  ✗ ib_next_valid_id: hoppades över: port 4002 är stängd

OK: gateway_process_running, connection_readiness, runtime_state, simulated_fallback

Watchdogen gör INGEN automatisk omstart och ingen orderhantering.
Detaljer: curl -s http://127.0.0.1:3020/status
```

---

## Loggar

JSON-lines till `/var/log/ib-watchdog/watchdog.log` **och** journald. Roteras dagligen, 14 dagar.

```bash
journalctl -u ib-watchdog -f                                    # live
tail -f /var/log/ib-watchdog/watchdog.log | jq .                # live, strukturerat
grep '"ok":false' /var/log/ib-watchdog/watchdog.log | jq .      # bara fel
```

Vid fel innehåller `check_cycle` fältet `failures` med **exakt vilken kontroll som fallerade
och varför** — det är den primära forensiska posten:

```json
{"ts":"2026-07-28T09:14:02.881Z","level":"error","event":"check_cycle","ok":false,
 "failedCount":1,"failed":["runtime_state"],
 "failures":[{"check":"runtime_state","detail":"runtimeState=DEGRADED (blockedReason=ready_sequence_incomplete)",
 "meta":{"runtimeState":"DEGRADED","blockedReason":"ready_sequence_incomplete"}}]}
```

Händelser: `watchdog_start`, `http_listening`, `check_cycle`, `alert_sent`,
`alert_suppressed`, `alert_debounced`, `alert_delivery_failed`, `cycle_overlap_skipped`,
`cycle_crashed`, `shutdown`.

---

## Konfiguration

Värden löses i ordningen **process.env → Trading OS `.env` → inbyggd default**.
Trading OS `.env` läses men skrivs aldrig.

| Env | Default | Beskrivning |
|---|---|---|
| `IB_WATCHDOG_INTERVAL_MS` | `60000` | Cykelintervall (kravet är minst varje minut) |
| `IB_WATCHDOG_GATEWAY_HOST` | `IB_GATEWAY_HOST` → `127.0.0.1` | Gateway-host |
| `IB_WATCHDOG_GATEWAY_PORT` | `IB_GATEWAY_PORT` → `4002` | Gateway-port |
| `IB_WATCHDOG_CLIENT_ID` | `987` | Egen clientId — får ej krocka med 1/955/956 |
| `IB_WATCHDOG_GATEWAY_SERVICE` | `ibc-gateway.service` | systemd-unit att kontrollera |
| `IB_WATCHDOG_TRADING_OS_URL` | `http://127.0.0.1:3001` | Trading OS bas-URL |
| `IB_WATCHDOG_TRADING_OS_DIR` | `/var/www/nasdaq-scanner-prod` | För `.env`, `node_modules`, notifierare |
| `IB_WATCHDOG_HTTP_PORT` | `3020` | Health-endpoint |
| `IB_WATCHDOG_HTTP_HOST` | `127.0.0.1` | Bind-adress |
| `IB_WATCHDOG_IB_TIMEOUT_MS` | `20000` | Timeout för IB-handskakning |
| `IB_WATCHDOG_ALERTS_ENABLED` | `NOTIFICATIONS_ENABLED` → `true` | Huvudbrytare för larm |
| `IB_WATCHDOG_LOG_FILE` | `/var/log/ib-watchdog/watchdog.log` | Loggfil |

Visa aktiv konfiguration (lösenord maskeras):

```bash
node /opt/ib-watchdog/watchdog.js --print-config
```

---

## Drift

```bash
systemctl status ib-watchdog          # status
systemctl restart ib-watchdog         # startar om WATCHDOGEN, inte Gateway
systemctl stop ib-watchdog            # stoppar övervakningen (Gateway påverkas ej)
journalctl -u ib-watchdog -n 50       # senaste loggarna
```

---

## Testning

Alla tester nedan är **ofarliga** — de rör varken Gateway, Trading OS eller handeln.

### 1. Engångskörning mot skarpt system

```bash
node /opt/ib-watchdog/watchdog.js --once
```

Kör **en** cykel, skriver hela resultatet som JSON och avslutar med
**exit 0** om allt är grönt, **exit 1** om något fallerar.
`--once` skickar aldrig larm — det är rent för felsökning och för CI.

Kompakt sammanfattning:

```bash
node /opt/ib-watchdog/watchdog.js --once | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok =', d['ok'], '| failed =', d['failed'])
for k,v in d['checks'].items():
    print(f\"  {'OK  ' if v['ok'] else 'FAIL'} {k:26} {v['detail']}\")
"
```

### 2. Framtvinga fel utan att röra Gateway

Peka watchdogen mot en port där ingenting lyssnar. Den riktiga Gateway påverkas inte.

```bash
# Kontroll 1, 3, 4, 5 ska fallera — övriga förbli gröna
IB_WATCHDOG_GATEWAY_PORT=4999 IB_WATCHDOG_IB_TIMEOUT_MS=4000 \
  node /opt/ib-watchdog/watchdog.js --once
```

Förväntat: `failed = ['gateway_port_open','ib_api_connection','ib_managed_accounts','ib_next_valid_id']`, exit 1.

```bash
# Kontroll 6, 7, 8 ska fallera — övriga förbli gröna
IB_WATCHDOG_TRADING_OS_URL=http://127.0.0.1:3999 \
  node /opt/ib-watchdog/watchdog.js --once
```

Förväntat: `failed = ['connection_readiness','runtime_state','simulated_fallback']`, exit 1.

Att de två testerna ger **disjunkta** felmängder bevisar att kontrollerna är oberoende.

### 3. Testa larmkanalen

Skickar ett tydligt märkt testmeddelande till Telegram:

```bash
node /opt/ib-watchdog/watchdog.js --test-alert
```

### 4. Testa hela larmkedjan end-to-end

Kör en tillfällig instans mot fel port, med snabbt intervall och larm efter första felet.
Använder egen HTTP-port så den skarpa instansen inte störs.

```bash
IB_WATCHDOG_GATEWAY_PORT=4999 \
IB_WATCHDOG_IB_TIMEOUT_MS=3000 \
IB_WATCHDOG_INTERVAL_MS=10000 \
IB_WATCHDOG_FAILURES_BEFORE_ALERT=1 \
IB_WATCHDOG_HTTP_PORT=3021 \
IB_WATCHDOG_QUIET_WINDOWS="" \
IB_WATCHDOG_LOG_FILE=/tmp/watchdog-test.log \
  node /opt/ib-watchdog/watchdog.js
```

Verifiera i en andra terminal, avbryt sedan med `Ctrl-C`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3021/health   # ska ge 503
curl -s http://127.0.0.1:3021/status | python3 -m json.tool
```

Ett larm ska ha kommit till Telegram. **Sätt `IB_WATCHDOG_QUIET_WINDOWS=""`** vid test —
annars undertrycks larmet om du råkar testa under det nattliga fönstret.

### 5. Verifiera health-endpointens statuskoder

```bash
curl -s -o /dev/null -w 'health: %{http_code}\n' http://127.0.0.1:3020/health   # 200 när grönt
curl -s -o /dev/null -w 'status: %{http_code}\n' http://127.0.0.1:3020/status   # 200 när grönt
```

Båda ska svara **503** när någon kontroll fallerar.

### 6. Verifiera att clientId inte krockar

```bash
ss -ntp | grep ':4002' | grep node
```

Under en cykel syns watchdogens anslutning kortvarigt. Trading OS ska behålla
sina två anslutningar (clientId 1 och 955) oavbrutet.

---

## Felsökning

| Symptom | Trolig orsak | Åtgärd |
|---|---|---|
| `auth_credentials_missing` | `.env` saknar `DASHBOARD_PASSWORD` eller kan ej läsas | Kontrollera `--print-config` och att tjänsten kör som root |
| `ib_library_unavailable` | `@stoqey/ib` saknas i Trading OS `node_modules` | Kontrollera `IB_WATCHDOG_TRADING_OS_DIR` |
| Alla IB-kontroller fallerar men Gateway lever | Gateway inloggad men API-porten ej öppnad | Se `journalctl -u ibc-gateway` — sannolikt kvar på inloggningsskärmen |
| `gateway_process_running`: >1 instans | Dubbelstartad Gateway | Undersök innan något stoppas — konkurrerande sessioner |
| Larm kommer inte fram | Tyst fönster, eller `NOTIFICATIONS_ENABLED=false` | `grep alert_suppressed` i loggen |
| `status: stale` | Cykler slutförs inte | `journalctl -u ib-watchdog` — leta `cycle_crashed` |

### Känd felmod: "stale re-login"

Om kontroll 1 och 3–5 fallerar medan kontroll 2 är grön har Gateway sannolikt fastnat
på inloggningsskärmen efter den nattliga omstarten. Signatur i
`/home/ibgateway/Jts/launcher.log`:

```
WARN [JTS-DeadlockMonitor-2] - instance of control is not created yet
```

Åtgärd är en **ren omstart** — `systemctl restart ibc-gateway.service` — inte ett
lösenordsbyte. Se [IB_GATEWAY_OPERATIONS.md](IB_GATEWAY_OPERATIONS.md).

**Watchdogen utför inte denna åtgärd automatiskt.** Den larmar och stannar där.
