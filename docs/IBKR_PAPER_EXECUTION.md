# IBKR Paper Futures Execution

Trading OS keeps three ledgers separate:

- `internal_simulation`: existing Futures Paper simulated ledger.
- `ibkr_paper`: broker execution and read-only mirror for the verified IBKR Paper account.
- `ibkr_live`: not implemented and not activatable.

## Safety Model

New futures broker execution uses only `IBKR_*` flags:

- `IBKR_PAPER_EXECUTION_ENABLED=false`
- `IBKR_PAPER_EXECUTION_SHADOW_MODE=true`
- `IBKR_PAPER_ORDER_SUBMISSION_ENABLED=false`
- `IBKR_PAPER_EXECUTION_CLIENT_ID=956`
- `IBKR_PAPER_PROBE_CLIENT_ID=957`
- `IB_FUTURES_DATA_CLIENT_ID=955`

Legacy `IB_PAPER_EXECUTION_ENABLED` does not open the new futures broker path.
Live flags are frozen false constants in `ibPaperExecutionConfigService`; no env var
can enable live broker execution.

## Flow

Strategy candidate -> entry/approval/risk evidence -> execution intent ->
`ibPaperExecutionGuardService` -> `ibPaperExecutionAdapterService` -> IB Gateway
paper account -> reconciliation mirror.

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

The shadow route rejects `actualSubmit`, `submit`, and `placeOrder` request flags.

## Rollback

1. Set `IBKR_PAPER_EXECUTION_ENABLED=false`.
2. Keep `IBKR_PAPER_EXECUTION_SHADOW_MODE=true`.
3. Keep `IBKR_PAPER_ORDER_SUBMISSION_ENABLED=false`.
4. Restart `nasdaq-scanner`.
5. Verify no open IBKR Paper orders, flat IBKR Paper position, and no orphan stops.
6. If committed, use `git revert <commit_sha>`.
