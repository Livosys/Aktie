# Roadmap And Decisions: Paper Evidence P0

## Decision: canonical paper identity

Approval and execution use one paper policy. A native futures strategy must map
to an enabled, technically ready canonical strategy with a ready paper entry
contract. Native-only strategies remain blocked until a canonical approval
identity exists.

## Decision: multi-strategy and multi-trade

Paper execution may process multiple eligible strategies in one scheduler cycle
and may hold MNQ and MES at the same time. A second entry on the same root is a
conflict because IBKR netting would make attribution ambiguous. Duplicate
candidate and intent protections remain active.

## Decision: daily cap

`MAX_NEW_PAPER_TRADES_PER_DAY` is 100. The cap reserves an idempotency key just
before a real paper submission and reconstructs state from append-only
reservations and accepted paper intents after restart. Trade 101 is blocked with
`daily_paper_trade_limit_reached`; exits, fills, reconciliation, and risk
management continue.

## Next phase

Add a per-strategy four-loss daily circuit breaker with manual resume or an AI
Factory handoff, after observing the new forward evidence.

## Strategy-universe decision: 2026-08-19

Do not enable the remaining 28 canonical IDs blindly. The audit found no
additional READY_NOW strategy. The remaining rows are either wrong-market,
legacy/duplicate, intentionally disabled, or require a new producer, market
context, short-entry policy, or other substantial capability. Such work is
outside this phase and must not be hidden as an approval or mapping change.

The next strategy-universe phase should prioritize a shared producer contract
for one market family at a time, with a complete signal-to-library acceptance
test before activation.

## Shared producer/entry decision: 2026-08-19

The first proposed family is `low_volatility_breakout` plus
`volume_spike_momentum`. The audit found no existing producer or entry adapter
that can express their catalog rules. The native evaluator registry and
provider are the executable source of truth; catalog `runtime_signals` and
`entry_capable` flags do not create runtime signals.

Do not map either strategy to an existing narrow, VWAP, EMA, or momentum signal.
That would lose semantic identity. Implementing them requires an explicit shared
volume/breakout detector and a verified canonical entry contract, which is
strategy logic and must be a separately scoped phase.

## Semantics audit decision: 2026-08-19

Stop before implementation. The two selected strategies do not have enough
runtime-defined rules to construct deterministic positive/negative fixtures or
a valid Futures Paper entry contract. The missing business decisions are the
indicator windows and thresholds, session/staleness behavior, invalidation
conditions, and exact entry-price semantics. These must be specified before a
shared producer can be implemented.

## Research specification decision: 2026-08-19

Research specifications are read-only contracts, not runtime strategies. The
new specification builder may describe bounded hypotheses and evidence sources,
but it must not silently choose unresolved defaults or schedule experiments. A
work item stays blocked until Strategy DNA, Market DNA, execution model, and
replay mode are all available for the existing AI Memory identity check.

Current MNQ/MES data is sufficient for a data-inventory report only: 13
calendar dates, 9 complete shared trading days, raw 1m and derived 2m bars,
and no multi-year or out-of-sample split. The next data-dependent phase remains
IBKR multi-year historical foundation before validated promotion.

## IBKR historical foundation decision: 2026-08-19

Use the existing IBKR read-only adapter, contract-aware backfill planner,
append-only progress/manifest logs, market-data store, and shared candle
aggregator. Do not create a parallel historical store or continuous-contract
series yet. Contract-specific bars remain the canonical persisted source;
continuous research stitching requires a separate product decision covering
roll dates and price adjustment.

The dataset manifest is read-only and derives availability from the canonical
store. It distinguishes complete and partial CME Globex days and exposes
contract provenance status. Existing captured rows are currently
`manifest_only`; new persistence carries per-bar and per-candle contract keys,
canonical session, and trading-day metadata.

The IB Gateway was reachable, but the current connection exposed only current
and future MNQ/MES contract definitions. Known expired 2025 local-symbol
requests returned IB error 200. Therefore no multi-year production backfill
was started. The next decision is to provide/verifiably resolve expired
contract definitions and confirm IB historical-data entitlement before any
large backfill.

The backfill adapter's UTC request format was corrected to the Gateway-accepted
`yyyymmdd-hh:mm:ss` form. This is a transport correctness fix; it does not
change strategy, Paper, Replay, quantity, daily-cap, or live-execution policy.

## Expired-contract resolution decision: 2026-08-19

