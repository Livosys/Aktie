# IB Gateway — Operations & Autonomy (Discovery / RCA / Design)

Scope: eliminate manual operations around IB Gateway so Trading OS runs unattended.
The verified trading pipeline (strategy/risk/execution/entry/exit/TP/SL) is **locked**
and out of scope. This document is discovery + root-cause + design, backed by
runtime evidence gathered 2026-07-20.

## 1. Current topology (verified)

| Layer | How it runs today | Automated on boot? |
|---|---|---|
| IB Gateway (GUI, v10.47.1e) | `ibgateway-gui.service` → `ExecStart=/home/ibgateway/ibgateway/ibgateway` as user `ibgateway`, `DISPLAY=:2`, `Restart=always RestartSec=15` | **Yes** (process start) |
| X display + WM | `tigervncserver@2.service` → Xtigervnc `:2` rfbport 5902 + fluxbox | **Yes** |
| Remote view | `ibgateway-novnc.service` → websockify `127.0.0.1:6082 → 5902` (noVNC at `?path=ibgateway-novnc/websockify`) | **Yes** |
| Trading app | `pm2-root.service` resurrects PM2 dump → `nasdaq-scanner` (port 3001) | **Yes** |
| Broker API | IB Gateway TCP `127.0.0.1:4002` (paper) | **Only after login** |
| App ↔ Gateway | `ibPaperExecutionAdapterService` — heartbeat + exponential-backoff reconnect (1s→30s), `reconnectCount`/`lastReconnect`, MD resubscribe on reconnect (6baf057) | **Yes (self-healing)** |
| Health | `interactiveBrokersGatewayHealthService.getGatewayHealth()` — reports gateway process, API-port open, authenticated, connected, VNC, and `nextActionSv` (e.g. "Manuell IBKR-login krävs") | **Yes** |

### Startup sequence (as-is)
```
boot → network-online
     → tigervncserver@2 (X :2 + fluxbox)
     → ibgateway-gui (launches Gateway GUI on :2)  ── shows LOGIN SCREEN, waits ──▶ [MANUAL]
     → ibgateway-novnc (noVNC bridge)
     → pm2-root (nasdaq-scanner app boots, scheduler arms)
          app adapter tries 127.0.0.1:4002 → refused until login → runtime FAILED/DISCONNECTED
          scheduler ticks skip with RUNTIME_NOT_READY (no side effects — safe)
   ── after a human logs in via noVNC ──▶ 4002 opens → adapter auto-connects → runtime READY → scheduler resumes
```

## 2. Root-cause analysis — the one manual step

**Every manual dependency reduces to a single step: the interactive IBKR login at
the Gateway GUI.** Once 4002 is open, the rest of the chain self-heals with no
human action (verified: adapter reconnect + heartbeat; pm2-root; systemd restarts).

| Question | Finding |
|---|---|
| Why does it exist? | `ibgateway-gui.service` only *launches* the GUI; there is **no login automation** (no IBC installed anywhere — verified: no `/opt/ibc`, no `IBController`, no `ibcstart`). |
| Technically necessary? | Authentication is required by IBKR; **manual entry is not** — it can be driven programmatically by IBC. |
| IBKR requirement? | Login yes. 2FA: this is a **paper** account (`DU*`); paper logins generally do **not** trigger IB-Key 2FA, so unattended login is feasible. |
| Automatable? | **Yes** — IBC (IBController) drives the Java GUI to enter credentials and dismiss dialogs; launched by systemd. Industry-standard, permanent. |
| Risk | IBKR credentials must be stored on disk (root/ibgateway-only perms). Bounded: paper account, submission is paper-only and behind the 24-check guard + kill switch. |
| Impact if unfixed | After **any** gateway restart (crash, nightly IB auto-restart, host reboot, update), trading halts silently until someone logs in via noVNC. |

## 3. Solution — permanent autonomous login via IBC (IMPLEMENTED & VERIFIED 2026-07-21)

IBC (IbcAlpha) 3.24.1 now sits between systemd and the Gateway and performs the
login unattended. **Verified with runtime evidence** (see §3a).

Introduce IBC between systemd and the Gateway:

```
boot → tigervncserver@2 → ibc-gateway.service (IBC) ──▶ launches Gateway on :2
     → IBC auto-enters paper credentials (TradingMode=paper) ──▶ API 4002 opens
     → ibgateway-novnc (view only) ; pm2-root (app) ──▶ adapter auto-connects ──▶ READY ──▶ scheduler resumes
```

Concrete steps (implementation gated on user authorization + credentials):
1. Install IBC (matching Gateway 10.47) under `/opt/ibc`.
2. `config.ini`: `IbLoginId`/`IbPassword` (paper), `TradingMode=paper`,
   `IbDir=/home/ibgateway/ibgateway`, `OverrideTwsApiPort=4002`,
   `ReadOnlyApi=no`, `AcceptIncomingConnectionAction=accept`,
   `IbAutoClosedown=no`, `ClosedownAt` aligned to IB nightly restart,
   `ExistingSessionDetectedAction=primary`. File perms `600`, owner `ibgateway`.
3. `ibc-gateway.service` (User=ibgateway, DISPLAY=:2, `Restart=always`,
   `RestartSec=30`) runs `ibcstart.sh`; **disable** the current
   `ibgateway-gui.service` to avoid a duplicate Gateway.
