# Current State: Paper Evidence P0

The current Futures Paper path uses the native futures signal provider, the
Futures Paper scanner, the autonomous scheduler, the IBKR Paper execution
orchestrator, the paper ledger, and the Strategy Library recorder.

## P0 state

- Paper strategy identity is resolved from native strategy IDs to canonical
  Strategy Library IDs before approval and execution.
- Five canonical strategies are enabled and currently eligible in the
  append-only paper strategy store. The short-only VWAP strategy remains
  disabled and blocked by the long-only paper policy.
- Paper accepts multiple open trades, with at most one open/pending exposure per
  root and a maximum of two aggregate open paper contracts under the current
  MNQ/MES pilot policy.
- The daily paper entry cap is 100 new accepted paper entries per futures
  trading day.
- A futures trading day starts at 17:00 America/Chicago. Before 17:00 belongs
  to the previous futures trading day.
- Closed paper trades are folded idempotently into Strategy Library, preserving
  canonical/native/origin identity, version, family, candidate, signal, session,
  and market context when present.
- Live flags remain disabled and the live target retains its existing pilot
  limits.

## Strategy universe audit: 2026-08-19

The 33 canonical strategies classify as follows:

- `READY_NOW` (5): `ema_pullback_continuation`, `narrow_breakout`,
  `narrow_fakeout_reversal_v1`, `narrow_state_expansion_long`,
  `vwap_volume_breakout_long`.
- `SMALL_FIX_REQUIRED` (0): no safe registration-only fix was found.
- `MAJOR_WORK_REQUIRED` (13): `ema_breakdown`, `high_volatility_reversal`,
  `low_volatility_breakout`, `mean_reversion_vwap`,
  `narrow_vwap_mean_reversion_v1`, `pullback_to_vwap_long`,
  `resistance_rejection`, `support_bounce`, `trend_exhaustion_short`,
  `volume_spike_continuation`, `volume_spike_momentum`,
  `vwap_momentum_long`, `vwap_rejection_short`.
- `RESEARCH_ONLY` (0).
- `WRONG_MARKET` (10): `crypto_fast_momentum`, `crypto_momentum_scalper`,
  `gap_continuation`, `gap_fade`, `index_confirmed_long`,
  `index_confirmed_short`, `index_supported_momentum_long`,
  `opening_range_breakout`, `opening_range_fakeout`,
  `opening_range_retest_long`.
- `INTENTIONALLY_DISABLED` (3): `news_volatility_watch`,
  `trend_continuation`, `vwap_failed_breakout_short`.
- `LEGACY / DUPLICATE` (2): `narrow_breakout_v1`,
  `narrow_state_fakeout_reversal`.

No additional strategy was enabled in this audit. The five READY_NOW strategies
were already enabled through the canonical paper policy. The native producer
registry contains eight evaluators; no missing-producer row was safely solvable
by registration alone.

Paper evidence currently exists for all eight native identities in the
Strategy Library. The three native identities outside the active five are
historical evidence only and cannot create new Paper entries under the current
policy.

## Documentation deviation

The repository worktree did not contain `docs/trading-os/00_READ_FIRST_AI_AGENTS.md`
or the referenced canonical documentation set. Existing repository code and
runtime behavior were therefore treated as the source of truth. This focused
state document records only the verified P0 decisions and does not restore the
deleted legacy documentation.

## Shared producer/entry audit: 2026-08-19

The first candidate group for a reusable Futures producer is:

- `low_volatility_breakout`
- `volume_spike_momentum`

Both are long-compatible under the current Paper direction policy and belong to
the volume/breakout family. Their catalog rows declare runtime signal names and
Paper support, but those declarations are metadata only: neither strategy has
a native evaluator in `nativeFuturesStrategyRegistryService`, and neither has a
verified signal-producing path through `nativeFuturesSignalProvider`.

No Paper eligibility was changed. Creating the missing detectors would be new
strategy semantics, not a registration or adapter fix, so the phase stopped at
this architecture blocker. `pullback_to_vwap_long` was not selected because
its VWAP pullback/bounce semantics also have no producer and are not equivalent
to the existing VWAP reclaim producer.

