# Futures Paper — Autonomous Runtime & Operations

Status: **verified autonomous runtime** (IBKR Paper). This document describes how
the Futures Paper platform runs unattended 24/7, how it recovers, and the
operational preconditions. It is a drift/ops reference — **not** a strategy spec.
Trading decisions (entry/exit/TP/SL/risk) live in the existing services and are
out of scope here.

Verified milestone (runtime evidence, 2026-07-20): a fully organic cycle ran
end-to-end — signal → candidate → strategy → entry contract → risk → 24-check
execution guard → execution-target reservation → intent idempotency → IBKR Paper
adapter → broker accept → entry fill → bracket (TP+SL) → position open → broker
reconciliation → runtime READY. Example: `ORDER_SUBMITTED` 22:03:14 (MNQ,
`mnq_globex_momentum_v1`, parentOrderId 1) → `ORDER_FILLED`/`POSITION_OPENED`
(MNQU6, −1 @ 28748.5). Subsequent ticks correctly blocked on
`max_open_broker_positions` (guard holding).

---

## 1. Components & process topology

- **PM2 app `nasdaq-scanner`** (`/var/www/nasdaq-scanner-prod`, port 3001) — the
  single production runtime. All futures-paper services run in-process.
- **IB Gateway** (`127.0.0.1:4002`, paper) — broker connectivity. Requires a
  manual noVNC login after a Gateway process restart.
- **Futures Autonomous Scheduler** (`src/jobs/futuresAutonomousScheduler.js`) —
  the driver. Adds **no** business logic; it only invokes two already-gated
  production entrypoints per tick.

## 2. Startup

1. `server.js` boots Express, then at the end of startup calls
   `startFuturesAutonomousScheduler()` **only if**
   `ENABLE_FUTURES_AUTONOMOUS_SCHEDULER=true` (`server.js` — the single call
   site).
2. The scheduler logs `SCHEDULER_STARTED`, waits `FUTURES_AUTONOMOUS_STARTUP_DELAY_SECONDS`
   (default 20s) for the runtime to warm up, fires the first `tick()`, then sets
   a `setInterval` at `FUTURES_AUTONOMOUS_INTERVAL_SECONDS` (default 60s).
3. Both timers are `unref()`'d — they never keep the process alive on their own.
4. Idempotent start: `if (intervalTimer || startupTimer) return` — starting twice
   is a no-op (no duplicate schedulers / timer leak).

## 3. Runtime loop (one tick)

`tick()` is **single-flight**: `running` is set before the first `await`, so an
overlapping tick logs `TICK_SKIPPED{already_running}` and returns without side
effects.

1. **Readiness gate** (`evaluateReadiness`, read-only, never mutates). Skips the
   whole cycle *without side effects* if any of: runtime not READY, IB
   disconnected / nextValidId not ready, paper account not verified / live
   account detected, CME session closed, kill switch on, submission disabled,
   shadow mode on. Each skip emits a named event
   (`RUNTIME_NOT_READY`/`IB_DISCONNECTED`/`MARKET_CLOSED`/`KILL_SWITCH_ACTIVE`/
   `SHADOW_MODE_ACTIVE`/`SUBMISSION_DISABLED`).
2. **Producer (sync)** — `futuresPaperScannerService.runScannerOnce()`: IBKR CME
   data → scanner → candidate queue (+ execution-target reservation + scanner
   dedup + stale-candidate prune at ~120s). Synchronous, so `candidates.json` is
   fully persisted before the consumer runs.
3. **Consumer (async)** — `orchestrator.buildShadowExecution({ actualSubmit: true })`:
   candidate → approval → entry contract → broker risk → 24-check execution guard
   → execution-target reservation → intent idempotency → `adapter.submitPaperOrder()`
   → IBKR `placeOrder`.