Expired futures discovery must be explicit and contract-specific. The adapter
uses `includeExpired=true` whenever an expiry or localSymbol is requested and
passes the resolved contract identity through the historical request. The
backfill planner now rejects a segment whose requested date range does not
overlap the contract's declared active window.

The active Paper Gateway resolved and served historical data for the 2025
December and 2026 March/June MNQ/MES contracts. It returned error 200 for the
2025 March/June/September and 2024 December probes even with the correct
expired flag. This is not evidence of a general entitlement failure because
the 2025 December probes succeeded. Full backfill remains blocked until the
actual contract-retention/discoverability boundary is understood.

The first controlled multi-contract plan exposed a separate backfill-window
blocker: IBKR's existing `1 D` request ending at UTC midnight returned only a
partial session slice, so the canonical validator rejected the window before
any file write. Do not weaken validation; the next backfill phase must define
an IB request-window and filtering policy that preserves canonical
trading-day/session semantics.

## Canonical request-window decision: 2026-08-19

Historical Futures requests use the existing `futuresMarketHoursService` as
the sole trading-day/session authority. A requested trading day starts at
17:00 America/Chicago and ends at 17:00 America/Chicago on the following
calendar date. The resulting UTC endpoints are DST-aware. IB requests use
`useRth=0`, `whatToShow=TRADES`, and `duration=1 D`; the request endpoint is
the canonical 17:00 CT end, not UTC midnight. The validator remains strict and
ignores only expected market-closed intervals such as the maintenance break.

The dataset manifest now validates by row-level canonical `tradingDay`, so
bars that cross a UTC calendar boundary are not misclassified. A controlled
MNQZ5/MESZ5 single-day probe returned 1,380 1m bars per root. A temporary
two-contract persistence test passed resume, deduplication, contract
provenance, 2m aggregation, manifest completeness, and Historical PriceFeed
readback. Full backfill remains intentionally unstarted; the observed IBKR
horizon is still December 2025 and later.

Contract expiry is intersected with trading-day labels: the last usable label
is the day before the expiry date. This prevents a 17:00 CT window beginning
on the expiry date from being sent to IBKR.

## Canonical contract provenance decision: 2026-08-19

The minimum safe policy is contract-specific storage and no stitching. A
futures root (`MNQ`/`MES`) is not an exact contract. Persistence and dedup
therefore use `contractKey + timestamp`; two contracts with the same root and
timestamp are distinct bars. Legacy root/date files remain readable with
`manifest_only` provenance and are not backfilled with guessed identities.

The canonical contract period model keeps broker expiry, observed usable
active period, and research roll period separate. No verified research roll
policy exists, so continuous/root research selection remains blocked. A
backfill segment must carry exact identity, an explicit active window, a
provenance source, and `BACKFILL_READY`; ambiguous overlapping ownership is a
hard blocker. Exact contract reads are supported by the Historical PriceFeed,
while root reads are blocked when multiple exact contracts are present.

## Controlled full IBKR backfill decision: 2026-08-19

Run `ib-controlled-full-20260819-v3` used only `BACKFILL_READY` contracts and
the canonical 17:00-17:00 America/Chicago request window. The planner was
corrected to exclude both Friday and Saturday labels: Friday 17:00 CT starts
the CME weekly close, while Saturday is closed. This corrected a real planner
error while leaving the strict validator unchanged.

The run completed 436 of 464 planned segments. The 28 permanent failures were
strict validation outcomes around exchange holidays or reduced sessions. The
result is 601,680 contract-specific 1m bars and 300,840 2m candles across
eight contracts, with zero duplicate identities, contract collisions,
provenance mismatches, invalid OHLC rows, negative volume, or missing volume.
Checkpoint resume and idempotent re-import passed. No continuous contract or
root-level ownership policy was introduced.

The resulting dataset is `USEFUL_BUT_INSUFFICIENT_FOR_OOS`: approximately
eleven months and 218 unique complete shared trading days are useful for data
and integration work, but not for a multi-year or independent OOS claim.
`low_volatility_breakout` and `volume_spike_momentum` remain research
specifications and cannot be activated from this dataset alone.

## Decision: historical research needs an executable specification first

The first AI Factory Historical Research cycle was attempted on 2026-08-19 and
stopped without generating experiments.

The reason is structural rather than incidental. Research requires a runnable
signal definition, and both concepts are specifications in which every semantic
dimension is still open: volatility estimator, compression window, breakout
qualification, volume rule, relative-volume source and threshold, price
expansion measure and threshold, follow-through rule, timeframe, session, stale
limit, entry model, entry price, invalidation, stop, target, holding time and
exit precedence. Zero of 14 and zero of 16 variables are resolved. There is no
evaluator for either concept, and the replay engine can only execute registered
evaluators.

