'use strict';

const strategyCatalog = require('./daytradingStrategyCatalogService');
const strategyRegistry = require('./strategyRegistryService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const RULE_HUMAN = Object.freeze({
  price_reclaims_vwap: 'Pris återtar VWAP',
  price_breaks_above_vwap: 'Pris bryter upp över VWAP',
  price_rejects_vwap: 'Pris avvisas vid VWAP',
  lower_high_near_vwap: 'Lägre topp nära VWAP',
  volume_above_average: 'Volym över snitt',
  volume_spike: 'Volymspik',
  momentum_up: 'Momentum upp',
  momentum_fades: 'Momentum avtar',
  avoid_extended_entry: 'Undvik för utsträckt entry',
  opening_range_defined: 'Opening range är definierad',
  breaks_range_with_volume: 'Bryter range med volym',
  holds_break_level: 'Håller breaknivån',
  market_open_only: 'Endast börsöppen session',
  ema_trend_aligned: 'EMA-trend är riktad',
  pullback_to_ema: 'Rekyl mot EMA',
  continuation_candle: 'Continuation candle',
  no_major_index_conflict: 'Ingen tydlig indexkonflikt',
  price_loses_ema: 'Pris tappar EMA',
  volume_expands: 'Volym expanderar',
  lower_low_confirmed: 'Lägre low bekräftas',
  avoid_chop: 'Undvik chop',
  narrow_state_detected: 'Narrow state är identifierad',
  narrow_score_gte_60: 'Narrow-score är minst 60',
  price_breaks_range: 'Pris bryter range',
  volume_or_relvol_confirms: 'Volym eller relvol bekräftar',
  vwap_side_aligned: 'VWAP-sidan är rätt',
  rsi_side_aligned: 'RSI-sidan är rätt',
  range_break_fails: 'Range-break misslyckas',
  fast_reentry_into_range: 'Snabb återgång in i range',
  volume_not_confirming_breakout: 'Volym bekräftar inte breakout',
  reversal_toward_vwap_or_mid: 'Vänder mot VWAP eller range-mid',
  price_near_range_edge: 'Pris nära range-kant',
  breakout_lacks_confirmation: 'Breakout saknar bekräftelse',
  vwap_present: 'VWAP finns tillgänglig',
  reversal_candle_or_rsi_shift: 'Reversal-candle eller RSI-skifte',
  relative_volume_spike: 'Relativ volymspik',
  fast_price_expansion: 'Snabb prisexpansion',
  spread_not_extreme: 'Spridning inte extrem',
  follow_through_required: 'Follow-through krävs',
  strong_directional_move: 'Stark riktad rörelse',
  breakout_follow_through: 'Breakout får follow-through',
  ema_trend_aligned: 'EMA-trend är riktad',
  pullback_to_vwap: 'Rekyl tillbaka till VWAP',
  vwap_bounce_up: 'VWAP-bounce upp',
  strong_move_up: 'Stark rörelse upp',
  volume_spike_exhaustion: 'Volymspik vid utmattning',
  stock_momentum_up: 'Aktiemomentum upp',
  qqq_or_spy_confirms: 'QQQ eller SPY bekräftar',
  crypto_symbol: 'Krypto-symbol',
  fast_momentum: 'Snabbt momentum',
  breakout: 'Breakout',
  opening_gap: 'Öppningsgap',
  gap_holds: 'Gap håller',
  volume_confirms_direction: 'Volym bekräftar riktning',
  no_immediate_fade: 'Ingen omedelbar fade',
  trend_confirmed: 'Trend är bekräftad',
  pause_or_flag: 'Paus eller flaggformation',
  breaks_pause_in_trend_direction: 'Bryter paus i trendens riktning',
  volume_not_weak: 'Volymen är inte svag',
  support_zone_identified: 'Stödzon identifierad',
  rejection_wick_or_hold: 'Avvisningswick eller hållning vid stöd',
  buyers_step_in: 'Köpare kliver in',
  risk_defined_below_support: 'Risk definieras under stöd',
  resistance_zone_identified: 'Motståndszon identifierad',
  failed_break_or_rejection: 'Misslyckat break eller avvisning',
  sellers_step_in: 'Säljare kliver in',
  risk_defined_above_resistance: 'Risk definieras över motstånd',
  price_extended_from_vwap: 'Pris är utsträckt från VWAP',
  reversal_candle: 'Reversal-candle',
  target_vwap_mean: 'Mål mot VWAP/mean',
});