4. Keep noVNC for occasional human inspection / manual 2FA fallback.

### 3a. As-built inventory (files/units created)
- IBC 3.24.1 at `/opt/ibc` (sha256 `d99ee28c…`). Gateway = standalone flat install
  `/home/ibgateway/ibgateway` (v10.47.1e → IBC major `1047`).
- Version bridge symlink: `/home/ibgateway/Jts/ibgateway/1047 → /home/ibgateway/ibgateway`
  (IBC expects `${tws_path}/ibgateway/${ver}`; JRE via `.install4j/pref_jre.cfg`,
  jxBrowserKey auto-extracted from `i4jparams.conf`).
- `/home/ibgateway/ibc/config.ini` — mode `600`, owner `ibgateway`. Paper, port 4002,
  `ReadOnlyApi=no`, `AcceptIncomingConnectionAction=accept`,
  `ExistingSessionDetectedAction=primary`, `IbAutoClosedown=no`, `AllowBlindTrading=yes`.
  Credentials live ONLY here.
- `/etc/systemd/system/ibc-gateway.service` — `User=ibgateway`, `DISPLAY=:2`, waits for
  X, `ExecStart=/opt/ibc/scripts/ibcstart.sh 1047 -g --tws-path=/home/ibgateway/Jts
  --tws-settings-path=/home/ibgateway/Jts --ibc-ini=/home/ibgateway/ibc/config.ini
  --mode=paper`, `Restart=always RestartSec=30`, `StartLimitBurst=5/300s`. **enabled**.
- `/opt/ibc/set-credentials.sh` — secure hidden-prompt credential setter (root).
- Old `ibgateway-gui.service` **disabled** (replaced).

### 3b. Verification evidence (2026-07-21)
- **Cold start:** `systemctl start ibc-gateway` → journal `Login has completed` (00:13:50)
  → `4002` open in ~8s → app adapter auto-reconnected (no app restart) → runtime `READY`,
  scheduler ran a full pipeline tick (`skipped:false`).
- **Gateway-restart auto-relogin:** `systemctl restart ibc-gateway` → full password auth
  `LOGGED_OUT → Authenticating → Login has completed` (00:17:55) → `4002` reopened ~9s →
  runtime self-recovered (00:18:30 full tick). This is the nightly-restart/crash scenario.
- **Ops safety:** single GWClient instance, `NRestarts=0`, no restart/reconnect loop,
  IBC journal + launcher.log small (no log explosion), app never restarted through the
  whole incident (`restart_time` unchanged) — adapter reconnect handled it.
- **Broker reconciliation:** the open MNQU6 position persisted across reconnects and was
  re-discovered (ticks show `max_open_broker_positions`, guard holding).
- **Note:** a wrong password on first entry produced IBC `Unrecognized Username or Password`
  after restart (the first start had succeeded only via a cached autorestart token); after
  correcting the password the full auth succeeded. Avoid rapid repeated restarts — IBKR
  throttles repeated failed logins (`Jts/loginFailFrequency.txt`).

### Safety / ops guards for the design
- Exactly one Gateway launcher (IBC) → no duplicate Gateway / duplicate API session.
- `Restart=always` with a sane `RestartSec` + systemd `StartLimit*` → auto-restart
  without a tight crash loop.
- App side already single-flight and reconnect-throttled → no reconnect storm.
- Rollback: `systemctl disable --now ibc-gateway && systemctl enable --now
  ibgateway-gui` returns to today's manual-login behavior.

## 4. Health monitoring (FAS 6) — status

Already implemented in `getGatewayHealth`: gateway process + command (secret-scrubbed),
API-port open, authenticated, connected, VNC running, readiness status/blockedReason,
and a human next-action string. Gaps to optionally add: reconnect count / last
disconnect / last reconnect / gateway PID+uptime / API+order+MD latency surfaced on
the dashboard (the adapter already tracks `reconnectCount`/`lastReconnect`).

## 5. Incident 2026-07-20 ~23:45 UTC — RESOLVED
Gateway restarted ~23:45 and sat unlogged-in (`4002` refused, runtime `FAILED`).
**Resolved 2026-07-21 00:13–00:18** by the IBC cutover: IBC now auto-logs-in, so the
manual-login gap that caused this incident no longer exists. noVNC remains available as
a human fallback (`?path=ibgateway-novnc/websockify`).

## 6. Maintenance / incident runbook
- **Rotate credentials:** `sudo /opt/ibc/set-credentials.sh` then
  `sudo systemctl restart ibc-gateway`.
- **Gateway stuck / not logged in:** `journalctl -u ibc-gateway -e` (look for
  `Login has completed` vs `Unrecognized Username or Password`); `systemctl restart
  ibc-gateway`. Do not restart repeatedly — IBKR throttles failed logins.
- **Health probe:** `getGatewayHealth()` (gateway process, API-port open, authenticated,
  connected, VNC, next-action). API port check: `ss -ltnp | grep 4002`.
- **Rollback to manual login:** `sudo systemctl disable --now ibc-gateway &&
  sudo systemctl enable --now ibgateway-gui` (then log in via noVNC).
- **Upgrade Gateway:** update the `1047` symlink target/name to the new major version and
  set the version arg in `ibc-gateway.service`.