Running experiments from this position would have meant choosing the strategy
semantics in order to test them, and then reporting the result as evidence
about a concept the project never defined. That is the failure mode the phase
exists to avoid, so the cycle stopped instead.

The decision is therefore to sequence the work as: resolve the signal
definition to a versioned, executable specification for one concept at a time,
register it so it gains a DNA and an experiment identity, and only then run the
knowledge-driven research cycle over the contract-aligned split. Entry and exit
optimisation stays out of the first cycle; the question is what a good signal
is, not what a good stop is.

The `spreadMeasure` dimension of `volume_spike_momentum` remains BLOCKED until a
verifiable futures spread source exists. It must not be reconstructed from OHLC
bars.

No promotion threshold was decided. `thresholdsStatus` stays `not_decided`, and
no strategy may be promoted on an invented threshold.

---

## 2026-08-20 — Decisions from the first executable research cycle

**D1. A concept is not a strategy, and evidence must name its owner.**
Research evidence is attributed to a versioned hypothesis (`H001`…), never to
the concept. Rejecting `research__low_volatility_breakout__H001` rejects one
interpretation, not `low_volatility_breakout`. Accepted.

**D2. Exit is held constant, not researched.** Broker Risk requires a stop loss
(`ibPaperBrokerRiskService: stop_loss_required`), so a fully neutral exit
(`stopLoss=null`, everything closing at `window_end`) is not runnable without
changing a module that also governs paper and live. It was not changed. Instead
the exit is pinned to the catalog's own declared defaults for each concept and
held identical across the batch. **Consequence, stated plainly: the batch
measures relative signal quality under a constant exit. It does not measure
absolute tradeability, and the exit parameters are not tested.**

**D3. `spreadMeasure` — decision A, reduced hypothesis.**
`volume_spike_momentum`'s `spread_not_extreme` is a gate, not a signal
generator. Removing it makes the hypothesis strictly *more permissive* than the
concept, never less, so the result is a lower bound with a known error
direction: real execution in wide spreads is worse than these numbers show. The
variable stays in the hypothesis marked
`NOT_TESTABLE_WITH_CURRENT_DATA`; omitting it silently would make a reduced
hypothesis indistinguishable from a complete one. No synthetic spread was
constructed from OHLC.

**D4. Validation candidates are pre-declared.** Hypotheses with research profit
factor > 1.0 were named before the validation split was run. This is a selection
rule for what to validate, not a promotion threshold —
`validationRequirements.thresholdsStatus` remains `not_decided` and no minimum
evidence requirement was invented.

**D5. No promotion.** Both concepts remain `RESEARCH_SPECIFIED`,
`executable=false`, `runtimeEligible=false`, Paper approval unchanged. No
hypothesis was promoted to `HISTORICALLY_VALIDATED_CANDIDATE`.

### Open, for the next phase

- **Strategy Library has no exclusion vocabulary.** AI Memory now has
  `EXPERIMENT_EXCLUDED`; the library has only `RETIRED`, which means something
  else. The first research pass wrote H006 rows at the engine's 2m while the
  hypothesis declares 5m; those AI Memory experiments are excluded as
  `NON_CANONICAL_PROVENANCE`, but the corresponding library rows remain and must
  be read together with that exclusion. A library-side exclusion event is the
  clean fix and was not invented here.
- **`expiryIsValid` exists twice.** Fixed in
  `nativeFuturesSignalContract`; `ibPaperExecutionGuardService` keeps its own
  copy, deliberately untouched because paper receives IB-native `YYYYMMDD`. The
  duplication is a latent drift risk.
- **The 93 excluded experiments are still in the log.** That is correct for an
  append-only store. Whether they should ever be physically removed is a human
  decision and requires an explicit removal plan.

---

## 2026-08-20 — Research Evidence Policy v1 (föreslagen)

`thresholdsStatus` har gått från `not_decided` till
`proposed_pending_human_approval`. Policyn skrevs **mellan** två cykler och inte
under någon — det är den enda tidpunkt då ett promotionkrav kan skrivas utan att
målstolpen flyttas efter att resultatet setts.

### Trösklarna och varifrån de kommer

