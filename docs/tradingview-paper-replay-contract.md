# Contract (SPEC ONLY) — TradingView → safe paper/replay test flow

Status: **design only. No code, no forwarding implemented.** This documents the
safest future path so it can be built later as its own reviewed goal. Building
it is explicitly the LAST step and must never enable live trading.

## 1. Current flow (verified, read-only today)

```
TradingView alert
  → POST /api/tradingview/webhook            (api.js:3661)
  → tradingViewConnectorService.handleWebhook()
      • normalizePayload() + scrub secret
      • strategyRegistry resolves strategy_id        ✅ already done
      • append data/tradingview-signals.jsonl
      • candidateLogService                          (candidate)
      • eventLogService  { decision:'no_trade', paper:false, paperTradeCreated:false }
  → STOP
```

Why it stops: the connector requires only `candidateLog`, `eventLog`,
`strategyRegistry`. It never requires `paperTradingAgent`. It hard-sets
`paperTradeCreated:false` and `paper:false`. So a TradingView signal becomes a
log row, never a paper trade — it never reaches paper/replay/batch/learning.

## 2. Target flow (future, safe)

```
TradingView alert
  → POST /api/tradingview/webhook
  → handleWebhook()  (unchanged logging + registry mapping)
      → IF feature flag ENABLE_TRADINGVIEW_PAPER=true:
           tradingViewPaperAdapter.preview(signal)        ← DRY-RUN preview first
           (returns what the paper test WOULD be; creates nothing)
      → only when explicitly enabled AND not dry-run:
           paperTradingAgent.evaluate(signal, { mode:'paper' })
           OR replayFixtureService.enqueue(signal)
```

The signal becomes a **paper test or replay fixture** — never an order.

## 3. Hard safety invariants (must all stay true)

- `mode=paper_only`, `actions_allowed=false`, `can_place_orders=false`,
  `live_trading_enabled=false`, `broker_enabled=false` — on every response and
  in the adapter's own SAFETY object.
- **Never** call: any broker/order API, `executionSafety.manual_arm`, the
  executionSafety order path, or anything that changes risk.
- `executionSafetyService` continues to hard-force `live_trading_enabled=false`
  (rejects attempts with `live_trading_not_allowed_v1`).
- Forwarding is **off by default**. Requires explicit env flag
  `ENABLE_TRADINGVIEW_PAPER=true` (does not exist yet — must not be added until
  this is built and reviewed).
- First milestone is **dry-run preview only** (creates no trade), mirroring the
  narrow autopilot's dry-run-first pattern.

## 4. Idempotency & dedupe (required before any trade creation)

- Idempotency key: `sha1(signal_timestamp + '|' + symbol + '|' + signal)`.
- Maintain a small seen-key store (e.g. `data/tradingview/forwarded-keys.jsonl`,
  gitignored). A repeated key → skip with `duplicate_skipped` (handles
  TradingView retries / double-fires).
- Reject signals older than a max age (e.g. > 15 min) → `stale_signal`.
- Validate `signal ∈ {long, short, exit, flat, watch}` (already enforced).

## 5. Required fields & mapping

| Need | Source today | Status |
|---|---|---|
| strategy_id | `strategyRegistry` resolve | ✅ exists |
| symbol | payload | ✅ |
| direction | `signal` (long/short) | ✅ |
| market_group | `marketUniverse.getGroupForSymbol` | reuse |
| entry context | none (TradingView is sparse) | paper agent must tolerate missing indicators |

## 6. Where it must plug into learning (after a paper trade closes)

Reuse the existing path — do not add a parallel one:
`paperTradingAgent` close → `learningConnectorService.recordPaperTradeEvent` →
canonical `tradeStatsService` numbers. TradingView trades must be tagged
(`source:'tradingview'`) so they can be filtered in/out of stats.

## 7. Build order (future goal, one commit each)

1. `tradingViewPaperAdapter` with `preview(signal)` — dry-run only, creates
   nothing, returns the would-be paper test. Feature flag default OFF. + tests.
2. Idempotency/dedupe store + stale-signal guard. + tests.
3. Wire `handleWebhook` to call `preview()` when flag on (still no trade). + tests.
4. Only after review: enable real paper-test creation behind the flag.
5. Surface TradingView paper results in Supervisor overview (`source:tradingview`).

## 8. Explicitly forbidden in every step
Live order, broker enable, `manual_arm`, executionSafety order path, automatic
risk change, auto-apply of any strategy change.
