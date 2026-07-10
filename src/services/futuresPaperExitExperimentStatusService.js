'use strict';

// Futures Paper Exit-experiment — READ-ONLY datainsamlingsstatus.
// Rapporterar hur långt MFE/MAE-instrumenteringen kommit. Bygger INGET
// experiment, aktiverar ingen exit-modell, muterar ingenting.
//
// Feature flag EXIT_EXPERIMENT_ENABLED default OFF → profit-lock/trailing körs
// aldrig. Denna service beskriver bara insamlad datamängd.

const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_exit_experiment_status',
});

// Trösklar innan ett exit-experiment får startas (per användarens spec).
const READINESS = Object.freeze({
  minNewClosedTrades: 10,
  minStrategiesRepresented: 3,
  minTradesWithFullMfeMae: 5,
});

function nowIso() { return new Date().toISOString(); }

function experimentEnabled() {
  return String(process.env.EXIT_EXPERIMENT_ENABLED || '').trim().toLowerCase() === 'true';
}

function canonicalId(rawId) {
  const s = rawId == null ? '' : String(rawId).trim();
  if (!s) return null;
  try {
    const norm = strategyIdNormalizer.normalizeStrategyId(s);
    if (norm && norm.canonicalStrategyId) return norm.canonicalStrategyId;
  } catch (err) { /* fallback */ }
  return s;
}

// En trade räknas som "full MFE/MAE-data" när instrumenteringen mätt banan:
// mfeMaeSource satt OCH minst en excursion-mätning finns (points ej null).
function hasFullMfeMae(row) {
  return !!row
    && row.mfeMaeSource != null
    && row.maximumFavorableExcursionPoints != null
    && row.maximumAdverseExcursionPoints != null
    && row.exitType != null
    && row.exitType !== 'unknown_legacy';
}

function getStatus() {
  let closed = [];
  try {
    const positions = futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperPositions();
    closed = Array.isArray(positions.closedPositions) ? positions.closedPositions : [];
  } catch (err) { closed = []; }

  const instrumented = closed.filter((r) => r && r.mfeMaeSource != null);
  const withFull = closed.filter(hasFullMfeMae);
  const strategies = new Set(withFull.map((r) => canonicalId(r.strategyId)).filter(Boolean));

  // Datakälla: 'real' bara om samtliga instrumenterade trades använt riktigt pris.
  const anyReal = instrumented.some((r) => r.measurementQuality === 'real');
  const anySimulated = instrumented.some((r) => r.measurementQuality !== 'real');
  const dataSource = instrumented.length === 0
    ? 'none'
    : (anyReal && !anySimulated ? 'real' : (anyReal ? 'mixed' : 'simulated_fallback'));

  const criteria = {
    newClosedTrades: { value: instrumented.length, required: READINESS.minNewClosedTrades, met: instrumented.length >= READINESS.minNewClosedTrades },
    strategiesRepresented: { value: strategies.size, required: READINESS.minStrategiesRepresented, met: strategies.size >= READINESS.minStrategiesRepresented },
    tradesWithFullMfeMae: { value: withFull.length, required: READINESS.minTradesWithFullMfeMae, met: withFull.length >= READINESS.minTradesWithFullMfeMae },
  };
  const readyForExperiment = Object.values(criteria).every((c) => c.met);

  return {
    status: 'ok',
    readOnly: true,
    generatedAt: nowIso(),
    headline: 'Exit-experiment',
    collectionStatus: 'Datainsamling pågår',
    instrumentation: {
      mfeMaeInstrumentation: 'active',
      profitLockTest: experimentEnabled() ? 'enabled' : 'not_activated',
      trailingStopTest: experimentEnabled() ? 'enabled' : 'not_activated',
      experimentEnabled: experimentEnabled(),
    },
    counters: {
      totalClosedTrades: closed.length,
      collectedNewTrades: instrumented.length,
      tradesWithFullMfeMae: withFull.length,
      strategiesRepresented: strategies.size,
      strategyIds: [...strategies].sort(),
      dataSource,
    },
    readiness: {
      readyForExperiment,
      criteria,
      note: readyForExperiment
        ? 'Insamlingskriterier uppfyllda — experiment kan aktiveras efter separat godkännande.'
        : 'Fler instrumenterade trades behövs innan experimentet kan starta.',
    },
    notRealMarketPerformance: dataSource !== 'real',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  READINESS,
  experimentEnabled,
  hasFullMfeMae,
  getStatus,
};
