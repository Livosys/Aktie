'use strict';

const model = require('./pineResearchModelService');

function numberMetric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function metricDiff(tradingViewMetrics = {}, internalMetrics = {}, key) {
  const tv = numberMetric(tradingViewMetrics[key]);
  const internal = numberMetric(internalMetrics[key]);
  if (tv === null || internal === null) {
    return { key, tradingView: tv, internal, difference: null, status: 'missing' };
  }
  return { key, tradingView: tv, internal, difference: tv - internal, status: 'available' };
}

function classifyDiffs(differences) {
  const available = Object.values(differences).filter((item) => item && item.status === 'available');
  if (!available.length) return 'needs_review';
  const large = available.some((item) => {
    const denom = Math.max(1, Math.abs(Number(item.internal) || 0));
    const pct = Math.abs(Number(item.difference) || 0) / denom;
    if (item.key === 'tradeCount') return Math.abs(item.difference) > 2;
    if (item.key === 'winRate') return Math.abs(item.difference) > 5;
    return pct > 0.15;
  });
  if (large) return 'major_differences';
  const minor = available.some((item) => Math.abs(Number(item.difference) || 0) > 0);
  return minor ? 'minor_differences' : 'matched';
}

function compareMetrics({ tradingViewMetrics = {}, internalMetrics = {} }) {
  const keys = ['tradeCount', 'netPnl', 'profitFactor', 'winRate', 'maxDrawdown', 'commission'];
  const differences = Object.fromEntries(keys.map((key) => [key, metricDiff(tradingViewMetrics, internalMetrics, key)]));
  const validationStatus = classifyDiffs(differences);
  return model.withSafety({
    ok: true,
    differences,
    validationStatus,
    warnings: Object.values(differences).filter((item) => item.status === 'missing').map((item) => `${item.key}_missing_for_comparison`),
  });
}

function compareTradingViewValidation(options = {}) {
  const store = options.store;
  if (!store) throw new Error('store_is_required');
  const validation = options.validation || store.findById('validations', options.validationId);
  if (!validation) throw new Error('validation_not_found');
  const internalTestRunId = options.internalTestRunId || validation.internalTestRunId;
  const testRun = internalTestRunId ? store.findById('testRuns', internalTestRunId) : null;
  const internalMetrics = options.internalMetrics || testRun?.metrics || {};
  const compared = compareMetrics({
    tradingViewMetrics: validation.tradingViewMetrics || {},
    internalMetrics,
  });
  const saved = store.saveValidation({
    ...validation,
    internalTestRunId: internalTestRunId || null,
    internalMetrics,
    differences: compared.differences,
    validationStatus: compared.validationStatus,
    warnings: [...new Set([...(validation.warnings || []), ...(compared.warnings || [])])],
  });
  return model.withSafety({
    ok: true,
    validation: saved,
    comparison: compared,
  });
}

module.exports = {
  metricDiff,
  compareMetrics,
  compareTradingViewValidation,
};
