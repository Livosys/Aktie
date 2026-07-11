'use strict';

const model = require('./pineResearchModelService');

const DEFAULT_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const DEFAULT_TIMEFRAMES = Object.freeze(['1m', '5m', '15m']);
const DEFAULT_ENGINES = Object.freeze(['batch', 'replay']);
const CERTIFIED_MATCH = new Set(['exact', 'equivalent']);

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

function rule(name, pineBehavior, internalMotor, matchStatus, difference, action, mandatory = true) {
  return { rule: name, pineBehavior, internalMotor, matchStatus, difference, action, mandatory };
}

function buildOrbParityMatrix(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const p = version.parameters || {};
  const engine = String(options.engine || 'batch');
  const timeframe = String(options.timeframe || '5m');
  const symbol = String(options.symbol || 'MNQ').toUpperCase();
  const replayTimeframeStatus = engine === 'replay' && timeframe !== '2m' ? 'unsupported' : 'unknown';
  const batchTimeframeStatus = engine === 'batch' ? 'partial' : replayTimeframeStatus;
  const matrix = [
    rule('opening range start', `Pine starts from session ${p.session || '0930-1600'} in ${p.timezone || 'America/New_York'}.`, 'No certified ORB state builder is exposed by batch/replay.', 'unsupported', 'Internal engine has no audited opening-range window state for this PineVersion.', 'Add an ORB state builder that derives range from candles with timezone-aware session boundaries.'),
    rule('opening range end', `Pine ends opening range after ${p.openingRangeMinutes || 30} minutes.`, 'No certified dynamic openingRangeMinutes mapping.', 'unsupported', '15/30m parameter is not mapped into an internal ORB test contract.', 'Map openingRangeMinutes to internal candle window and prove boundary behavior.'),
    rule('New York timezone', `Pine uses ${p.timezone || 'America/New_York'}.`, 'Batch/replay candle APIs use stored candle timestamps; no ORB timezone boundary contract.', 'unknown', 'Timezone conversion parity is not documented for ORB.', 'Document and test timestamp conversion against America/New_York sessions.'),
    rule('15/30 min opening range', `Pine supports openingRangeMinutes=${p.openingRangeMinutes || 30}.`, 'TradingView blueprint has pseudo ORB references only; batch/replay lacks certified ORB parameter handling.', 'unsupported', 'No reusable ORB parameter adapter exists yet.', 'Implement generic ORB family adapter from PineVersion parameters.'),
    rule('breakout definition', 'Pine enters on close above openingHigh or close below openingLow.', 'Existing batch grid tests catalog strategies and thresholds, not Pine close-vs-range breakout semantics.', 'unsupported', 'Breakout comparison is not proven equivalent.', 'Implement close-based ORB breakout signal evaluation.'),
    rule('entry on close or intrabar', 'Pine uses bar-close conditions in generated strategy code.', 'Replay scans candle stream through scanner engine signals, not this PineVersion close rule.', 'partial', 'Both use candles, but scanner entry timing is not equivalent to Pine bar-close entry.', 'Add explicit bar-close ORB adapter and test against generated Pine examples.'),
    rule('long/short direction', `Pine direction=${version.direction}.`, 'PineVersion direction is present in research TestRun metadata.', 'equivalent', 'Direction is carried but not executed by a certified ORB adapter.', 'Keep direction mapping in ORB adapter.'),
    rule('one trade per direction/day', 'Pine pyramiding=0 prevents simultaneous positions but does not explicitly cap per direction/day.', 'Batch/replay use separate trade/session risk concepts and max_trades in replay.', 'partial', 'Daily per-direction cap is not equivalent.', 'Add explicit ORB daily-entry ledger inside isolated test adapter if required.'),
    rule('last entry time', `Pine entry window ends at ${p.lastEntryTime || '11:30'}.`, 'No certified last-entry-time gate exists for ORB in batch/replay.', 'unsupported', 'Entry cutoff may not match.', 'Implement session-aware cutoff.'),
    rule('forced close', `Pine close_all near ${p.forcedCloseTime || '15:55'}.`, 'Replay has exit/risk handling, but no forced intraday ORB close parity.', 'unsupported', 'Forced close timing is not certified.', 'Add forced close event and test no overnight positions.'),
    rule('stop mode', `Pine stopMode=${p.stopMode || 'range'} stopValue=${p.stopValue || 20}.`, 'Batch grid has generic stop_loss percentages; replay uses exit/risk services.', 'partial', 'Range/fixed point stop is not mapped exactly.', 'Map ORB range/fixed point stops with futures tick/point semantics.'),
    rule('target mode', `Pine targetMode=${p.targetMode || 'risk_reward'} riskReward=${p.riskReward || 1.5}.`, 'Batch grid has generic take_profit values, not risk-reward derived from ORB stop.', 'partial', 'Target calculation is not equivalent.', 'Map target from stop distance and riskReward.'),
    rule('commission', `Pine strategy commission cash/contract=${version.riskRules?.commission ?? 2}.`, 'Research TestRun metadata carries commission but internal ORB fills are not certified.', 'partial', 'Commission can be stored but not applied by an ORB adapter yet.', 'Apply commission in isolated result metrics.'),
    rule('slippage', `Pine slippage=${version.riskRules?.slippage ?? 1}.`, 'Research TestRun metadata carries slippage but internal ORB fills are not certified.', 'partial', 'Slippage can be stored but not applied by an ORB adapter yet.', 'Apply slippage in isolated fill model.'),
    rule('session/day reset', 'Pine resets opening high/low on new session.', 'Replay risk state resets by day, but no ORB range reset contract exists.', 'partial', 'Daily risk reset is not the same as ORB range reset.', 'Add explicit ORB range reset test.'),
    rule('overnight prevention', 'Pine forced close prevents intraday overnight holds.', 'Replay sessions can close/stop, but no ORB overnight invariant is certified.', 'unsupported', 'No proof that ORB positions cannot remain overnight.', 'Add forced close and end-of-session invariant.'),
    rule('EMA filter', `Pine emaFilterEnabled=${p.emaFilterEnabled === true}.`, 'TradingView blueprint has EMA pseudo rules; internal ORB adapter missing.', p.emaFilterEnabled ? 'unsupported' : 'equivalent', p.emaFilterEnabled ? 'Enabled filter is not mapped.' : 'Disabled filter has no effect in both specs.', p.emaFilterEnabled ? 'Map EMA filter to candle indicator input.' : 'No action for disabled filter.', p.emaFilterEnabled === true),
    rule('volume filter', `Pine volumeFilterEnabled=${p.volumeFilterEnabled === true}.`, 'Batch grid has volume_requirement but no certified ORB volume filter mapping.', p.volumeFilterEnabled ? 'partial' : 'equivalent', p.volumeFilterEnabled ? 'Volume threshold concepts exist but are not equivalent to Pine volume > SMA*multiplier.' : 'Disabled filter has no effect in both specs.', p.volumeFilterEnabled ? 'Map exact volume SMA multiplier.' : 'No action for disabled filter.', p.volumeFilterEnabled === true),
    rule('retest entry', `Pine entryMode=${p.entryMode || 'breakout'}.`, 'No certified retest-entry state exists in batch/replay.', p.entryMode === 'retest' ? 'unsupported' : 'equivalent', p.entryMode === 'retest' ? 'Retest behavior is not mapped.' : 'Baseline breakout does not require retest.', p.entryMode === 'retest' ? 'Add retest state machine.' : 'No action for baseline breakout.', p.entryMode === 'retest'),
    rule('symbol support', `Research symbol=${symbol}.`, 'MNQ/MES are allowed research roots, but data availability must be separately proven.', DEFAULT_SYMBOLS.includes(symbol) ? 'partial' : 'unsupported', DEFAULT_SYMBOLS.includes(symbol) ? 'Scope is allowed but data/provider availability is not certified here.' : 'Symbol outside allowed Pine research roots.', 'Check historical data coverage before running.'),
    rule('timeframe support', `Requested timeframe=${timeframe}.`, engine === 'replay' ? 'Replay v2 currently only supports 2m.' : 'Batch accepts configured timeframes but does not certify ORB semantics.', batchTimeframeStatus, engine === 'replay' && timeframe !== '2m' ? 'Replay cannot run this timeframe.' : 'Timeframe acceptance is not enough for ORB parity.', 'Use only certified engine/timeframe combinations after adapter tests.'),
  ];
  const mandatoryRows = matrix.filter((item) => item.mandatory !== false);
  const certified = mandatoryRows.every((item) => CERTIFIED_MATCH.has(item.matchStatus));
  const unsupportedRules = matrix.filter((item) => !CERTIFIED_MATCH.has(item.matchStatus)).map((item) => item.rule);
  const supportedRules = matrix.filter((item) => CERTIFIED_MATCH.has(item.matchStatus)).map((item) => item.rule);
  return model.withSafety({
    ok: true,
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    engine,
    symbol,
    timeframe,
    parityStatus: certified ? 'certified' : 'blocked',
    certified,
    wouldRun: certified,
    blockedReason: certified ? null : 'orb_pine_parity_not_certified',
    supportedRules,
    unsupportedRules,
    matrix,
  });
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
      supportedRules: [],
      unsupportedRules: unsupported,
      parityMatrix: [],
      warnings,
    };
  }
  const parity = buildOrbParityMatrix(version, { engine, symbol, timeframe });
  if (parity.certified) {
    return {
      parityStatus: 'certified',
      blockedReason: null,
      supportedRules: parity.supportedRules,
      unsupportedRules: parity.unsupportedRules,
      parityMatrix: parity.matrix,
      warnings,
    };
  }

  return {
    parityStatus: 'blocked',
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

function runTestPlan(versionInput, options = {}) {
  const store = options.store;
  const plan = Array.isArray(options.plans) && options.plans.length
    ? model.withSafety({ ok: true, plans: options.plans.map(model.normalizeTestRun) })
    : createTestPlan(versionInput, options);
  const completed = plan.plans.map((run) => {
    const blocked = run.status === 'blocked' || run.parityStatus !== 'certified';
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

function previewSingleTestRun(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const engine = String(options.engine || 'batch');
  const symbol = String(options.symbol || 'MNQ').toUpperCase();
  const timeframe = String(options.timeframe || '5m');
  const dateRange = options.dateRange || defaultDateRange();
  const parity = buildOrbParityMatrix(version, { engine, symbol, timeframe });
  return model.withSafety({
    ok: true,
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    engine,
    symbol,
    timeframe,
    dateRange,
    parameters: version.parameters,
    parityStatus: parity.parityStatus,
    supportedRules: parity.supportedRules,
    unsupportedRules: parity.unsupportedRules,
    parityMatrix: parity.matrix,
    wouldRun: parity.wouldRun,
    blockedReason: parity.blockedReason,
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
};
