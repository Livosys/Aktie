'use strict';

/**
 * IB Paper FUTURES — live view orchestrator (Fas 3.3, read-only).
 *
 * Chains the static Fas 1 contract spec + Fas 3.1 front-month resolver +
 * Fas 3.2 market-data snapshot into ONE merged read-only view for the
 * /futures/contracts endpoint and the Futures Control Room panel.
 *
 * HARD RULES:
 *   - Read-only. No order/submit/arm. `isTradablePreview` and `tradablePreview`
 *     are FORCED false on every contract (execution not implemented + submit
 *     routes gated) — even if front month AND price are fully verified.
 *   - Both data sources are GATED OFF by default. When both gates are off the
 *     output degrades to the Fas 1 static payload (no IB contact whatsoever),
 *     so the endpoint/UI keep the exact Phase-1 behaviour.
 *   - `contract_month_unverified` is only dropped per root when the front month
 *     is verified AND there is no spec-mismatch / near-expiry blocker.
 *   - `no_futures_market_data` is only dropped per root when hasUsablePrice=true
 *     (stale or missing price keeps the blocker; delayed data is transparent
 *     via `delayed_market_data` and never presented as realtime).
 *   - Never touches IB_PAPER_SUBMIT_ROUTES_ENABLED or any submit path.
 *
 * Resolvers are injectable so this orchestrator is fully mock-tested without
 * any live IB dependency.
 */

const {
  buildFuturesContracts,
  SAFETY,
} = require('./interactiveBrokersFuturesContractService');
const contractDetailsService = require('./interactiveBrokersFuturesContractDetailsService');
const marketDataService = require('./interactiveBrokersFuturesMarketDataService');

// Gated-only markers that should NOT be surfaced as extra per-contract merged
// blockers (they'd duplicate the Fas 1 static blockers and confuse the UI).
// They stay visible verbatim in detailBlockers/marketDataBlockers.
const GATED_MARKERS = new Set(['contract_details_disabled', 'market_data_disabled']);

// Detail blockers that keep `contract_month_unverified` in place even when IB
// returned a front month: a mismatching or roll-window contract must never be
// treated as a clean verified month.
const VERIFICATION_VETO_BLOCKERS = new Set(['contract_spec_mismatch', 'near_expiry_roll']);

function uniq(arr) {
  return [...new Set(arr)];
}

function indexByRoot(list) {
  const map = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.root) map[item.root] = item;
  }
  return map;
}

/**
 * Global blockers = the Fas 1 shared blockers, where each one is removed ONLY
 * when EVERY contract has cleared it (e.g. global `contract_month_unverified`
 * drops only when ALL roots are verified; `no_futures_market_data` only when
 * ALL roots have a usable price). Root-specific blockers (mismatch/near-expiry/
 * stale/delayed) stay per-contract and never claim global scope.
 */
function remainingGlobalBlockers(baseGlobalBlockers, contracts) {
  return (baseGlobalBlockers || []).filter(
    (b) => contracts.some((c) => (c.blockers || []).includes(b)),
  );
}

/**
 * Merge one Fas 3.1 resolved contract into the Fas 1 static contract.
 * Fills conId/localSymbol/contractMonth when IB verified them; drops the
 * per-root `contract_month_unverified` blocker ONLY on a clean verification
 * (no spec mismatch, not inside the roll guard).
 */
function mergeContractDetails(baseC, cdC, cdMeta = {}) {
  const detailBlockers = (cdC && Array.isArray(cdC.detailBlockers)) ? [...cdC.detailBlockers] : [];
  const surfaced = detailBlockers.filter((b) => !GATED_MARKERS.has(b));
  const verified = !!cdC && cdC.contractMonthVerified === true;

  if (!verified) {
    // Not verified: keep the static (null) expiry fields. Surface real detail
    // blockers (unavailable / spec-mismatch / near-expiry) but NOT gated markers.
    return {
      ...baseC,
      conId: null,
      daysToExpiry: null,
      contractDetailsSource: 'static_contract_spec',
      detailBlockers,
      detailError: cdC?.error ?? null,
      blockers: uniq([...(baseC.blockers || []), ...surfaced]),
    };
  }

  // Verified front month from IB (or enabled mock/cache).
  const cleanVerification = !surfaced.some((b) => VERIFICATION_VETO_BLOCKERS.has(b));
  const blockers = cleanVerification
    ? (baseC.blockers || []).filter((b) => b !== 'contract_month_unverified')
    : [...(baseC.blockers || [])];

  return {
    ...baseC,
    lastTradeDateOrContractMonth: cdC.lastTradeDateOrContractMonth ?? null,
    contractMonth: cdC.contractMonth ?? null,
    localSymbol: cdC.localSymbol ?? null,
    conId: cdC.conId ?? null,
    daysToExpiry: cdC.daysToExpiry ?? null,
    contractMonthVerified: true,
    contractDetailsSource: cdMeta.source || 'ib_reqContractDetails',
    detailBlockers,
    detailError: null,
    blockers: uniq([...blockers, ...surfaced]),
  };
}

