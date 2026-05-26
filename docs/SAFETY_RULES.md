# Safety Rules

This scanner is intentionally conservative. The system can produce watch modes,
scores, labels, and explanations, but it does not place trades or create orders.

## Hard-Block Conditions

These conditions must remain hard safety constraints across the whole pipeline:

- Three Finger Spread (`threeFingerSpread.active === true`)
  - Meaning: price and SMA structure are too stretched; do not chase.
  - Hard cap: `tradeScore <= 10`.
  - Learning boosts must be disabled or capped after this condition.
- Breakout Already Occurred (`breakoutAlreadyOccurred === true`)
  - Meaning: the move has already moved too far from the valid zone.
  - Hard cap: `tradeScore <= 20`.
  - Learning boosts must not make this a fresh entry.
- Confidence Engine block (`autoFilter.blocked === true`)
  - Meaning: confidence/risk checks blocked the setup.
  - Hard cap: `tradeScore <= 20`.
  - Later engines must respect this.
- `NO_TRADE`, `WIDE_AVOID`, and `THREE_FINGER_SPREAD_AVOID`
  - These are not entry states. They may carry explanations and watch context,
    but should not be converted into order-like actions.

## Where Hard Caps Are Enforced

Hard caps are applied or reapplied in multiple places:

- `narrowState.js`
  - Creates TFS, Breakout Already Occurred, avoid states, and base penalties.
- `scoreBreakdown.js`
  - Applies hard caps during Engine v3 score breakdown.
- `confidenceEngine.js`
  - Adds blocker metadata and caps TFS to 10 and BOC to 20.
  - Builds `autoFilter`.
- `mtf.js`
  - Sets MTF adjustment to 0 when TFS, BOC, or `autoFilter.blocked` is active.
- `adaptiveEdgeEngine.js`
  - Reapplies caps after adaptive score changes.
- `ruleMemoryEngine.js`
  - Hard-blocked signals receive metadata only; no boost.
- `symbolPersonalityEngine.js`
  - Hard-blocked signals receive metadata only; no boost.
- `regimeProfileEngine.js`
  - Hard-blocked signals receive metadata only; no boost.
- `scoreCalibrationEngine.js`
  - Hard-blocked signals receive metadata only; no score change.
- `fakeoutDnaEngine.js`
  - Hard-blocked signals get no fakeout adjustment and caps are reapplied.
- `preMoveEngine.js`
  - Hard-blocked signals can receive context, but `preMoveWatchMode=false`.
- `learningOrchestrator.js`
  - Reapplies hard caps after combining learning adjustments.
- `confidenceDecayEngine.js`
  - Reapplies hard caps after decay penalties.

## Learning Engine Safety Contracts

Learning engines may add metadata, context, explanations, warnings, or conservative
score adjustments. They must not:

- Change a hard-blocked signal into a buy/sell signal.
- Override Three Finger Spread, Breakout Already Occurred, or `autoFilter.blocked`.
- Create automatic orders.
- Remove the watch/manual-review nature of watch-mode signals.
- Apply positive boosts to hard-blocked signals unless the score is still capped
  correctly and the engine contract explicitly allows it.

## Watch Mode Is Not Automation

Several engines can produce watch-mode fields:

- `ruleMemoryEngine.js`
- `momentumContinuationEngine.js`
- `liquiditySweepEngine.js`
- `preMoveEngine.js`
- `alertEngine.js` alert derivation helpers

Watch mode means manual review. It is not permission to trade automatically.

## Alert Engine Safety

`src/alerts/alertEngine.js` can persist, dedupe, acknowledge, and derive alerts.
It is wired into `/api/system/health`, `/api/alerts`, and
`/api/alerts/acknowledge`.

- Do not let alerts create orders.
- Keep dedupe behavior to avoid repeated alert floods.
- Preserve acknowledgement state in `data/alerts/alerts.jsonl`.
- Keep alert severity informational/watch/warning/critical, not execution logic.
- Health-derived alerts should remain diagnostic.

## Authentication And Access Safety

- `/health` is intentionally open and returns only non-secret operational status.
- `/api/*` and the frontend are protected by Basic Auth.
- If `DASHBOARD_USER` or `DASHBOARD_PASSWORD` is missing, `server.js` returns 503
  instead of serving the app open.
- Do not weaken the safe comparison logic in `server.js`.

## Scheduler Safety

- Stock/Nasdaq and crypto scanners skip if already scanning.
- Auto Machine defaults to disabled.
- Auto Machine scheduler has a 5-minute minimum interval.
- Auto Machine skips ticks while the pipeline is already running.
- Manual Machine launch rejects concurrent runs with HTTP 409.
- Manual Machine launch requires `lookbackDays` between 1 and 90.

## Data Safety

- JSONL files are append/load oriented. Do not casually rewrite historical
  `history` or `outcomes` files.
- `marketDataStore.js` merges and deduplicates bars by timestamp when writing.
- Shared candles are read from `data/market-data/candles-2m` first, then legacy
  Alpaca candles are used as fallback.
- Loader failures often return empty arrays/null instead of throwing. Empty files
  can silently degrade health and learning, so verify counts after data changes.
- `/api/system/health` and `/api/alerts` can write alert records as a side effect
  because they call `recordAlerts()`.

## Never Change Blindly

- The live engine order.
- Hard-block caps and the repeated cap reapplication after score adjustments.
- `autoFilter` timing. `applyMtf()` depends on it existing.
- Whether private `_candles*` fields are stripped before responses.
- The meaning of `NO_TRADE`, `WAIT`, `WATCH`, `TRIGGERED`, and avoid states.
- The Machine non-overlap guard.
- API auth defaults.
- The data file paths and date-based filename conventions.
