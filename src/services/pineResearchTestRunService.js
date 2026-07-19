'use strict';

const model = require('./pineResearchModelService');
const orbAdapter = require('./pineResearchOrbAdapterService');

const DEFAULT_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const DEFAULT_TIMEFRAMES = Object.freeze(['1m', '5m', '15m']);
const DEFAULT_ENGINES = Object.freeze(['internal_preview']);

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

function buildOrbParityMatrix(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const parity = orbAdapter.buildParityMatrix(version, options);
  return model.withSafety({
    ok: true,
    candidateId: parity.candidateId,
    pineVersionId: parity.pineVersionId,
    engine: parity.engine,
    symbol: parity.symbol,
    timeframe: parity.timeframe,
    parityStatus: parity.parityStatus,
    certified: parity.certified,
    wouldRun: parity.certified,
    blockedReason: parity.blockedReason,
    supportedRules: parity.supportedRules,
    unsupportedRules: parity.unsupportedRules,
    matrix: parity.matrix,
  });
}

function assessParity(version, engine, symbol, timeframe) {
  const warnings = [];
  const unsupported = [];
  if (!DEFAULT_SYMBOLS.includes(String(symbol).toUpperCase())) unsupported.push('symbol_not_in_pine_research_scope');
  if (!DEFAULT_TIMEFRAMES.includes(String(timeframe))) unsupported.push('timeframe_not_in_pine_research_scope');
  if (version.baseStrategyId !== 'opening_range_breakout') unsupported.push('internal_adapter_missing_for_strategy');
  if (!['batch', 'replay', 'internal_preview'].includes(engine)) unsupported.push('engine_not_supported_for_internal_research');

  warnings.push('pine_rules_are_translated_to_internal_research_spec_not_executed_as_pine');
  warnings.push('tradingview_external_validation_required_for_full_parity');

  if (unsupported.length) {
    return {
      parityStatus: 'unsupported',
      blockedReason: unsupported.join(','),
      supportedRules: [],
      unsupportedRules: unsupported,
      parityMatrix: [],
      warnings,
    };
  }
  const parity = orbAdapter.buildParityMatrix(version, { engine, symbol, timeframe });
  return {
    parityStatus: parity.parityStatus,
    blockedReason: parity.blockedReason,
    supportedRules: parity.supportedRules,
    unsupportedRules: parity.unsupportedRules,
    parityMatrix: parity.matrix,
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
          status: parity.parityStatus === 'certified' ? 'planned' : 'blocked',
          parityStatus: parity.parityStatus,
          blockedReason: parity.blockedReason,
          supportedRules: parity.supportedRules,
          unsupportedRules: parity.unsupportedRules,
          parityMatrix: parity.parityMatrix,
          wouldRun: parity.parityStatus === 'certified',
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

function executeCertifiedRun(version, run, options = {}) {
  const dateRange = run.dateRange && run.dateRange.from ? run.dateRange : defaultDateRange();
  const readiness = orbAdapter.assessDataReadiness(
    { symbol: run.symbol, timeframe: run.timeframe, timezone: version.parameters?.timezone },
    { dateRange, rootDir: options.dataRootDir, minReadyDays: options.minReadyDays },
  );
  if (readiness.dataStatus !== 'ready') {
    return {
      run: model.normalizeTestRun({
        ...run,
        status: 'blocked',
        blockedReason: readiness.dataBlockedReason || `historical_data_${readiness.dataStatus}`,
        startedAt: model.nowIso(),
        completedAt: model.nowIso(),
        metrics: {},
        tradeCount: 0,
      }),
      readiness,
      backtest: null,
    };
  }
  const loaded = orbAdapter.loadCandles({
    symbol: run.symbol,
    timeframe: run.timeframe,
    dateRange,
    rootDir: options.dataRootDir,
  });
  const startedAt = model.nowIso();
  const backtest = orbAdapter.runOrbBacktest(version, loaded.bars, {
    symbol: run.symbol,
    timeframe: run.timeframe,
  });
  if (!backtest.ok) {
    return {
      run: model.normalizeTestRun({
        ...run,
        status: 'blocked',
        blockedReason: backtest.error || 'orb_adapter_rejected_spec',
        startedAt,
        completedAt: model.nowIso(),
        metrics: {},
        tradeCount: 0,
      }),
      readiness,
      backtest,
    };
  }
  const dataQualityWarnings = [...new Set([...readiness.warnings, ...backtest.warnings])].slice(0, 20);
  return {
    run: model.normalizeTestRun({
      ...run,
      status: 'completed',
      blockedReason: null,
      startedAt,
      completedAt: model.nowIso(),
      metrics: {
        ...backtest.metrics,
        dataQualityWarnings,
        bars: readiness.bars,
        sessionDays: readiness.sessionDays,
        completeSessionDays: readiness.completeSessionDays,
        dataSource: readiness.dataSource,
      },
      tradeCount: backtest.metrics.tradeCount,
    }),
    readiness,
    backtest,
  };
}

function runTestPlan(versionInput, options = {}) {
  const store = options.store;
  const version = model.normalizeVersion(versionInput);
  const plan = Array.isArray(options.plans) && options.plans.length
    ? model.withSafety({ ok: true, plans: options.plans.map(model.normalizeTestRun) })
    : createTestPlan(versionInput, options);
  const completed = plan.plans.map((run) => {
    let result;
    if (run.status === 'blocked' || run.parityStatus !== 'certified') {
      result = model.normalizeTestRun({
        ...run,
        status: 'blocked',
        blockedReason: run.blockedReason || 'internal_parity_not_supported',
        startedAt: model.nowIso(),
        completedAt: model.nowIso(),
        metrics: {},
        tradeCount: 0,
      });
    } else {
      const executed = executeCertifiedRun(version, run, options);
      result = executed.run;
      if (result.status === 'completed' && store && typeof store.writeArtifact === 'function' && executed.backtest) {
        const artifact = store.writeArtifact('artifacts', `test-run-${result.testRunId}`, JSON.stringify({
          testRunId: result.testRunId,
          pineVersionId: result.pineVersionId,
          symbol: result.symbol,
          timeframe: result.timeframe,
          dateRange: result.dateRange,
          metrics: result.metrics,
          trades: executed.backtest.trades,
          readiness: executed.readiness,
        }, null, 2), 'json');
        result = model.normalizeTestRun({ ...result, resultArtifact: artifact.artifact });
      }
    }
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
    blockedReason: completed.every((run) => run.status === 'blocked') ? (completed[0]?.blockedReason || 'no_runnable_test_plan') : null,
    testRuns: completed,
  });
}

function previewSingleTestRun(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const engine = String(options.engine || 'internal_preview');
  const symbol = String(options.symbol || 'MNQ').toUpperCase();
  const timeframe = String(options.timeframe || '5m');
  const dateRange = options.dateRange || defaultDateRange();
  const parity = orbAdapter.buildParityMatrix(version, { engine, symbol, timeframe });
  const readiness = orbAdapter.assessDataReadiness(
    { symbol, timeframe, timezone: version.parameters?.timezone },
    { dateRange, rootDir: options.dataRootDir, minReadyDays: options.minReadyDays },
  );
  const wouldRun = parity.certified && readiness.dataStatus === 'ready';
  const blockedReason = wouldRun
    ? null
    : (parity.certified ? (readiness.dataBlockedReason || `historical_data_${readiness.dataStatus}`) : parity.blockedReason);
  return model.withSafety({
    ok: true,
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    engine,
    symbol,
    resolvedSymbol: readiness.resolvedSymbol,
    timeframe,
    dateRange,
    parameters: version.parameters,
    parityStatus: parity.parityStatus,
    dataStatus: readiness.dataStatus,
    dataSource: readiness.dataSource,
    dataDir: readiness.dataDir,
    bars: readiness.bars,
    sessionDays: readiness.sessionDays,
    completeSessionDays: readiness.completeSessionDays,
    firstBarAt: readiness.firstBarAt,
    lastBarAt: readiness.lastBarAt,
    dataQualityWarnings: readiness.warnings,
    supportedRules: parity.supportedRules,
    unsupportedRules: parity.unsupportedRules,
    parityMatrix: parity.matrix,
    wouldRun,
    blockedReason,
  });
}

function runSingleTestRun(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const store = options.store;
  const engine = String(options.engine || 'internal_preview');
  const symbol = String(options.symbol || 'MNQ').toUpperCase();
  const timeframe = String(options.timeframe || '5m');
  const dateRange = options.dateRange || defaultDateRange();
  const preview = previewSingleTestRun(version, { ...options, engine, symbol, timeframe, dateRange });

  if (!preview.wouldRun) {
    return model.withSafety({
      ok: false,
      status: 'blocked',
      blockedReason: preview.blockedReason,
      preview,
      testRun: null,
    });
  }

  const parity = orbAdapter.buildParityMatrix(version, { engine, symbol, timeframe });
  const planned = model.normalizeTestRun({
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    engine,
    symbol,
    timeframe,
    dateRange,
    parameters: version.parameters,
    dataSource: preview.dataSource,
    commission: Number(version.riskRules?.commission || 2),
    slippage: Number(version.riskRules?.slippage || 1),
    direction: version.direction,
    marketRegime: options.marketRegime || 'all',
    session: version.parameters.session || '0930-1600',
    status: 'planned',
    parityStatus: parity.parityStatus,
    supportedRules: parity.supportedRules,
    unsupportedRules: parity.unsupportedRules,
    parityMatrix: parity.matrix,
    wouldRun: true,
    metrics: {},
    tradeCount: 0,
  });
  const executed = executeCertifiedRun(version, planned, options);
  let result = executed.run;
  if (result.status === 'completed' && store && typeof store.writeArtifact === 'function' && executed.backtest) {
    const artifact = store.writeArtifact('artifacts', `test-run-${result.testRunId}`, JSON.stringify({
      testRunId: result.testRunId,
      pineVersionId: result.pineVersionId,
      symbol: result.symbol,
      timeframe: result.timeframe,
      dateRange: result.dateRange,
      metrics: result.metrics,
      trades: executed.backtest.trades,
      readiness: executed.readiness,
    }, null, 2), 'json');
    result = model.normalizeTestRun({ ...result, resultArtifact: artifact.artifact });
  }
  if (store && typeof store.saveTestRun === 'function') store.saveTestRun(result);
  if (store && typeof store.appendEvent === 'function') {
    store.appendEvent({
      type: 'test_runs.single_run',
      id: result.testRunId,
      at: model.nowIso(),
      details: { pineVersionId: version.pineVersionId, symbol, timeframe, status: result.status },
    });
  }

  return model.withSafety({
    ok: result.status === 'completed',
    status: result.status,
    blockedReason: result.blockedReason,
    preview,
    testRun: result,
  });
}

module.exports = {
  DEFAULT_SYMBOLS,
  DEFAULT_TIMEFRAMES,
  DEFAULT_ENGINES,
  defaultDateRange,
  buildOrbParityMatrix,
  assessParity,
  createTestPlan,
  runTestPlan,
  previewSingleTestRun,
  runSingleTestRun,
};