4. **Observe** — derives `ORDER_FILLED`/`POSITION_OPENED`/`POSITION_CLOSED` from
   the fresh broker snapshot (dedup'd). Observability only; never decides.
5. `TICK_FINISHED` with `{candidatesCreated, submitted, blockedReason, durationMs}`.

The scheduler **cannot bypass** any gate — approval, entry contract, broker risk,
the 24-check guard, candidate-level reservation, order-level intent idempotency,
kill switch, paper-only / shadow-mode / submission flags all remain in the
existing services.

## 4. Order lifecycle & idempotency (two independent locks)

- **Execution-target reservation** — *candidate-level* atomic lock, one file per
  candidateId in `data/futures-paper/execution-target-reservations/`, created with
  an exclusive-create (`wx`) write. Write-once; never read back for a runtime
  decision (the candidate it guards is pruned at ~120s).
- **Intent** — *order-level* idempotency, persistent in
  `data/futures-paper/ibkr-execution/intents.jsonl` + `intent-index.json`. Status
  progression: `intent_created → guard_passed → submit_started → submitted`
  (+`entryFilledOrderId` on entry fill) `→ filled` (on trade close). An open
  trade legitimately sits at `submitted` with `entryFilledOrderId` set until the
  bracket exits.

### Reservation garbage collection (drift fix, 2026-07-20)

Reservation files are write-once and never re-read for a decision, so under 24/7
operation they accumulated without bound (~one per open-market tick). The
reservation service now performs a **throttled, non-fatal, age-based sweep**
(`sweepStaleReservations`): on each reserve (throttled to ≤ once / 5 min) it
deletes reservation files older than `FUTURES_RESERVATION_TTL_MINUTES` (default
120 min, floored at 5 min) — far beyond the ~120s candidate lifetime and any
in-flight order window. The sweep is wrapped so a failure can never affect a
reservation, and it touches no trading decision. This bounds the working set at
steady state.

## 5. Recovery & reconnect

- **PM2 / process restart** — clean (`exit code 0 via SIGINT` on env changes /
  deploys). On restart the scheduler re-arms (`SCHEDULER_STARTED`) and the open
  broker position persists at IBKR; broker reconciliation re-discovers it.
- **IB reconnect** — the adapter resubscribes market data after an IB reconnect
  (fix committed in 6baf057). While disconnected, the readiness gate emits
  `IB_DISCONNECTED` and skips ticks without side effects.
- **Gateway restart** — requires a manual noVNC login (operational precondition).
- **Market closed** — `MARKET_CLOSED` skips; no scan, no submit.

## 6. Dashboard / status data sources

- Live IBKR-paper account/equity/buying-power/positions/pending/broker+runtime
  status come from `orchestrator.buildExecutionStatus()` (broker account summary,
  refreshed when stale via the adapter). Exposed at
  `GET /api/futures-paper/ibkr-paper-execution/status` (admin session required).
- `data/futures-paper/account-state.json` is the **retired internal-sim** SEK
  ledger and is *not* the IBKR dashboard source — do not treat it as broker truth.

## 7. Operational preconditions & controls

- **Env (`.env`)**: `ENABLE_FUTURES_AUTONOMOUS_SCHEDULER=true`,
  `FUTURES_AUTONOMOUS_INTERVAL_SECONDS=60`, `IBKR_PAPER_EXECUTION_ENABLED=true`,
  `IBKR_PAPER_EXECUTION_SHADOW_MODE=false`,
  `IBKR_PAPER_ORDER_SUBMISSION_ENABLED=true`. New (optional):
  `FUTURES_RESERVATION_TTL_MINUTES` (default 120).
- **Kill switch / rollback**: set `ENABLE_FUTURES_AUTONOMOUS_SCHEDULER=false` and
  restart to stop autonomous driving without touching the pipeline. The runtime
  kill switch (`pauseNewEntries`) blocks new entries independently.
- **OPS trap**: `pm2 restart --update-env` caches arming env — re-verify flags
  after a restart.
- IB Gateway needs a manual noVNC login after any Gateway process restart.

## 8. Shutdown

`stopFuturesAutonomousScheduler()` clears both timers and logs `SCHEDULER_STOPPED`.
PM2 `SIGINT` triggers a clean process exit (code 0). Open positions are held by
IBKR and reconciled on next start.