## Strategy semantics audit: 2026-08-19

`volume_spike_momentum` has only catalog-level rules: relative volume spike,
fast price expansion, non-extreme spread, and follow-through. The catalog also
lists `1m`, `2m`, and `5m`, stop `0.2`, target `1.6`, and seven-minute holding
time. No source defines the required bar depth, exact volume window, exact
spread source/threshold, session policy, stale policy, invalidation rule, or
Paper entry price semantics.

`low_volatility_breakout` has only catalog-level rules: low-volatility regime,
tight range, range break, and volume expansion. The catalog lists `2m`, `5m`,
and `15m`, stop `0.18`, target `1.9`, and sixteen-minute holding time. No
source defines the volatility estimator/threshold, compression window, range
window, breakout close-through rule, volume window/threshold, session policy,
stale policy, invalidation rule, or Paper entry price semantics.

`tradingViewTestBlueprintService` contains generic illustrative Pine mappings
for some atomic rule names, but it generates pseudo entry text from catalog
rules; it is not a Futures evaluator. `strategyPerformanceService` generates
deterministic synthetic results, and the stored examples for both strategies
are stock `paper_replay` records. Neither source supplies verified Futures
strategy semantics.

## Research specification layer: 2026-08-19

Added a read-only, in-memory research specification builder at
`src/services/research/strategyResearchSpecificationService.js`. It creates
versioned `RESEARCH_SPECIFIED` contracts for the two concepts, records every
known source, keeps unresolved parameters explicit, and never creates a
producer, replay job, Paper intent, or persistent record.

The current IBKR Futures data foundation contains 13 calendar dates and 9
complete shared MNQ/MES trading days, with raw 1m and derived 2m data. Volume
is present, but the set is not sufficient for historical validation or an
out-of-sample split. Research work items therefore remain blocked until an
executable identity and adequate evidence exist.

The permanent distinction is:

```text
STRATEGY CONCEPT
  -> RESEARCH SPECIFICATION
  -> HISTORICALLY VALIDATED STRATEGY
  -> EXECUTABLE RUNTIME STRATEGY
```

## IBKR historical market-data foundation: 2026-08-19

The repository now has a read-only dataset manifest layered on the existing
IB raw store, candle store, backfill manifest, progress tracker, validator, and
Replay coverage service. It reports date coverage, strict CME Globex session-day
completeness, partial days, quality checks, timeframes, and contract
provenance without starting a download or touching Paper execution.

The existing controlled dataset is IBKR-sourced MNQ and MES data with 1-minute
raw bars and deterministic 2-minute derived candles. It contains 13 calendar
dates per root, 11 strict complete Globex session-days, and 2 partial days. The local
raw audit found no duplicate timestamps, invalid OHLC values, negative volume,
or non-monotonic files. Existing captured rows retain their contract through
the import manifest; newly persisted current and derived bars now also carry a
canonical contract key.

The IB Gateway paper connection was reachable on port 4002 and current/future
contract resolution returned five contracts per root. A controlled current
contract historical request succeeded after correcting the IB UTC end-time
format. Direct requests for known 2025 expired local symbols returned IB error
200 (`No security definition has been found for the request`), so no multi-year
backfill was run. Historical availability for expired contracts remains an
external IB contract-definition/data-entitlement blocker.

The backfill remains resumable and append-only through its existing planner,
progress JSONL, manifest JSONL, contract-aware validation, pacing, and
idempotent timestamp writes. Research specifications remain
`executable=false` and `runtimeEligible=false`. The older coverage report's
9-day figure uses the separate `throughUtcTime=15:00` shared-day criterion;
these are different completeness definitions and are both retained explicitly.

Newly imported and newly captured bars also receive canonical Futures session
and trading-day fields from `futuresMarketHoursService`. Existing rows remain
readable through their manifest provenance and are reported as `manifest_only`
until a future append-only migration provides per-row fields.

## Expired IBKR contract resolution audit: 2026-08-19