const RULE_PINE = Object.freeze({
  price_reclaims_vwap: 'ta.crossover(close, vwap)',
  price_breaks_above_vwap: 'ta.crossover(close, vwap)',
  price_rejects_vwap: 'ta.crossunder(close, vwap)',
  lower_high_near_vwap: 'high < high[1] and close < vwap',
  volume_above_average: 'volume > ta.sma(volume, 20)',
  volume_spike: 'volume > ta.sma(volume, 20) * 1.5',
  momentum_up: 'ta.rising(close, 2)',
  momentum_fades: 'ta.falling(close, 2)',
  avoid_extended_entry: 'math.abs(close - vwap) < atr * 1.5',
  opening_range_defined: 'not na(orbHigh) and not na(orbLow)',
  breaks_range_with_volume: 'close > orbHigh and volume > volSma',
  holds_break_level: 'close > orbHigh',
  market_open_only: 'sessionRth',
  ema_trend_aligned: 'emaFast > emaSlow and close > emaFast',
  pullback_to_ema: 'low <= emaFast or close <= emaFast',
  continuation_candle: 'close > open',
  no_major_index_conflict: 'qqqTrendOk',
  price_loses_ema: 'ta.crossunder(close, emaFast)',
  volume_expands: 'volume > ta.sma(volume, 20) * 1.25',
  lower_low_confirmed: 'low < low[1]',
  avoid_chop: 'ta.adx(14) > 20',
  narrow_state_detected: 'narrowState',
  narrow_score_gte_60: 'narrowScore >= 60',
  price_breaks_range: 'close > rangeHigh or close < rangeLow',
  volume_or_relvol_confirms: 'volume > volSma or relVol > 1.5',
  vwap_side_aligned: 'close > vwap',
  rsi_side_aligned: 'ta.rsi(close, 14) > 50',
  range_break_fails: 'falseBreakout',
  fast_reentry_into_range: 'reentryIntoRange',
  volume_not_confirming_breakout: 'volume <= volSma * 1.1',
  reversal_toward_vwap_or_mid: 'close <= vwap or close <= rangeMid',
  price_near_range_edge: 'math.abs(close - rangeHigh) <= atr or math.abs(close - rangeLow) <= atr',
  breakout_lacks_confirmation: 'volume <= volSma and not ta.rising(close, 2)',
  vwap_present: 'not na(vwap)',
  reversal_candle_or_rsi_shift: 'bullishReversal or bearishReversal or ta.rsi(close, 14) crosses 50',
  relative_volume_spike: 'relVol > 2.0',
  fast_price_expansion: 'math.abs(close - open) > atr * 0.5',
  spread_not_extreme: 'spreadPct < maxSpreadPct',
  follow_through_required: 'close > close[1]',
  strong_directional_move: 'close > open and volume > volSma',
  breakout_follow_through: 'close > high[1]',
  pullback_to_vwap: 'low <= vwap',
  vwap_bounce_up: 'ta.crossover(close, vwap)',
  strong_move_up: 'close > open and ta.rising(close, 2)',
  momentum_exhaustion: 'ta.rsi(close, 14) > 70 and ta.falling(ta.rsi(close, 14), 2)',
  volume_spike_exhaustion: 'volume > ta.sma(volume, 20) * 1.5 and close < close[1]',
  stock_momentum_up: 'close > open and ta.rising(close, 2)',
  qqq_or_spy_confirms: 'qqqBullish or spyBullish',
  crypto_symbol: "syminfo.type == 'crypto'",
  fast_momentum: 'ta.roc(close, 1) > fastMomentumThreshold',
  breakout: 'close > high[1] or close < low[1]',
  opening_gap: 'open != close[1]',
  gap_holds: 'close > open',
  volume_confirms_direction: 'volume > volSma',
  no_immediate_fade: 'close >= open',
  trend_confirmed: 'emaFast > emaSlow and close > emaSlow',
  pause_or_flag: 'rangeCompression or flagPattern',
  breaks_pause_in_trend_direction: 'close > pauseHigh',
  volume_not_weak: 'volume > volSma',
  support_zone_identified: 'nearSupport',
  rejection_wick_or_hold: 'lowerWickRatio > wickThreshold',
  buyers_step_in: 'close > open',
  risk_defined_below_support: 'stopPrice < support',
  resistance_zone_identified: 'nearResistance',
  failed_break_or_rejection: 'failedBreakout or rejection',
  sellers_step_in: 'close < open',
  risk_defined_above_resistance: 'stopPrice > resistance',
  price_extended_from_vwap: 'math.abs(close - vwap) > vwapExtension',
  reversal_candle: 'bullishReversal or bearishReversal',
  target_vwap_mean: 'strategy.exit(..., limit = vwap)',
  narrow_state_detected: 'narrowState',
});

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null).map((item) => String(item));
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function titleFromRule(rule) {
  const raw = safeString(rule);
  if (!raw) return 'Okänd regel';
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function chooseTimeframe(strategy = {}) {
  const preferred = safeArray(strategy.default_timeframes || strategy.allowedTimeframes);
  return preferred[0] || '5m';
}

function inferSessionFilter(strategy = {}) {
  const market = safeString(strategy.market_group || strategy.market || 'all').toLowerCase();
  if (market === 'crypto') return '24x7';
  if (market === 'stocks') return 'RTH 09:30-16:00 ET';
  if (market === 'index' || market === 'etf') return 'RTH 09:30-16:00 ET';
  return 'RTH för aktier/ETF, 24x7 för krypto';
}

function inferRecommendedLookbackDays(timeframe, holdingMinutes) {
  const tf = safeString(timeframe, '5m').toLowerCase();
  if (tf.includes('1h')) return 90;
  if (tf.includes('30')) return 60;
  if (tf.includes('15')) return 45;
  if (tf.includes('5')) return 30;
  if (tf.includes('2')) return 20;
  if (tf.includes('1')) return Math.max(14, Math.round((safeNumber(holdingMinutes, 10) || 10) * 2));
  return 30;
}

function inferCooldownMinutes(strategy = {}) {
  const holding = safeNumber(strategy.default_holding_time_min ?? strategy.default_holding_time, 10) || 10;
  if (String(strategy.id || '').includes('opening_range')) return Math.max(30, holding * 2);
  if (String(strategy.id || '').includes('scalper') || String(strategy.id || '').includes('fast')) return 15;
  return Math.max(15, Math.round(holding * 1.5));
}

function inferMaxTradesPerDay(strategy = {}) {
  const id = String(strategy.id || '').toLowerCase();
  if (id.includes('news')) return 1;
  if (id.includes('opening_range')) return 2;
  if (id.includes('scalper') || id.includes('fast')) return 4;
  if (id.includes('mean_reversion')) return 3;
  if (strategy.direction === 'both') return 3;
  return 2;
}

function inferSetupType(strategy = {}) {
  if (strategy.family) return `${strategy.family}:${strategy.version || 'v1'}`;
  const id = String(strategy.id || '');
  if (id.includes('vwap')) return 'vwap';
  if (id.includes('ema')) return 'ema';
  if (id.includes('narrow')) return 'narrow_state';
  if (id.includes('opening_range')) return 'opening_range';
  if (id.includes('gap')) return 'gap';
  if (id.includes('trend')) return 'trend';
  if (id.includes('support')) return 'support';
  if (id.includes('resistance')) return 'resistance';
  if (id.includes('volume')) return 'volume';
  return 'general';
}

function inferIndicators(strategy = {}) {
  const explicit = safeArray(strategy.required_indicators || strategy.requiredIndicators);
  if (explicit.length) return explicit;
  const text = [
    strategy.id,
    strategy.name,
    strategy.description_sv,
    strategy.explanation,
    ...(strategy.signal_rules || []),
  ].filter(Boolean).join(' ').toLowerCase();
  const indicators = [];
  if (text.includes('vwap')) indicators.push('VWAP');
  if (text.includes('ema')) indicators.push('EMA');
  if (text.includes('narrow')) indicators.push('Narrow State');
  if (text.includes('range')) indicators.push('Range High/Low');
  if (text.includes('volume')) indicators.push('Volume');
  if (text.includes('rsi')) indicators.push('RSI');
  if (text.includes('atr') || text.includes('volatility')) indicators.push('ATR');
  if (text.includes('qqq') || text.includes('spy')) indicators.push('QQQ/SPY confirmation');
  if (text.includes('gap')) indicators.push('Prior close / opening gap');
  return unique(indicators);
}

function humanizeRule(rule) {
  return RULE_HUMAN[rule] || titleFromRule(rule);
}

function pineRule(rule) {
  return RULE_PINE[rule] || `/* ${rule} */`;
}

function buildConditionText(rules, fallback) {
  const list = safeArray(rules).map(humanizeRule).filter(Boolean);
  if (list.length) return list;
  return [fallback];
}

function buildPseudoBlock(rules, prefix) {
  const list = safeArray(rules).map(pineRule).filter(Boolean);
  if (!list.length) return `${prefix} = false`;
  return `${prefix} = ${list.join(' and ')}`;
}

function buildEntryConditionsPinePseudo(strategy, indicators) {
  const rules = safeArray(strategy.signal_rules || strategy.entryRules);
  const direction = safeString(strategy.direction, 'both').toLowerCase();
  const entry = buildPseudoBlock(rules, 'entryRaw');
  const indicatorSetup = [
    `vwap = ta.vwap(hlc3)`,
    `emaFast = ta.ema(close, 20)`,
    `emaSlow = ta.ema(close, 50)`,
    `volSma = ta.sma(volume, 20)`,
    `atr = ta.atr(14)`,
    `rangeHigh = ta.highest(high, 20)`,
    `rangeLow = ta.lowest(low, 20)`,
  ];
  if (safeArray(indicators).some((item) => /rsi/i.test(item))) indicatorSetup.push(`rsi = ta.rsi(close, 14)`);
  if (safeArray(indicators).some((item) => /narrow/i.test(item))) indicatorSetup.push(`narrowState = true`);

  const longBranch = direction !== 'short'
    ? `entryLong = ${entry}\nif entryLong\n    strategy.entry("L", strategy.long)`
    : null;
  const shortBranch = direction !== 'long'
    ? `entryShort = ${entry}\nif entryShort\n    strategy.entry("S", strategy.short)`
    : null;

  return [
    `// indicators`,
    ...indicatorSetup,
    `// entry logic`,
    longBranch,
    shortBranch,
  ].filter(Boolean).join('\n');
}

function buildExitConditionsPinePseudo(strategy) {
  const stopLossPct = safeNumber(strategy.default_stop_loss_pct ?? strategy.default_sl, null);
  const takeProfitR = safeNumber(strategy.default_take_profit_r ?? strategy.default_tp, null);
  const timeoutMin = safeNumber(strategy.default_timeout_min ?? strategy.default_holding_time_min ?? strategy.default_holding_time, null);
  const exitRules = safeArray(strategy.exit_rules || strategy.exitRules);
  const exitText = exitRules.length ? exitRules.map(humanizeRule) : ['Stop loss / take profit / timeout'];
  const lines = [
    `// exit rules`,
    `exitReason = ${exitText.map((text, index) => `${index === 0 ? '' : ' or '}${text}`).join('') || 'false'}`,
  ];
  if (stopLossPct != null || takeProfitR != null) {
    lines.push(`longStop = strategy.position_avg_price * (1 - ${safeNumber(stopLossPct, 0)} / 100)`);
    lines.push(`longLimit = strategy.position_avg_price * (1 + (${safeNumber(stopLossPct, 0)} / 100) * ${safeNumber(takeProfitR || 1, 1)})`);
    lines.push(`strategy.exit("XL", from_entry="L", stop=longStop, limit=longLimit)`);
    lines.push(`shortStop = strategy.position_avg_price * (1 + ${safeNumber(stopLossPct, 0)} / 100)`);
    lines.push(`shortLimit = strategy.position_avg_price * (1 - (${safeNumber(stopLossPct, 0)} / 100) * ${safeNumber(takeProfitR || 1, 1)})`);
    lines.push(`strategy.exit("XS", from_entry="S", stop=shortStop, limit=shortLimit)`);
  }
  if (timeoutMin != null) {
    lines.push(`// timeout: ${timeoutMin} minutes`);
  }
  return lines.join('\n');
}

function buildFiltersHuman(strategy, timeframe, sessionFilter) {
  const filters = [];
  const market = safeString(strategy.market_group || strategy.market || 'all');
  filters.push(`Market group: ${market}`);
  filters.push(`Timeframe: ${timeframe}`);
  filters.push(`Session: ${sessionFilter}`);
  if (safeNumber(strategy.confidence_threshold, null) != null) {
    filters.push(`Min confidence: ${strategy.confidence_threshold}`);
  }
  if (safeArray(strategy.allowedTimeframes || strategy.default_timeframes).length > 1) {
    filters.push(`Allowed timeframes: ${safeArray(strategy.allowedTimeframes || strategy.default_timeframes).join(', ')}`);
  }
  if (strategy.risk_notes) filters.push(`Risk note: ${strategy.risk_notes}`);
  return filters;
}

function buildFiltersPinePseudo(strategy, timeframe, sessionFilter) {
  const lines = [
    `sessionOk = true  // ${sessionFilter}`,
    `timeframeOk = timeframe.period == "${timeframe}"`,
  ];
  if (safeNumber(strategy.confidence_threshold, null) != null) {
    lines.push(`confidenceOk = confidence >= ${safeNumber(strategy.confidence_threshold, 0)}`);
  } else {
    lines.push('confidenceOk = true');
  }
  const market = safeString(strategy.market_group || strategy.market || 'all').toLowerCase();
  if (market === 'crypto') {
    lines.push("marketOk = syminfo.type == 'crypto'");
  } else if (market === 'stocks' || market === 'etf' || market === 'index') {
    lines.push("marketOk = syminfo.type == 'stock' or syminfo.type == 'index'");
  } else {
    lines.push('marketOk = true');
  }
  lines.push('filtersOk = sessionOk and timeframeOk and confidenceOk and marketOk');
  return lines.join('\n');
}

function buildRiskRules(strategy, maxTradesPerDay, cooldownMinutes, recommendedLookbackDays) {
  return {
    stopLossPct: safeNumber(strategy.default_stop_loss_pct ?? strategy.default_sl, null),
    takeProfitR: safeNumber(strategy.default_take_profit_r ?? strategy.default_tp, null),
    holdingMinutes: safeNumber(strategy.default_holding_time_min ?? strategy.default_holding_time, null),
    timeoutMinutes: safeNumber(strategy.default_timeout_min ?? strategy.default_holding_time_min ?? strategy.default_holding_time, null),
    confidenceThreshold: safeNumber(strategy.confidence_threshold, null),
    maxTradesPerDay,
    cooldownMinutes,
    recommendedLookbackDays,
    paperOnly: true,
  };
}

function buildMissingFields(strategy) {
  const missing = [];
  if (!safeArray(strategy.required_indicators || strategy.requiredIndicators).length) missing.push('required_indicators');
  if (!safeArray(strategy.signal_rules || strategy.entryRules).length) missing.push('entryConditions');
  if (!safeArray(strategy.exit_rules || strategy.exitRules).length) missing.push('exitConditions');
  if (!safeArray(strategy.default_timeframes || strategy.allowedTimeframes).length) missing.push('timeframe');
  if (strategy.default_stop_loss_pct == null && strategy.default_sl == null) missing.push('stopLoss');
  if (strategy.default_take_profit_r == null && strategy.default_tp == null) missing.push('takeProfit');
  if (strategy.default_holding_time_min == null && strategy.default_holding_time == null) missing.push('holdingTimeMinutes');
  if (strategy.max_trades_per_day == null) missing.push('maxTradesPerDay');
  if (strategy.cooldown_minutes == null) missing.push('cooldownMinutes');
  if (!strategy.session_filter) missing.push('sessionFilter');
  if (!strategy.symbol) missing.push('symbol');
  if (!strategy.setup_type) missing.push('setupType');
  if (!strategy.filters) missing.push('filters');
  return unique(missing);
}

function buildWarnings(strategy, registryRow, missingFields) {
  const warnings = [];
  const direction = safeString(strategy.direction, 'both').toLowerCase();
  if (direction === 'both') warnings.push('direction_both_needs_long_and_short_branches');
  if (safeString(strategy.market_group || strategy.market || 'all').toLowerCase() === 'all') warnings.push('symbol_is_chart_agnostic');
  if (safeArray(strategy.required_indicators || strategy.requiredIndicators).length === 0) warnings.push('required_indicators_inferred_from_signal_rules');
  if (safeArray(strategy.exit_rules || strategy.exitRules).length === 0) warnings.push('exit_rules_inferred_from_defaults');
  if (safeArray(strategy.default_timeframes || strategy.allowedTimeframes).length > 1) warnings.push('timeframe_list_requires_pine_input_or_filter');
  if (strategy.risk_notes) warnings.push('strategy_contains_manual_risk_note');
  if (registryRow?.blocked_reason) warnings.push(`blockedReason:${registryRow.blocked_reason}`);
  if (registryRow?.status && registryRow.status !== 'active') warnings.push(`registry_status:${registryRow.status}`);
  if (strategy.is_new) warnings.push('new_strategy_history_limited');
  return unique([...warnings, ...missingFields.map((field) => `missing:${field}`)]);
}

function buildTradingViewBlueprint(strategy, registryRow = null) {
  const chosenTimeframe = chooseTimeframe(strategy);
  const indicatorsRequired = inferIndicators(strategy);
  const sessionFilter = inferSessionFilter(strategy);
  const setupType = inferSetupType(strategy);
  const maxTradesPerDay = safeNumber(strategy.max_trades_per_day, null) ?? inferMaxTradesPerDay(strategy);
  const cooldownMinutes = safeNumber(strategy.cooldown_minutes, null) ?? inferCooldownMinutes(strategy);
  const recommendedLookbackDays = safeNumber(strategy.recommended_lookback_days, null) ?? inferRecommendedLookbackDays(chosenTimeframe, strategy.default_holding_time_min ?? strategy.default_holding_time);
  const missingFields = buildMissingFields(strategy);

  return {
    strategyId: strategy.id,
    displayName: strategy.name || strategy.id,
    direction: safeString(strategy.direction, 'both').toLowerCase(),
    symbol: '<chart symbol>',
    timeframe: chosenTimeframe,
    indicatorsRequired,
    entryConditionsHuman: buildConditionText(strategy.signal_rules || strategy.entryRules, strategy.explanation || strategy.description_sv || 'Entry logic saknas i katalogen.'),
    entryConditionsPinePseudo: buildEntryConditionsPinePseudo(strategy, indicatorsRequired),
    exitConditionsHuman: buildConditionText(strategy.exit_rules || strategy.exitRules, 'Stop loss / take profit / timeout'),
    exitConditionsPinePseudo: buildExitConditionsPinePseudo(strategy),
    filtersHuman: buildFiltersHuman(strategy, chosenTimeframe, sessionFilter),
    filtersPinePseudo: buildFiltersPinePseudo(strategy, chosenTimeframe, sessionFilter),
    riskRules: buildRiskRules(strategy, maxTradesPerDay, cooldownMinutes, recommendedLookbackDays),
    maxTradesPerDay,
    cooldownMinutes,
    sessionFilter,
    recommendedLookbackDays,
    pineScriptPossible: true,
    missingFields,
    warnings: buildWarnings(strategy, registryRow, missingFields),
    setupType,
  };
}

function buildFieldInventory(strategies) {
  const keys = [
    'strategyId',
    'displayName',
    'direction',
    'symbol',
    'timeframe',
    'required_indicators',
    'entryConditions',
    'exitConditions',
    'filters',
    'stopLoss',
    'takeProfit',
    'cooldownMinutes',
    'maxTradesPerDay',
    'sessionFilter',
    'scoreConfidence',
    'blockedReason',
    'setupType',
  ];
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const strategy of strategies) {
    if (strategy.id) counts.strategyId += 1;
    if (strategy.name) counts.displayName += 1;
    if (strategy.direction) counts.direction += 1;
    if (strategy.symbol) counts.symbol += 1;
    if (safeArray(strategy.default_timeframes || strategy.allowedTimeframes).length) counts.timeframe += 1;
    if (safeArray(strategy.required_indicators || strategy.requiredIndicators).length) counts.required_indicators += 1;
    if (safeArray(strategy.signal_rules || strategy.entryRules).length) counts.entryConditions += 1;
    if (safeArray(strategy.exit_rules || strategy.exitRules).length) counts.exitConditions += 1;
    if (strategy.filters) counts.filters += 1;
    if (strategy.default_stop_loss_pct != null || strategy.default_sl != null) counts.stopLoss += 1;
    if (strategy.default_take_profit_r != null || strategy.default_tp != null) counts.takeProfit += 1;
    if (strategy.cooldown_minutes != null) counts.cooldownMinutes += 1;
    if (strategy.max_trades_per_day != null) counts.maxTradesPerDay += 1;
    if (strategy.session_filter) counts.sessionFilter += 1;
    if (strategy.performanceSummary?.score != null) counts.scoreConfidence += 1;
    if (strategy.blockedReason || strategy.disabled_reason) counts.blockedReason += 1;
    if (strategy.setup_type || strategy.family || strategy.version) counts.setupType += 1;
  }
  const total = strategies.length || 1;
  return {
    totalStrategies: strategies.length,
    fields: keys.map((key) => ({
      field: key,
      present: counts[key],
      missing: Math.max(0, total - counts[key]),
    })),
  };
}

