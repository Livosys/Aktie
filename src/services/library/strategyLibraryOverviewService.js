'use strict';

// ── Library-fälten på den befintliga strategiöversikten ──────────────────────
//
// Uppgiften är uttrycklig: bygg inga nya sidor, duplicera ingen UI. Strategy
// Library ska synas där strategierna redan visas.
//
// Översiktsraderna i futuresPaperDeskService bär redan executionStrategyId
// (native-id:t som hamnar på order och trades). Biblioteket är nycklat på samma
// id, så raderna behöver bara BERIKAS — inte byggas om, och absolut inte
// dupliceras till en andra lista.
//
// Fyra fält läggs till per rad: lifecycle, confidence, promotion status och
// retirement status. Inget befintligt fält rörs.
//
// Robusthet framför fullständighet: går biblioteket inte att läsa returneras
// raderna oförändrade med en förklaring. En strategiöversikt som slutar rendera
// för att en analysfunktion har ett läsfel vore en försämring av driften.

const libraryModule = require('./strategyLibraryService');
const promotionEngine = require('./promotionEngineService');
const retirementEngine = require('./retirementEngineService');
const lifecycle = require('./strategyLifecycle');
const strategyScoreV1 = require('../score/strategyScoreV1Service');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'strategy_library_overview',
});

function libraryViewFor(record, { now }) {
  if (!record) {
    return {
      lifecycle: null,
      lifecycleLabel: null,
      confidenceScore: null,
      promotionStatus: 'not_in_library',
      promotionTo: null,
      promotionBlockers: [],
      retirementStatus: 'unknown',
      retirementReason: null,
      inLibrary: false,
    };
  }

  const promotion = promotionEngine.evaluatePromotion(record);
  const retirement = retirementEngine.evaluateRetirement(record, { now });

  return {
    lifecycle: record.lifecycle,
    lifecycleLabel: lifecycle.STAGE_LABELS_SV[record.lifecycle] || record.lifecycle,
    lifecycleIndex: lifecycle.describeStage(record.lifecycle).index,
    confidenceScore: record.confidenceScore,
    strategyScoreLibrary: record.strategyScore,
    executionScoreLibrary: record.executionScore,
    productionScore: record.productionScore,
    // Ett Production Score på fem affärer är inget omdöme. Talet visas, men
    // flaggan låter UI:t säga att det inte går att luta sig mot — samma
    // tröskel som Strategy Score använder, hämtad från samma ställe.
    productionScoreQualified: record.paperHistory.length >= strategyScoreV1.MIN_TRADES_FOR_RANKING,
    promotionStatus: retirement.alreadyRetired ? 'retired'
      : promotion.allowed ? 'ready'
        : promotion.to ? 'blocked' : 'terminal',
    promotionTo: promotion.to || null,
    promotionBlockers: promotion.blockers || [],
    retirementStatus: retirement.alreadyRetired ? 'retired'
      : retirement.shouldRetire ? 'suggested' : 'active',
    retirementReason: retirement.alreadyRetired
      ? (record.retirementHistory.at(-1)?.reason || null)
      : (retirement.primaryReason || null),
    replayRuns: record.replayHistory.length,
    paperTrades: record.paperHistory.length,
    liveTrades: record.liveHistory.length,
    currentDnaHash: record.currentDnaHash,
    currentMarketDnaHash: record.currentMarketDnaHash,
    inLibrary: true,
  };
}

/**
 * Berikar befintliga översiktsrader med biblioteksfälten.
 *
 * @param {object[]} rows     rader från buildCanonicalStrategyOverview
 * @param {object}   options  { library, now }
 */
function enrichStrategyOverview(rows = [], options = {}) {
  const library = options.library || libraryModule.defaultStrategyLibrary;
  const now = options.now || new Date();

  let byId = null;
  let error = null;
  try {
    byId = new Map(library.listStrategies().map((record) => [record.strategyId, record]));
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }

  if (!byId) {
    return {
      rows,
      library: { ok: false, error, strategies: 0 },
      ...SAFETY,
    };
  }

  const enriched = rows.map((row) => {
    // Raden är nycklad på legacy-id, men biblioteket på native-id. Raden bär
    // redan översättningen i executionStrategyId — ingen ny mappning behövs.
    const key = row.executionStrategyId || row.nativeStrategyId || row.strategyId;
    return { ...row, library: libraryViewFor(byId.get(key) || null, { now }) };
  });

  return {
    rows: enriched,
    library: {
      ok: true,
      strategies: byId.size,
      inLibrary: enriched.filter((row) => row.library.inLibrary).length,
      promotable: enriched.filter((row) => row.library.promotionStatus === 'ready').length,
      retirementSuggested: enriched.filter((row) => row.library.retirementStatus === 'suggested').length,
      retired: enriched.filter((row) => row.library.retirementStatus === 'retired').length,
    },
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  enrichStrategyOverview,
  _internal: { libraryViewFor },
};