The previous error-200 result was not sufficient evidence that IBKR lacked
expired history. The runtime audit found that the generic contract-details
request did not carry an explicit expired-contract query. The adapter now
supports an exact contract request with `expiry` and/or `localSymbol`, and
propagates `includeExpired=true` to both contract-details and historical-data
requests. Historical requests also retain the resolved conId, localSymbol,
expiry, tradingClass, multiplier, and contract identity.

Observed read-only results on the active Paper Gateway:

- `MNQZ5` and `MESZ5` resolved with real conIds and returned 1m TRADES bars
  with volume for an in-period December 2025 probe.
- `MNQH6`, `MESH6`, `MNQM6`, and `MESM6` resolved and returned in-period
  historical bars.
- 2025 March, June, and September contracts and 2024 December contracts did
  not resolve and returned IB error 200 even with `includeExpired=true`.

This separates the fixed request-propagation bug from the remaining observed
IBKR contract-retention/discoverability boundary. No historical data was
persisted and no full backfill was started. A temporary two-root controlled
plan was also stopped before persistence because the existing `1 D` request
ending at UTC midnight returned only the elapsed Globex slice; the validator
correctly rejected the incomplete window. Research strategies remain
non-executable.

## Canonical historical trading-day windows: 2026-08-19

Backfill requests now derive their window from `futuresMarketHoursService`.
For trading day `YYYY-MM-DD`, the canonical interval is 17:00 CT inclusive
through the next day at 17:00 CT exclusive. The service converts these
boundaries to UTC with America/Chicago DST rules; the planner does not use
UTC-midnight calendar days. Historical bars remain normalized as UTC, while
the request retains `exchangeTimezone=America/Chicago`, `useRth=0`, and
`whatToShow=TRADES` so the full Globex session is requested.

Completeness is calculated from the same market-hours service. Maintenance
breaks, weekends, and other closed intervals are excluded from expected
minutes; the validator remains strict for all expected open intervals. The
dataset manifest groups rows by their canonical `tradingDay` before validation
instead of validating a trading-day file against a calendar-midnight window.

Read-only Gateway probes for `MNQZ5` and `MESZ5` on 2025-12-18 returned 1,380
1m bars each from `2025-12-18T23:00:00Z` through
`2025-12-19T21:59:00Z`, with `useRth=0` and volume present. A temporary
two-contract persistence test passed checkpoint resume, append-only writes,
manifest completeness, 2m aggregation (690 candles per root), and a repeated
run without duplicate bars. No production data was written and no full
backfill was started.

Planner validation also clamps a contract's last usable trading-day label to
the calendar day before its expiry, because the expiry date's 17:00 CT window
starts after the contract has expired. Requests outside that derived active
window are blocked before any IB request.

## Canonical contract period and provenance gate: 2026-08-19

Contract identity is now centralized as `root + conId/localSymbol + expiry`,
with a deterministic `contractKey`. Contract expiry, observed/active period,
and a future research roll period are separate fields; no continuous/root roll
policy is currently approved. Contract-specific persistence uses an additive
contract partition, so equal timestamps from different contracts are retained
instead of being timestamp-deduplicated together.

New current-capture bars and derived candles require exact contract identity,
canonical `tradingDay`, canonical session, and `exact_provenance`. A capture
without resolvable identity is rejected rather than relabeled. Existing rows
remain readable and are reported as `manifest_only` where per-bar identity is
not recoverable; no destructive migration was performed.

Backfill planning now requires explicit active period, verified provenance
source, and readiness `BACKFILL_READY`. Overlapping ownership is blocked as
`ambiguous_contract_ownership`. Readiness states distinguish resolved,
probed, usable, degraded, unavailable, provenance-ready, and backfill-ready.
Root-only historical reads block when multiple exact contracts match; callers
can request an exact `contractKey` for deterministic Replay/PriceFeed reads.
Replay keeps root-only behavior for legacy/configurations without a contract
selection, and accepts an optional `contractKeyByRoot` map when a run is
contract-specific.

## Controlled full contract-specific IBKR backfill: 2026-08-19

Run `ib-controlled-full-20260819-v3` completed through the existing planner,
paced downloader, strict validator, contract-partitioned store, aggregator,
manifest, and append-only checkpoint. The plan contained 464 valid
trading-day segments. 436 segments persisted successfully and 28 were
classified as permanent validation failures; failed segments were never
marked complete and did not enter an infinite retry loop.