function createTradingViewTestBlueprintService(options = {}) {
  const catalogService = options.catalogService || strategyCatalog;
  const registryService = options.registryService || strategyRegistry;

  function listRegistryStrategies() {
    try {
      if (typeof registryService.listStrategies === 'function') return registryService.listStrategies() || [];
    } catch (_) {
      // ignored: read-only view only
    }
    return [];
  }

  function getRegistryMap() {
    return new Map(listRegistryStrategies().map((row) => [row.strategy_id || row.id, row]));
  }

  function buildTradingViewTestBlueprints() {
    const catalog = typeof catalogService.getCatalog === 'function' ? catalogService.getCatalog() : { strategies: [] };
    const strategies = Array.isArray(catalog.strategies) ? catalog.strategies : [];
    const registryMap = getRegistryMap();
    const blueprints = strategies.map((strategy) => buildTradingViewBlueprint(strategy, registryMap.get(strategy.id) || null));
    const summary = {
      totalStrategies: blueprints.length,
      pineScriptPossible: blueprints.filter((row) => row.pineScriptPossible === true).length,
      needsAttention: blueprints.filter((row) => Array.isArray(row.missingFields) && row.missingFields.length > 0).length,
      directionBoth: blueprints.filter((row) => row.direction === 'both').length,
    };
    return {
      ok: true,
      ...SAFETY,
      summary,
      fieldInventory: buildFieldInventory(strategies),
      blueprints,
    };
  }

  function getTradingViewTestBlueprint(strategyId) {
    const id = safeString(strategyId);
    if (!id) {
      return { ok: false, error: 'strategy_id_required', ...SAFETY };
    }
    const catalog = typeof catalogService.getStrategyById === 'function' ? catalogService.getStrategyById(id) : null;
    if (!catalog) {
      return { ok: false, error: 'strategy_not_found', ...SAFETY };
    }
    const registryRow = getRegistryMap().get(id) || null;
    return {
      ok: true,
      ...SAFETY,
      blueprint: buildTradingViewBlueprint(catalog, registryRow),
    };
  }

  return {
    SAFETY,
    buildTradingViewTestBlueprints,
    getTradingViewTestBlueprint,
  };
}

const defaultTradingViewTestBlueprintService = createTradingViewTestBlueprintService();

module.exports = {
  SAFETY,
  RULE_HUMAN,
  RULE_PINE,
  createTradingViewTestBlueprintService,
  defaultTradingViewTestBlueprintService,
};
