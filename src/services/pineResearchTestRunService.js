'use strict';

const model = require('./pineResearchModelService');

const DEFAULT_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const DEFAULT_TIMEFRAMES = Object.freeze(['1m', '5m', '15m']);
const DEFAULT_ENGINES = Object.freeze(['batch', 'replay']);

function defaultDateRange() {
  return {
    from: '2025-01-01',
    to: '2025-12-31',
  };
}

function uniqueStrings(values, fallback) {
  const list = Array.isArray(values) ? values : fallback;
  const out = [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))];
  return out.length ? out : fallback;
}

function assessParity(version, engine, symbol, timeframe) {
  const warnings = [];
  const unsupported = [];
  const parameters = version.parameters || {};
  if (!DEFAULT_SYMBOLS.includes(String(symbol).toUpperCase())) unsupported.push('symbol_not_in_pine_research_scope');
  if (!DEFAULT_TIMEFRAMES.includes(String(timeframe))) unsupported.push('timeframe_not_in_pine_research_scope');
  if (version.baseStrategyId !== 'opening_range_breakout') unsupported.push('internal_adapter_missing_for_strategy');
  if (!['batch', 'replay', 'internal_preview'].includes(engine)) unsupported.push('engine_not_supported_for_internal_research');
  if (parameters.entryMode && !['breakout', 'retest'].includes(parameters.entryMode)) unsupported.push('entry_mode_not_mapped');
  if (parameters.stopMode && !['range', 'fixed', 'fixed_points'].includes(parameters.stopMode)) unsupported.push('stop_mode_not_mapped');

  warnings.push('pine_rules_are_translated_to_internal_research_spec_not_executed_as_pine');
  warnings.push('tradingview_external_validation_required_for_full_parity');

  if (unsupported.length) {
    return {
      parityStatus: 'unsupported',
      blockedReason: unsupported.join(','),
      warnings,
    };
  }

  return {
    parityStatus: 'partial',
    blockedReason: 'internal_batch_replay_parity_not_certified_for_pine_version',
    warnings,
  };
}

function createTestPlan(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const symbols = uniqueStrings(options.symbols || version.symbolRoots, DEFAULT_SYMBOLS).map((symbol) => symbol.toUpperCase());
  const timeframes = uniqueStrings(options.timeframes || version.timeframes, DEFAULT_TIMEFRAMES);
  const engines = uniqueStrings(options.engines || DEFAULT_ENGINES, DEFAULT_ENGINES);
  const dateRange = options.dateRange || defaultDateRange();
  const maxTests = Math.max(1, Math.min(100, Number(options.maxTests || 18)));
  const plans = [];

  for (const engine of engines) {
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        if (plans.length >= maxTests) break;
        const parity = assessParity(version, engine, symbol, timeframe);
        plans.push(model.normalizeTestRun({
          candidateId: version.candidateId,
          pineVersionId: version.pineVersionId,
          engine,
          symbol,
          timeframe,
          dateRange,
          parameters: version.parameters,
          dataSource: 'internal_historical_data',
          commission: Number(version.riskRules?.commission || 2),
          slippage: Number(version.riskRules?.slippage || 1),
          direction: version.direction,
          marketRegime: options.marketRegime || 'all',
          session: version.parameters.session || '0930-1600',
          status: parity.parityStatus === 'supported' ? 'planned' : 'blocked',
          parityStatus: parity.parityStatus,
          blockedReason: parity.blockedReason,
          metrics: {},
          tradeCount: 0,
        }));
      }
    }
  }

  return model.withSafety({
    ok: true,
    pineVersionId: version.pineVersionId,
    candidateId: version.candidateId,
    status: plans.some((plan) => plan.status === 'planned') ? 'planned' : 'blocked',
    blockedReason: plans.every((plan) => plan.status === 'blocked') ? 'no_certified_internal_pine_parity' : null,
    plans,
    warnings: [...new Set(plans.flatMap((plan) => [plan.blockedReason].filter(Boolean)))],
  });
}

function runTestPlan(versionInput, options = {}) {
  const store = options.store;
  const plan = Array.isArray(options.plans) && options.plans.length
    ? model.withSafety({ ok: true, plans: options.plans.map(model.normalizeTestRun) })
    : createTestPlan(versionInput, options);
  const completed = plan.plans.map((run) => {
    const blocked = run.status === 'blocked' || run.parityStatus !== 'supported';
    const result = model.normalizeTestRun({
      ...run,
      status: blocked ? 'blocked' : 'failed',
      blockedReason: run.blockedReason || (blocked ? 'internal_parity_not_supported' : 'internal_runner_not_connected'),
      startedAt: model.nowIso(),
      completedAt: model.nowIso(),
      metrics: {},
      tradeCount: 0,
    });
    if (store && typeof store.saveTestRun === 'function') store.saveTestRun(result);
    return result;
  });

  if (store && typeof store.appendEvent === 'function') {
    store.appendEvent({
      type: 'test_runs.run_blocked_or_completed',
      id: versionInput.pineVersionId,
      at: model.nowIso(),
      details: { count: completed.length },
    });
  }

  return model.withSafety({
    ok: true,
    status: completed.some((run) => run.status === 'completed') ? 'completed' : 'blocked',
    blockedReason: completed.every((run) => run.status === 'blocked') ? 'no_certified_internal_pine_parity' : null,
    testRuns: completed,
  });
}

module.exports = {
  DEFAULT_SYMBOLS,
  DEFAULT_TIMEFRAMES,
  DEFAULT_ENGINES,
  defaultDateRange,
  assessParity,
  createTestPlan,
  runTestPlan,
};