The persisted contracts were `MNQZ5`, `MNQH6`, `MNQM6`, `MNQU6`, `MESZ5`,
`MESH6`, `MESM6`, and `MESU6`. Their observed contract-specific ranges were:

- Z5: 2025-09-22 through 2025-12-18
- H6: 2025-12-22 through 2026-03-19
- M6: 2026-03-23 through 2026-06-17
- U6: 2026-06-22 through 2026-08-17

Each root has 218 complete contract-day records, for 218 unique shared
trading-day labels and 436 MNQ/MES contract-day records. The run persisted
601,680 raw 1m bars and 300,840 deterministic 2m candles. Post-run audits
found zero duplicate identities, provenance mismatches, invalid OHLC rows,
negative volume, or missing volume. The 28 rejected segments correspond to
exchange holidays or reduced/closed sessions and remain in the append-only
failure register instead of being fabricated as complete days.

The run resumed from checkpoint after an interrupted process. The first
resumed segment found 1,380 existing raw bars and 690 existing 2m candles and
appended zero duplicates. Exact Historical PriceFeed reads returned 1,380
bars for MNQZ5, MES H6, and recent MNQ U6 windows. Root-only ambiguity
protection remains active and no continuous series was created.

The resulting foundation is classified
`USEFUL_BUT_INSUFFICIENT_FOR_OOS`: it covers approximately eleven months and
218 complete shared trading days, but not the requested multi-year horizon or
an independent out-of-sample period. The two research specifications remain
`executable=false` and `runtimeEligible=false`.

## AI Factory Historical Research readiness (2026-08-19)

The canonical dataset is in place, but the first research cycle could not be
executed. The blocker is not data.

**Executable surface.** The native futures registry exposes 29 evaluators, all
derived from the eight migrated strategy modules and their registered
parameter variants. `low_volatility_breakout` and `volume_spike_momentum` have
no evaluator, no native implementation, and no origin mapping. The Native
Replay Engine iterates `listStrategyEvaluators()` and can therefore not run
either concept.

**Specification completeness.** `low_volatility_breakout` has 14 research
variables and 0 resolved. `volume_spike_momentum` has 16 and 0 resolved. The
values that exist are marked `hypothesisOnly` and originate from catalog
metadata or generic Pine pseudo-mapping, not from futures evidence.
`buildResearchWorkItem` reports `BLOCKED_UNTIL_EXECUTABLE_IDENTITY` with
`canSchedule: false`, and AI Memory cannot form an experiment identity before a
strategy DNA exists.

**Contract handling.** No silent stitching is possible. Historical PriceFeed
returns `dataQuality: 'ambiguous'` with `ambiguous_contract_ownership` when a
root-level read spans several contracts, and exact single-contract reads
succeed for Z5, H6, M6 and U6. Contract-specific research is available today;
a continuous roll policy is still absent and was not created.

**Dataset access asymmetry.** MNQ and MES each hold 218 contract-partitioned
days. Each root additionally holds 13 root-level day files, of which
2026-08-07, 2026-08-14, 2026-08-18 and 2026-08-19 have no contract-partitioned
counterpart. `loadRawBars` merges both when no `contractKey` is supplied, so a
root-level read reports 222 complete shared days and a contract-specific read
reports 218. Experiment identity must record which access path was used.

**Prepared research/validation split.** Two time-separated splits were computed
over the 218 contract-partitioned shared days. A 70/30 temporal split gives 152
research days (2025-09-22 → 2026-05-07) and 66 validation days (2026-05-10 →
2026-08-17), but contract M6 straddles the boundary with 33 research and 27
validation days. A contract-aligned split gives 119 research days (Z5 + H6,
2025-09-22 → 2026-03-19) and 99 validation days (M6 + U6, 2026-03-23 →
2026-08-17) with zero contract overlap, and is the recommended boundary for
contract-specific research. Neither split has been used; no experiment ran.

**Spread source.** None exists. Raw bars carry `ts, open, high, low, close,
volume, tradeCount, source, conId, localSymbol, expiry`. The `spreadMeasure`
dimension of `volume_spike_momentum` is BLOCKED and must not be synthesised
from OHLC.