| tröskel | värde | härkomst |
|---|---|---|
| minTrades | 30 | `strategyScoreService.confidenceForSample` — under 30 = lågt förtroende |
| researchProfitFactor | 1,40 | `learningConnectorService:489` — projektets befintliga befordringsnivå |
| validationProfitFactor | 1,25 | `researchScoreService.scoreProfitFactor` — andra bandgränsen |
| net > 0 (båda perioder) | teckentest | definitionen av att tjäna pengar, inte en nivå |
| PF > 1 (båda perioder) | teckentest | dito |
| minRecoveryFactor | 1,0 | teckentest: resultatet ska minst motsvara den värsta nedgången |
| **minTradingDays** | **20** | **förslag — ingen förlaga i koden** |
| **minEdgeRetention** | **0,50** | **förslag — ingen förlaga i koden** |
| **maxTopDayShare** | **0,35** | **förslag — ingen förlaga i koden** |
| **minPositiveDayShare** | **0,40** | **förslag — ingen förlaga i koden** |

### Tre beslutsvägar, och varför ordningen spelar roll

1. Underlaget räcker inte → `INSUFFICIENT_EVIDENCE`
2. Underlaget räcker men tecknet är negativt → `REJECTED_BY_HISTORICAL_EVIDENCE`
3. Tecknen är positiva men magnituden bär inte → `INSUFFICIENT_EVIDENCE`

Ett litet urval får aldrig leda till förkastad. Att förkasta en hypotes man inte
mätte tillräckligt är att kasta bort en möjlig sanning och kalla det ett
resultat — och utfallet ser likadant ut som ett riktigt nej.

En kontroll som inte gick att köra räknas som ej uppfylld, aldrig som godkänd.

### Policyn ger ingenting

En `HISTORICALLY_VALIDATED_CANDIDATE` är fortfarande inte runtime och fortfarande
inte Paper. Det avgörs av `researchHypothesisService.LIFECYCLE_GATES`, inte här.

---

## 2026-08-20 — Research Evidence Policy v1 GODKÄND och inkopplad

`thresholdsStatus` = **`approved`**. De fyra trösklar som saknade förlaga i koden
godkändes med oförändrade värden (`minTradingDays 20`, `minEdgeRetention 0,50`,
`maxTopDayShare 0,35`, `minPositiveDayShare 0,40`) och bär nu härkomsten
`HUMAN_APPROVED`, skild från `PROJECT_DERIVED` så att den som läser policyn om
ett år kan se vilka tal som härleddes ur systemet och vilka som var ett omdöme.
Nettokraven på båda perioderna står kvar.

Statusen räknas ur trösklarna, inte ur en handskriven sträng — policyn kan
därför aldrig påstå sig vara beslutad medan något förslag väntar.

### Inkopplingspunkt

`runNativeReplayWorker.js`, efter bokföringen och i samma barnprocess.
`researchEvidenceLedgerService` läser bibliotekets rader för hypotesen, delar dem
på research- och validationsperioden med dataset-gränsen, aggregerar och anropar
`policy.classify()`. Utfallet följer med i workerns svar.

**Domen lagras inte.** Den härleds ur biblioteket vid varje anrop och kan därför
aldrig säga något annat än evidensen den bygger på — evidensen växer för varje
bokfört dygn, och en lagrad dom hade varit inaktuell i samma stund.

Bibliotekets `LIFECYCLE_TRANSITION` används medvetet **inte**. Den tillhör
strategilivscykeln (draft → … → paper → live), och att skriva
`HISTORICALLY_VALIDATED_CANDIDATE` som ett bibliotekssteg hade dragit in
hypotesen på vägen mot Paper — precis vad research-livscykelns grindar finns
för att förhindra.

### Två defekter rättade vid inkopplingen

1. **`num(null)` returnerade 0**, eftersom `Number(null)` är 0. Ett SAKNAT netto
   blev därmed ett uppmätt nollresultat, och policyn förkastade en hypotes på
   grund av en bokföringsbrist.
2. **Ett omätbart teckentest räknades som negativt.** Nu ger det
   `INSUFFICIENT_EVIDENCE` med skälet `sign_test_not_measurable` — samma princip
   som för små urval: det som inte gick att mäta är inte ett nej.

### Känd konsekvens

Cykel 1 och 2:s biblioteksrader saknar `netPnlUsd` (fältet persisterades först
2026-08-20). Den biblioteksbaserade klassificeringen ger därför
`INSUFFICIENT_EVIDENCE / sign_test_not_measurable` för dem. Deras faktiska
klassificering — 19 förkastade, 3 otillräckliga — bygger på de uppmätta
aggregaten och är fryst i `cycle12Evidence.fixture.json`. Historiska rader
skrivs inte om.
