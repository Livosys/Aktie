# IBKR Paper Futures Execution

Trading OS keeps three ledgers separate:

- `internal_simulation`: legacy Futures Paper simulated ledger. It is retired for
  broker-pilot mutations and cannot reserve the same candidate as `ibkr_paper`.
- `ibkr_paper`: broker execution and read-only mirror for the verified IBKR Paper account.
- `ibkr_live`: not implemented and not activatable.

## Safety Model

New futures broker execution uses only `IBKR_*` flags:

- Runtime shadow deployment may set `IBKR_PAPER_EXECUTION_ENABLED=true` to allow
  the execution client/status subsystem. Code default remains false.
- `IBKR_PAPER_EXECUTION_SHADOW_MODE=true`
- `IBKR_PAPER_ORDER_SUBMISSION_ENABLED=false`
- `IBKR_PAPER_EXECUTION_CLIENT_ID=956`
- `IBKR_PAPER_PROBE_CLIENT_ID=957`
- `IB_FUTURES_DATA_CLIENT_ID=955`

Legacy `IB_PAPER_EXECUTION_ENABLED` does not open the new futures broker path,
and legacy stock/bracket submit functions are hard-blocked by
`legacy_ibkr_submit_disabled` unless the separate deprecated
`IB_PAPER_LEGACY_SUBMIT_ENABLED=true` flag is deliberately set. That flag is not
part of the futures pilot.
Live flags are frozen false constants in `ibPaperExecutionConfigService`; no env var
can enable live broker execution.

## Flow

Server-side strategy candidate id -> server-loaded candidate -> recomputed
entry/approval/risk evidence -> execution-target reservation -> execution
intent -> signed evidence fingerprint -> `ibPaperExecutionGuardService` ->
`ibPaperExecutionAdapterService` -> IB Gateway paper account -> reconciliation
mirror.

Market data remains separate:

IB Gateway -> `ibFuturesDataAdapterService` -> `futuresMarketDataService` ->
scanner/producers/replay/batch.

## Phase A

Default runtime is shadow-safe:

- exact normalized order payload is built
- guard and broker-risk checks run
- idempotency state is persisted only when the guard passes
- `wouldSubmit=true` can be reported
- `actualSubmit=false`
- raw client-supplied candidates are rejected for broker shadow/execution
- exact `nextOrderId` is not exposed; APIs expose only `nextValidIdReady`
- GET status is read-only by default (`connect=false`)

The shadow route rejects `actualSubmit`, `submit`, and `placeOrder` request flags.

## Submit Boundary

Actual submit is still disabled. If it is enabled later, the adapter remains the
last safety layer and requires:

- signed server evidence that fingerprints the immutable intent and order plan
- verified paper account from this execution client's account discovery
- `environment=paper`, live flags false, shadow off, submit flag on
- MNQ/MES dated FUT contract, quantity exactly `1`, one stop, safe bracket
  sequence `parent(false), takeProfit(false), stopLoss(true)`
- risk, approval, entry-contract, reconciliation and idempotency pass
- durable `submit_started` persisted before the first `placeOrder`

## Rollback

1. Set `IBKR_PAPER_EXECUTION_ENABLED=false`.
2. Keep `IBKR_PAPER_EXECUTION_SHADOW_MODE=true`.
3. Keep `IBKR_PAPER_ORDER_SUBMISSION_ENABLED=false`.
4. Restart `nasdaq-scanner`.
5. Verify no open IBKR Paper orders, flat IBKR Paper position, and no orphan stops.
6. If committed, use `git revert <commit_sha>`.