**Evidence thresholds.** `validationRequirements.thresholdsStatus` remains
`not_decided`. No promotion threshold was invented.

**Dataset limitation, permanent.** Approximately eleven months. 218
contract-partitioned complete shared trading days, 222 when read at root level.
Sufficient for initial historical research; not proof of long-term
generalisation. There is no independent multi-year out-of-sample period, and no
text may describe this dataset as multi-year validated.

Both concepts remain `RESEARCH_SPECIFIED`, `executable=false`,
`runtimeEligible=false`. Neither is Paper-enabled. Live execution remains
blocked: `live_trading_enabled=false`, `live_broker_enabled=false`,
`live_order_submission_enabled=false`, `live_account_orders_allowed=false`,
`real_orders_blocked=true`.

---

## AI Memory Reconciliation + Executable Research Hypothesis (2026-08-20)

### The research lifecycle, permanently

```
STRATEGY_CONCEPT
  → RESEARCH_SPECIFICATION
    → EXECUTABLE_RESEARCH_HYPOTHESIS      ← replay allowed, evidence allowed
      → HISTORICALLY_RESEARCHED
        → HISTORICALLY_VALIDATED_CANDIDATE
          → EXECUTABLE_RUNTIME_STRATEGY   ← runtime eligible
            → PAPER_ELIGIBLE              ← paper eligible
```

These are gates, not labels. `researchHypothesisService.LIFECYCLE_GATES` is the
only definition, and `gatesFor(stage)` throws on an unknown stage rather than
guessing. An `EXECUTABLE_RESEARCH_HYPOTHESIS` may run in Historical Replay and
may write research evidence. It can never be `runtimeEligible`, never
`paperEligible`, and never receives Paper approval — no matter what its numbers
look like. A `HISTORICALLY_VALIDATED_CANDIDATE` is still not runtime: the step
to runtime is an implementation, not a promotion.

### What a hypothesis is

A strategy concept is a name and a sentence. `low_volatility_breakout` had 14
unresolved semantic variables and `volume_spike_momentum` 16; neither had an
evaluator. Choosing values, running them, and reporting the result as knowledge
about the concept would be inventing a strategy and calling it research.

An **executable research hypothesis** is an explicit, versioned interpretation of
the concept. Evidence attaches to the hypothesis, not to the concept, so a
hypothesis can be rejected without rejecting the concept and can survive without
the concept thereby being validated. Every value carries `HYPOTHESIS_ONLY` and a
named source; none is ever marked `VALIDATED` before historical evidence.

Identity: `hypothesisHash` is a hash of the semantics alone — signal rules,
entry, exit, timeframe, session, roots. Rewriting the rationale does not change
it. Strategy DNA is derived per hypothesis, so all twelve have distinct
`dnaHash` and `parameterHash` and AI Memory can tell them apart.

Research ids carry the prefix `research__`, which makes leakage visible in any
log, and every decision carries `researchOnly: true`, `paperEligible: false`,
`runtimeEligible: false` in its payload — not only in its id.

### Dataset boundary: exact_contract only

All research in this phase reads `dataAccessMode = exact_contract`: 218 shared
trading days per root, MNQ + MES, across eight contracts. Root-level reading
(222 days) is documented and deliberately unused, because its boundary depends
on which loose capture files happen to sit in the root directory.

Split, contract-adjusted and measured (not asserted):

| | days | period | contracts |
|---|---|---|---|
| research | 119 | 2025-09-22 → 2026-03-19 | Z5 + H6 |
| validation | 99 | 2026-03-23 → 2026-08-17 | M6 + U6 |

Zero day overlap, zero contract overlap, no random split.

**Trading day ≠ calendar date.** The contract-partitioned backfill partitions on
the CME trading day, which begins the previous evening: `2026-01-15.jsonl` holds
bars from `2026-01-15T23:00Z` to `2026-01-16T21:59Z`. Measured across the whole
store, all 218 files place their 13:00–17:00Z window on label + 1 day, 240
one-minute bars each. `researchDatasetBoundaryService.rthWindowFor()` is the
only place this is expressed.