/**
 * Merge one Fas 3.2 price row into the contract. `no_futures_market_data` is
 * dropped ONLY when hasUsablePrice=true; stale/delayed markers pass through.
 */
function mergeMarketData(baseC, mdC) {
  const marketDataBlockers = (mdC && Array.isArray(mdC.marketDataBlockers)) ? [...mdC.marketDataBlockers] : [];
  const hasUsablePrice = !!mdC && mdC.hasUsablePrice === true;

  let blockers = [...(baseC.blockers || [])];
  if (hasUsablePrice) {
    blockers = blockers.filter((b) => b !== 'no_futures_market_data');
  }
  const extra = marketDataBlockers
    .filter((b) => !GATED_MARKERS.has(b) && b !== 'no_futures_market_data');

  const stalenessSeconds = mdC?.stalenessSeconds ?? null;

  return {
    ...baseC,
    price: mdC?.price ?? null,
    priceField: mdC?.priceField ?? null,
    priceType: mdC?.priceType ?? null,
    bid: mdC?.bid ?? null,
    ask: mdC?.ask ?? null,
    last: mdC?.last ?? null,
    close: mdC?.close ?? null,
    marketDataTimestamp: mdC?.receivedAt ?? null,
    marketDataAgeMs: stalenessSeconds != null ? stalenessSeconds * 1000 : null,
    stale: mdC ? mdC.stale !== false : null,
    hasUsablePrice,
    marketDataBlockers,
    blockers: uniq([...blockers, ...extra]),
  };
}

/** Summary block for one live source (3.1 or 3.2) as exposed on the endpoint. */
function sourceSummary(result, perRootBlockerLists) {
  return {
    enabled: result?.enabled === true,
    gated: result?.gated !== false,
    source: result?.source || null,
    generatedAt: result?.generatedAt || null,
    blockers: uniq(perRootBlockerLists.flat()),
  };
}

/**
 * Build the merged read-only futures live view.
 *
 * @param {object} opts
 * @param {Date}   opts.now
 * @param {object} opts.contractDetails         - pre-fetched 3.1 result (tests)
 * @param {object} opts.marketData              - pre-fetched 3.2 result (tests)
 * @param {func}   opts.contractDetailsResolver - async (opts) => 3.1 result
 * @param {func}   opts.marketDataResolver      - async (opts) => 3.2 result
 */
async function buildFuturesLiveView(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
  const base = buildFuturesContracts();

  // Fas 3.1 — front-month resolution (gated OFF by default → no IB contact).
  const cdResolver = opts.contractDetailsResolver || contractDetailsService.getFrontMonthContracts;
  const cd = opts.contractDetails || await cdResolver({ now });
  const cdByRoot = indexByRoot(cd?.contracts);
  const cdMeta = { source: cd?.source || null };

  let contracts = base.contracts.map((c) => mergeContractDetails(c, cdByRoot[c.root], cdMeta));

  // Fas 3.2 — market data for the (now possibly verified) contracts.
  const mdResolver = opts.marketDataResolver || marketDataService.getMarketData;
  const md = opts.marketData || await mdResolver({ now, contracts });
  const mdByRoot = indexByRoot(md?.prices);

  contracts = contracts.map((c) => mergeMarketData(c, mdByRoot[c.root]));

  // Fas 3.3 safety net: NOTHING is tradable-preview here, ever — even with a
  // verified front month and a usable price. Execution is not implemented and
  // submit routes stay hard-gated.
  contracts = contracts.map((c) => ({ ...c, isTradablePreview: false, tradablePreview: false }));

  const bothGated = (cd?.gated !== false) && (md?.gated !== false);

  return {
    ...base,
    generatedAt: now.toISOString(),
    source: bothGated ? base.source : 'live_ib_futures',
    contracts,
    counts: {
      total: contracts.length,
      // Execution is not implemented → nothing is tradable-preview, ever, here.
      tradablePreview: contracts.filter((c) => c.tradablePreview === true).length,
      contractMonthVerified: contracts.filter((c) => c.contractMonthVerified === true).length,
      hasUsablePrice: contracts.filter((c) => c.hasUsablePrice === true).length,
      preferredFirstTest: contracts.filter((c) => c.preferredFirstTest).map((c) => c.root),
    },
    globalBlockers: remainingGlobalBlockers(base.globalBlockers, contracts),
    // Transparency: which live sources ran vs. stayed gated.
    contractDetails: sourceSummary(cd, contracts.map((c) => c.detailBlockers || [])),
    marketData: sourceSummary(md, contracts.map((c) => c.marketDataBlockers || [])),
    safety: { ...SAFETY },
  };
}

module.exports = {
  SAFETY,
  buildFuturesLiveView,
  _internal: {
    mergeContractDetails,
    mergeMarketData,
    remainingGlobalBlockers,
    indexByRoot,
    sourceSummary,
  },
};
