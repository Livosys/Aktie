# Paper Entry Quality Timeout Analysis

Generated: 2026-07-11T17:58:56Z

Scope:
- Read-only analysis of `data/paper-trading/trades.jsonl`.
- Active manual Paper strategies only.
- No timeout, risk, replay, learning or historical trade data was changed.

## Summary

The current data does not support a timeout code change in this phase.

The only active strategy with historical trades is `narrow_state_expansion_long`.
Its timeout rate is low, and the single timeout would be blocked by the new
entry contract because it was a watch/caution-style entry. EMA and VWAP active
strategies have no paper trades in the current trade log, so there is no timeout
evidence for changing their exit model.

## narrow_state_expansion_long

- Trades: 23
- WIN: 13
- LOSS: 9
- TIMEOUT: 1
- Timeout rate: 4.35%
- maxHoldMinutes: 20
- Median duration: 210000 ms
- Median time to target: 419769 ms
- Median time to stop: 149967 ms
- Average MFE: 0.0837%
- Average MAE: -0.0802%
- Timeout average MFE: 0.1063%
- Timeout average MAE: -0.0796%
- Timeout trades with never-positive MFE: 0
- Timeout trades positive but no target: 1
- Timeout trades from watch/caution-like entry: 1
- Timeout trades that new contract would block: 1

Classification:
- Primary: A. entry problem
- Secondary: G. flat/inconclusive for learning semantics

Decision:
- No timeout change.
- Fix entry quality first. The new contract blocks observation, missing
  confirmation, stale data and late/extended entries before timeout tuning.

## ema_pullback_continuation

- Trades: 0
- TIMEOUT: 0
- Timeout rate: unavailable

Classification:
- G. flat/inconclusive

Decision:
- No timeout change. There is no strategy-specific trade evidence yet.

## vwap_volume_breakout_long

- Trades: 0
- TIMEOUT: 0
- Timeout rate: unavailable

Classification:
- G. flat/inconclusive

Decision:
- No timeout change. There is no strategy-specific trade evidence yet.

## Follow-up Criteria

Consider timeout changes only after entry contracts have produced enough
contract-passing trades per strategy to separate:

- entries that never had positive MFE,
- entries that had positive MFE but missed target,
- target distance that is too far,
- timeout that is too short,
- timeout that is too long,
- missing market data,
- exit engine holding too long.