### AI Memory: exclusion without deletion

`EXPERIMENT_EXCLUDED` joins `EXPERIMENT_RECORDED` and `EXPERIMENT_SUPERSEDED`.
Reasons are a closed set: `SANDBOX_VERIFICATION_ONLY`, `ORPHANED`,
`NON_CANONICAL_PROVENANCE`. Nothing is deleted, truncated or rewritten; the log
gains a row that says why an experiment does not count.

`validForLearning(record)` = has a library reference, not excluded, not
superseded. It is read by `lookupOrPlan` (so an excluded experiment can never
answer "cached" and permanently block the real run), by `experimentsForDna` and
`experimentsForMarket`, by the Strategy Brain knowledge index and by the
Learning Engine. `listExperiments()` still returns the whole truth; the filter
is opt-in via `listExperiments({ validForLearning: true })`.

### Live and paper safety, unchanged

Paper: multi-strategy on, multi-trade on, `maxEntriesPerHour: 100`,
`maxQuantity: 1`, one position per root with `maxOpenPositions: 2`, same-root
overlap blocked. Live: `live_trading_enabled=false`, `live_broker_enabled=false`,
`live_order_submission_enabled=false`, `live_account_orders_allowed=false`,
`real_orders_blocked=true`. No broker or order code was written in this phase.

---

## Historical Research Cycle 2 (2026-08-20)

Tio hypoteser (H1xx), samma exact-contract-gräns, samma kontraktsjusterade split
(119 research / 99 validation, noll överlapp). Ingen grid search: varje hypotes
ändrar en sak mot sin referens.

### Kalibrering före körning

Cykel 2:s värden kommer ur mätning på cykel 1:s data, inte ur en katalog:

- `atrPct120 <= 89` ger samma selektivitet (8,5 % av barerna) som
  `bbwPct120 <= 60`. Cykel 1:s H003 använde 60, vilket ligger under femte
  percentilen — den prövade ett mycket strängare regimfilter i stället för
  frågan "spelar estimatorn roll".
- Breakout-kvalificeringarnas täthet, mätt på de 406 av 4 800 barer som
  passerar kompressionen: high/low(20) 8,1 %, CLOSE-range(20) 19,2 %,
  0,15 ATR-tolerans 13,1 %, high/low(10) 13,3 %.
- Entry timing, mätt på 314 spikar: nästa bars stängning ligger +0,79 punkter
  **i** signalens riktning, alltså dyrare — fördröjning prövas inte. 74,8 % av
  spikarna retracerar minst 25 % av kroppen inom tre barer, 64,3 % minst 50 %.

### Utfall

Ingen kandidat överlevde. Fem pre-deklarerade VSM-kandidater, samtliga
nettonegativa på valideringen. Fem LVB-hypoteser, samtliga med profit factor
under 1 på research.

Två svar är entydiga:

1. **Follow-through-borttagningen är exakt neutral.** VSM H101 återger cykel 1:s
   H005 bit för bit på båda perioderna (622 affärer, PF 1,394, netto +4 018
   respektive 448, 1,102, −1 433). Två olika hypotesidentiteter, identiskt utfall.
2. **Exekveringskostnaden går att lösa, och att lösa den avslöjade att det inte
   fanns någon bruttoedge kvar att skydda.** Pullback-entryn sänkte
   exekveringskostnaden från 5,44 till 1,69 USD per affär på valideringen — men
   bruttoedgen föll samtidigt till PF 1,011, och det fasta courtaget på 2,44
   USD per affär räcker då för att sänka resultatet. Edgen låg i att gå in på
   spikens stängning, alltså i just det pullback-entryn avstår från.

För LVB ökade signaltätheten 1,3–1,6 gånger som förutsagt, men de tillkommande
signalerna var inte bättre. Research och validation är oense om tecknet för
samtliga fem hypoteser, vilket i sig visar att 63–156 affärer inte räcker.

Båda koncepten står kvar på `RESEARCH_SPECIFIED`, `executable=false`,
`runtimeEligible=false`. `thresholdsStatus` är fortfarande `not_decided`.
