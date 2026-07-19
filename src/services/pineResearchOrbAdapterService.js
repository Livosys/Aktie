'use strict';

// Generic ORB (opening_range_breakout) parity adapter for the Pine Research
// Factory. Translates any PineVersion of baseStrategyId=opening_range_breakout
// (all parameter variants: direction, 15/30m range, breakout/retest, range/
// fixed stop, risk-reward target, EMA/volume filter, entry window, forced
// close) into an isolated in-process backtest against the shared candle store
// (data/market-data/candles-<tf>/<SYMBOL>/<YYYY-MM-DD>.jsonl).
//
// Paper/replay-only research. Never places orders, never touches Paper
// Trading, Futures Paper or any execution path. Results only live in the
// Pine Research Factory store.
//
// Fill model mirrors the generated Pine v6 strategy scripts:
//   - signals evaluate on bar close, entry/close_all fill at NEXT bar open
//   - strategy.exit stop/limit becomes active the bar AFTER the fill bar
//   - stop fills get slippage (ticks), limit fills do not
//   - same-bar stop+target ambiguity resolved with the TradingView broker
//     emulator assumption (open nearer high => open->high->low->close)

const fs = require('fs');
const path = require('path');

const model = require('./pineResearchModelService');

const DATA_ROOT = path.resolve(__dirname, '../../data/market-data');

const CONTRACT_SPECS = Object.freeze({
  MNQ: { symbol: 'MNQ', tickSize: 0.25, pointValue: 2, description: 'Micro E-mini Nasdaq-100' },
  MES: { symbol: 'MES', tickSize: 0.25, pointValue: 5, description: 'Micro E-mini S&P 500' },
});

const TIMEFRAME_MINUTES = Object.freeze({ '1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30 });

const SUPPORTED_ENTRY_MODES = Object.freeze(['breakout', 'retest']);
const SUPPORTED_STOP_MODES = Object.freeze(['range', 'fixed', 'fixed_points']);
const SUPPORTED_TARGET_MODES = Object.freeze(['risk_reward']);
const SUPPORTED_ENGINES = Object.freeze(['internal_preview']);
const DEFAULT_MIN_READY_DAYS = 5;
const VOLUME_SMA_LENGTH = 20;

// ── time helpers ─────────────────────────────────────────────────────────────

const formatterCache = new Map();

function timezoneFormatter(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }));
  }
  return formatterCache.get(timezone);
}

function localClock(tsMs, timezone) {
  const parts = timezoneFormatter(timezone).formatToParts(new Date(tsMs));
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

function parseClock(value, fallbackMinutes) {
  const m = String(value || '').trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return fallbackMinutes;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseSession(value, fallback = { start: 570, end: 960 }) {
  const m = String(value || '').trim().match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return { ...fallback, valid: false };
  return {
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
    valid: true,
  };
}

// ── spec extraction ──────────────────────────────────────────────────────────

function buildOrbSpec(versionInput, options = {}) {
  const version = model.normalizeVersion(versionInput);
  const p = version.parameters || {};
  const symbol = String(options.symbol || 'MNQ').toUpperCase();
  const timeframe = String(options.timeframe || '5m');
  const issues = [];

  if (version.baseStrategyId !== 'opening_range_breakout') issues.push('base_strategy_not_opening_range_breakout');
  if (!SUPPORTED_ENTRY_MODES.includes(p.entryMode)) issues.push('entry_mode_not_mapped');
  if (!SUPPORTED_STOP_MODES.includes(p.stopMode)) issues.push('stop_mode_not_mapped');
  if (!SUPPORTED_TARGET_MODES.includes(p.targetMode)) issues.push('target_mode_not_mapped');
  if (!CONTRACT_SPECS[symbol]) issues.push('symbol_contract_spec_missing');
  if (!TIMEFRAME_MINUTES[timeframe]) issues.push('timeframe_not_supported');

  const session = parseSession(p.session, { start: 570, end: 960 });
  if (!session.valid) issues.push('session_format_invalid');
  const timeframeMinutes = TIMEFRAME_MINUTES[timeframe] || 5;
  const openingRangeMinutes = Number(p.openingRangeMinutes) > 0 ? Number(p.openingRangeMinutes) : 30;
  if (openingRangeMinutes % timeframeMinutes !== 0) issues.push('opening_range_not_divisible_by_timeframe');

  const spec = {
    pineVersionId: version.pineVersionId,
    candidateId: version.candidateId,
    baseStrategyId: version.baseStrategyId,
    symbol,
    timeframe,
    timeframeMinutes,
    timezone: p.timezone || 'America/New_York',
    sessionStart: session.start,
    sessionEnd: session.end,
    openingRangeMinutes,
    openingRangeEnd: session.start + openingRangeMinutes,
    entryMode: p.entryMode || 'breakout',
    direction: version.direction || 'both',
    allowLong: version.direction !== 'short_only',
    allowShort: version.direction !== 'long_only',
    stopMode: p.stopMode === 'fixed' ? 'fixed_points' : (p.stopMode || 'range'),
    stopValue: Number(p.stopValue) > 0 ? Number(p.stopValue) : 20,
    riskReward: Number(p.riskReward) > 0 ? Number(p.riskReward) : 1.5,
    emaFilterEnabled: p.emaFilterEnabled === true,
    emaLength: Number(p.emaLength) > 1 ? Number(p.emaLength) : 50,
    volumeFilterEnabled: p.volumeFilterEnabled === true,
    volumeMultiplier: Number(p.volumeMultiplier) > 0 ? Number(p.volumeMultiplier) : 1.2,
    lastEntryMinutes: parseClock(p.lastEntryTime, 690),
    forcedCloseMinutes: parseClock(p.forcedCloseTime, 955),
    commissionPerContract: Number(version.riskRules?.commission ?? 2),
    slippageTicks: Number(version.riskRules?.slippage ?? 1),
    quantity: 1,
    contract: CONTRACT_SPECS[symbol] || null,
  };

  return { supported: issues.length === 0, issues, spec, version };
}

// ── data readiness read-model ────────────────────────────────────────────────

function candleDir(symbol, timeframe, rootDir = DATA_ROOT) {
  return path.join(rootDir, `candles-${timeframe}`, String(symbol).toUpperCase());
}

function normalizeBar(raw) {
  const ts = raw.ts || raw.t || raw.candleTime;
  const tsMs = Date.parse(ts);
  const open = Number(raw.o ?? raw.open);
  const high = Number(raw.h ?? raw.high);
  const low = Number(raw.l ?? raw.low);
  const close = Number(raw.c ?? raw.close);
  const volume = Number(raw.v ?? raw.volume ?? 0);
  if (!Number.isFinite(tsMs) || ![open, high, low, close].every(Number.isFinite)) return null;
  return { ts: new Date(tsMs).toISOString(), tsMs, open, high, low, close, volume };
}

function loadCandles({ symbol, timeframe, dateRange, rootDir = DATA_ROOT }) {
  const dir = candleDir(symbol, timeframe, rootDir);
  const warnings = [];
  const bars = [];
  const days = [];
  const from = String(dateRange?.from || '0000-01-01');
  const to = String(dateRange?.to || '9999-12-31');
  let files = [];
  try {
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
      : [];
  } catch (err) {
    warnings.push(`candle_dir_unreadable:${err.message}`);
  }
  for (const file of files) {
    const day = file.slice(0, 10);
    if (day < from || day > to) continue;
    let dayBars = 0;
    let skipped = 0;
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const bar = normalizeBar(JSON.parse(line));
          if (bar) {
            bars.push(bar);
            dayBars += 1;
          } else skipped += 1;
        } catch (_) {
          skipped += 1;
        }
      }
    } catch (err) {
      warnings.push(`candle_file_unreadable:${day}`);
      continue;
    }
    if (skipped) warnings.push(`invalid_bars_skipped:${day}:${skipped}`);
    days.push({ date: day, bars: dayBars });
  }
  bars.sort((a, b) => a.tsMs - b.tsMs);
  return { dir, bars, days, warnings };
}

function assessDataReadiness(specOrOptions, options = {}) {
  const spec = specOrOptions.spec || specOrOptions;
  const symbol = String(spec.symbol || options.symbol || 'MNQ').toUpperCase();
  const timeframe = String(spec.timeframe || options.timeframe || '5m');
  const timezone = spec.timezone || 'America/New_York';
  const sessionStart = Number.isFinite(spec.sessionStart) ? spec.sessionStart : 570;
  const sessionEnd = Number.isFinite(spec.sessionEnd) ? spec.sessionEnd : 960;
  const tfMinutes = TIMEFRAME_MINUTES[timeframe] || 5;
  const dateRange = options.dateRange || specOrOptions.dateRange || { from: '2025-01-01', to: '2025-12-31' };
  const minReadyDays = Number(options.minReadyDays) > 0 ? Number(options.minReadyDays) : DEFAULT_MIN_READY_DAYS;

  const loaded = loadCandles({ symbol, timeframe, dateRange, rootDir: options.rootDir });
  const expectedSessionBars = Math.floor((sessionEnd - sessionStart) / tfMinutes);
  const sessionBarsByDay = new Map();
  for (const bar of loaded.bars) {
    const clock = localClock(bar.tsMs, timezone);
    if (clock.minutes >= sessionStart && clock.minutes < sessionEnd) {
      sessionBarsByDay.set(clock.date, (sessionBarsByDay.get(clock.date) || 0) + 1);
    }
  }
  const completeDays = [...sessionBarsByDay.entries()]
    .filter(([, count]) => count >= Math.floor(expectedSessionBars * 0.9));
  const warnings = [...loaded.warnings];
  for (const [day, count] of sessionBarsByDay.entries()) {
    if (count < Math.floor(expectedSessionBars * 0.9)) {
      warnings.push(`incomplete_session_day:${day}:${count}/${expectedSessionBars}`);
    }
  }

  let dataStatus = 'ready';
  let reason = null;
  if (!loaded.bars.length) {
    dataStatus = 'missing';
    reason = `no_${symbol.toLowerCase()}_${timeframe}_bars_in_shared_candle_store`;
  } else if (completeDays.length < minReadyDays) {
    dataStatus = 'insufficient';
    reason = `only_${completeDays.length}_complete_session_days_min_${minReadyDays}`;
  }

  return {
    symbol,
    resolvedSymbol: symbol,
    timeframe,
    dataSource: 'shared_candle_store',
    dataDir: path.relative(path.resolve(__dirname, '../..'), loaded.dir),
    dateRange: { from: dateRange.from || null, to: dateRange.to || null },
    bars: loaded.bars.length,
    sessionDays: sessionBarsByDay.size,
    completeSessionDays: completeDays.length,
    expectedSessionBarsPerDay: expectedSessionBars,
    firstBarAt: loaded.bars[0]?.ts || null,
    lastBarAt: loaded.bars[loaded.bars.length - 1]?.ts || null,
    dataStatus,
    dataBlockedReason: reason,
    warnings: warnings.slice(0, 20),
  };
}

// ── parity matrix ────────────────────────────────────────────────────────────

function parityRule(name, pineBehavior, internalMotor, matchStatus, difference, action, mandatory = true) {
  return { rule: name, pineBehavior, internalMotor, matchStatus, difference, action, mandatory };
}

function buildParityMatrix(versionInput, options = {}) {
  const engine = String(options.engine || 'internal_preview');
  const { supported, issues, spec, version } = buildOrbSpec(versionInput, options);
  const p = version.parameters || {};
  const engineSupported = SUPPORTED_ENGINES.includes(engine);
  const stopModeStatus = SUPPORTED_STOP_MODES.includes(p.stopMode) ? 'exact' : 'unsupported';
  const entryModeStatus = SUPPORTED_ENTRY_MODES.includes(p.entryMode) ? 'exact' : 'unsupported';
  const symbolStatus = CONTRACT_SPECS[spec.symbol] ? 'exact' : 'unsupported';
  const timeframeStatus = TIMEFRAME_MINUTES[spec.timeframe] && spec.openingRangeMinutes % spec.timeframeMinutes === 0
    ? 'exact' : 'unsupported';
  const baseStatus = version.baseStrategyId === 'opening_range_breakout' ? 'exact' : 'unsupported';

  const matrix = [
    parityRule('strategy family',
      'Pine script family opening_range_breakout generated from PineVersion parameters.',
      'Generic ORB adapter driven by the same PineVersion parameters (no per-version hardcoding).',
      baseStatus,
      baseStatus === 'exact' ? 'none' : 'Adapter only certifies the opening_range_breakout family.',
      baseStatus === 'exact' ? 'none' : 'Build a dedicated adapter for this strategy family.'),
    parityRule('engine support',
      'Pine runs on TradingView chart engine.',
      engineSupported
        ? 'Isolated in-process ORB engine (internal_preview) over the shared candle store.'
        : `Engine ${engine} has no certified ORB path.`,
      engineSupported ? 'equivalent' : 'unsupported',
      engineSupported ? 'Internal engine replays stored candles instead of TradingView data feed.' : 'Only internal_preview is certified for ORB.',
      engineSupported ? 'Validate against TradingView export for full external parity.' : 'Use engine internal_preview.'),
    parityRule('New York timezone',
      `Pine uses ${spec.timezone} for all session windows.`,
      'Bar timestamps converted with IANA timezone rules (DST-aware) before window checks.',
      'exact', 'none', 'none'),
    parityRule('opening range start',
      `Range accumulates on bars inside session ${p.session || '0930-1600'} first ${spec.openingRangeMinutes} minutes (bar open time).`,
      'Same bar-open-time window membership from parsed session string.',
      'exact', 'none', 'none'),
    parityRule('opening range end / 15-30 min range',
      `openingRangeMinutes=${spec.openingRangeMinutes}; range completes on first session bar after the window.`,
      'rangeComplete set on first in-session bar outside the opening window with a recorded high/low, same as the Pine state machine.',
      timeframeStatus === 'exact' ? 'exact' : 'unsupported',
      timeframeStatus === 'exact' ? 'none' : 'Opening range must be divisible by the bar timeframe.',
      timeframeStatus === 'exact' ? 'none' : 'Pick a timeframe that divides the opening range.'),
    parityRule('breakout on close',
      'Entry condition close > openingHigh (long) / close < openingLow (short) evaluated on bar close.',
      'Identical close-vs-range comparison on completed bars.',
      'exact', 'none', 'none'),
    parityRule('entry fill timing',
      'strategy.entry places a market order that fills at next bar open plus slippage.',
      'Signal queued at bar close, filled at next bar open with slippage ticks applied against the direction.',
      'equivalent',
      'Intrabar tick path is not observable in OHLC data; fill price equals the Pine fill emulator behavior for bar-close signals.',
      'Cross-check a sample against TradingView fills.'),
    parityRule('long/short direction',
      `direction=${spec.direction} (allowLong=${spec.allowLong}, allowShort=${spec.allowShort}).`,
      'Same allowLong/allowShort gating in the adapter.',
      'exact', 'none', 'none'),
    parityRule('max entries per day',
      'Pine has pyramiding=0 and only enters when flat; re-entry within the entry window is allowed after an exit.',
      'Adapter only enters when flat and mirrors unlimited flat-gated re-entry inside the entry window (no artificial daily cap).',
      'exact', 'none', 'none'),
    parityRule('last entry time',
      `Entry window ends ${p.lastEntryTime || '11:30'} (bar open time must be inside the window).`,
      'Same entry-window cutoff on signal bar open time.',
      'exact', 'none', 'none'),
    parityRule('forced close',
      `close_all on bars in window ${p.forcedCloseTime || '15:55'}-session end; market order fills next bar open.`,
      'Forced close queued on the same window bar, filled next bar open; falls back to that bar close when no later bar exists in the data.',
      'equivalent',
      'Fallback to bar-close fill only happens when the data set lacks the following bar.',
      'none'),
    parityRule('session/day reset',
      'openingHigh/openingLow/rangeComplete reset on first bar of a new session.',
      'Same newSession detection (in-session bar preceded by out-of-session or day change).',
      'exact', 'none', 'none'),
    parityRule('overnight prevention',
      'Forced close window prevents holding past the session when data contains the window bars.',
      'Adapter additionally force-closes at the last bar of a day if data gaps would otherwise leave a position open overnight (warning emitted).',
      'equivalent',
      'Adapter enforces a strictly stronger no-overnight invariant on gapped data.',
      'none'),
    parityRule('stop mode',
      `stopMode=${p.stopMode}, stopValue=${spec.stopValue}; range stop uses openingLow/openingHigh, fixed stop uses entry price ± points.`,
      stopModeStatus === 'exact' ? 'Identical stop levels; stop fills get slippage and gap-through fills at bar open.' : 'Stop mode is not mapped.',
      stopModeStatus,
      stopModeStatus === 'exact' ? 'none' : `stopMode ${p.stopMode} is outside the certified set.`,
      stopModeStatus === 'exact' ? 'none' : 'Map the stop mode before running.'),
    parityRule('target mode',
      `targetMode=${p.targetMode}, riskReward=${spec.riskReward}; target = entry ± stopDistance * riskReward.`,
      SUPPORTED_TARGET_MODES.includes(p.targetMode)
        ? 'Identical risk-reward target from the same stop distance; limit fills without slippage.'
        : 'Target mode is not mapped.',
      SUPPORTED_TARGET_MODES.includes(p.targetMode) ? 'exact' : 'unsupported',
      SUPPORTED_TARGET_MODES.includes(p.targetMode) ? 'none' : `targetMode ${p.targetMode} is outside the certified set.`,
      SUPPORTED_TARGET_MODES.includes(p.targetMode) ? 'none' : 'Map the target mode before running.'),
    parityRule('intrabar stop/target order',
      'The TradingView fill emulator decides which of stop/target is hit first inside one bar.',
      'Same emulator assumption: open nearer high => open-high-low-close path, else open-low-high-close; ambiguous bars counted in warnings.',
      'equivalent',
      'True tick path is unknown for both engines; both use the same documented assumption.',
      'none'),
    parityRule('commission',
      `commission_type=cash_per_contract, commission_value=${spec.commissionPerContract} per fill side.`,
      'Same cash-per-contract commission charged on entry and exit fills.',
      'exact', 'none', 'none'),
    parityRule('slippage',
      `slippage=${spec.slippageTicks} tick(s) on market/stop fills.`,
      'Same tick-based slippage against the trade direction on market and stop fills; none on limit fills.',
      'exact', 'none', 'none'),
    parityRule('EMA filter',
      `emaFilterEnabled=${spec.emaFilterEnabled}${spec.emaFilterEnabled ? `, emaLength=${spec.emaLength}` : ''}.`,
      spec.emaFilterEnabled
        ? 'Recursive EMA seeded on first close; converges to ta.ema but differs during the warmup window.'
        : 'Filter disabled in both engines.',
      spec.emaFilterEnabled ? 'equivalent' : 'exact',
      spec.emaFilterEnabled ? 'Warmup bars can differ from ta.ema until convergence.' : 'none',
      spec.emaFilterEnabled ? 'Exclude the first sessions from comparisons or extend the data range.' : 'none',
      spec.emaFilterEnabled),
    parityRule('volume filter',
      `volumeFilterEnabled=${spec.volumeFilterEnabled}${spec.volumeFilterEnabled ? `, volume > sma(volume,20) * ${spec.volumeMultiplier}` : ''}.`,
      spec.volumeFilterEnabled
        ? 'Same SMA(20) volume threshold; no signals until 20 bars exist (Pine na-comparison behaves the same).'
        : 'Filter disabled in both engines.',
      spec.volumeFilterEnabled ? 'equivalent' : 'exact',
      spec.volumeFilterEnabled ? 'Volume magnitudes depend on the data feed and can differ from TradingView futures volume.' : 'none',
      spec.volumeFilterEnabled ? 'Validate volume scale against TradingView before trusting the filter.' : 'none',
      spec.volumeFilterEnabled),
    parityRule('retest entry',
      `entryMode=${spec.entryMode}.`,
      spec.entryMode === 'retest'
        ? 'Identical retest condition: low <= openingHigh and close > openingHigh (long), mirrored for short.'
        : 'Baseline breakout path does not use retest.',
      entryModeStatus,
      entryModeStatus === 'exact' ? 'none' : `entryMode ${p.entryMode} is outside the certified set.`,
      entryModeStatus === 'exact' ? 'none' : 'Map the entry mode before running.',
      spec.entryMode === 'retest' || entryModeStatus !== 'exact'),
    parityRule('symbol support',
      `Research symbol=${spec.symbol}.`,
      symbolStatus === 'exact'
        ? `Contract spec mapped (tick ${spec.contract?.tickSize}, point value $${spec.contract?.pointValue}/contract). Data availability is reported separately as dataStatus.`
        : 'No contract spec for this symbol.',
      symbolStatus,
      symbolStatus === 'exact' ? 'none' : 'Symbol is outside the certified futures research roots.',
      symbolStatus === 'exact' ? 'none' : 'Add a contract spec before running.'),
    parityRule('timeframe support',
      `Requested timeframe=${spec.timeframe}.`,
      timeframeStatus === 'exact'
        ? 'Adapter replays native stored bars of this timeframe.'
        : 'Timeframe is not supported by the adapter.',
      timeframeStatus,
      timeframeStatus === 'exact' ? 'none' : 'Timeframe missing from the certified set or incompatible with the opening range.',
      timeframeStatus === 'exact' ? 'none' : 'Use 1m/5m/15m with a compatible opening range.'),
  ];

  const certifiedStatuses = new Set(['exact', 'equivalent']);
  const mandatoryRows = matrix.filter((row) => row.mandatory !== false);
  const certified = supported && engineSupported && mandatoryRows.every((row) => certifiedStatuses.has(row.matchStatus));
  const unsupportedRules = matrix.filter((row) => !certifiedStatuses.has(row.matchStatus)).map((row) => row.rule);
  const supportedRules = matrix.filter((row) => certifiedStatuses.has(row.matchStatus)).map((row) => row.rule);

  return {
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    engine,
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    certified,
    parityStatus: certified ? 'certified' : 'blocked',
    blockedReason: certified ? null : (issues[0] || (!engineSupported ? 'engine_not_certified_for_orb' : 'orb_rules_not_fully_mapped')),
    specIssues: issues,
    supportedRules,
    unsupportedRules,
    matrix,
  };
}

// ── backtest engine ──────────────────────────────────────────────────────────

function annotateBars(bars, spec) {
  return bars.map((bar) => {
    const clock = localClock(bar.tsMs, spec.timezone);
    return {
      ...bar,
      day: clock.date,
      minutes: clock.minutes,
      inSession: clock.minutes >= spec.sessionStart && clock.minutes < spec.sessionEnd,
      inOpeningRange: clock.minutes >= spec.sessionStart && clock.minutes < spec.openingRangeEnd,
      inEntryWindow: clock.minutes >= spec.sessionStart && clock.minutes < spec.lastEntryMinutes,
      mustForceClose: clock.minutes >= spec.forcedCloseMinutes && clock.minutes < spec.sessionEnd,
    };
  });
}

function emulatorPathHitsTargetFirst(bar) {
  // TradingView broker emulator assumption for OHLC-only bars:
  // open nearer the high => open->high->low->close, else open->low->high->close.
  return (bar.high - bar.open) <= (bar.open - bar.low)
    ? false // open nearer low: low visited first
    : true; // open nearer high: high visited first
}

function runOrbBacktest(versionInput, barsInput, options = {}) {
  const { supported, issues, spec } = buildOrbSpec(versionInput, options);
  if (!supported) {
    return { ok: false, error: 'orb_spec_not_supported', issues, trades: [], metrics: {}, warnings: issues };
  }
  const tick = spec.contract.tickSize;
  const slip = spec.slippageTicks * tick;
  const pointValue = spec.contract.pointValue;
  const qty = spec.quantity;
  const commissionPerSide = spec.commissionPerContract * qty;
  const bars = annotateBars(barsInput, spec);

  const warnings = [];
  const trades = [];
  let ambiguousBars = 0;

  // Pine-mirrored state
  let openingHigh = null;
  let openingLow = null;
  let rangeComplete = false;
  let prevInSession = false;
  let prevDay = null;
  let ema = null;
  const volumes = [];

  // broker state
  let pendingEntry = null; // {direction} set at signal close, fills next bar open
  let pendingForcedClose = false;
  let position = null; // {direction, entryPrice, entryTime, stop, target, exitActive}

  function closePosition(exitPrice, exitTime, reason, applySlippage) {
    const dir = position.direction === 'long' ? 1 : -1;
    const slippedExit = applySlippage ? exitPrice - dir * slip : exitPrice;
    const grossPnl = (slippedExit - position.entryPrice) * dir * pointValue * qty;
    const commission = commissionPerSide * 2;
    trades.push({
      direction: position.direction,
      entryTime: position.entryTime,
      exitTime,
      entryPrice: position.entryPrice,
      exitPrice: slippedExit,
      quantity: qty,
      exitReason: reason,
      grossPnl: Number(grossPnl.toFixed(2)),
      commission,
      netPnl: Number((grossPnl - commission).toFixed(2)),
    });
    position = null;
  }

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const newDay = prevDay !== null && bar.day !== prevDay;

    // Safety invariant: never let a research position span a day change.
    if (newDay && position) {
      const prevBar = bars[i - 1];
      closePosition(prevBar.close, prevBar.ts, 'end_of_session_data_gap', false);
      warnings.push(`overnight_prevented_close_at_last_session_bar:${prevBar.day}`);
      pendingForcedClose = false;
    }
    if (newDay) pendingEntry = null;

    // 1) pending market orders fill at this bar's open
    if (pendingForcedClose && position) {
      closePosition(bar.open, bar.ts, 'forced_close', true);
      pendingForcedClose = false;
    }
    if (pendingEntry && !position) {
      const dir = pendingEntry.direction === 'long' ? 1 : -1;
      const entryPrice = bar.open + dir * slip;
      const stopDistance = spec.stopMode === 'fixed_points'
        ? spec.stopValue
        : (pendingEntry.direction === 'long' ? entryPrice - openingLow : openingHigh - entryPrice);
      const safeStopDistance = Math.max(stopDistance, tick);
      position = {
        direction: pendingEntry.direction,
        entryPrice,
        entryTime: bar.ts,
        stop: entryPrice - dir * safeStopDistance,
        target: entryPrice + dir * safeStopDistance * spec.riskReward,
        exitActive: false, // strategy.exit becomes active the bar after the fill bar
      };
      pendingEntry = null;
    }

    // 2) intrabar stop/target for active exits
    if (position && position.exitActive) {
      const dir = position.direction === 'long' ? 1 : -1;
      const stopHit = dir === 1 ? bar.low <= position.stop : bar.high >= position.stop;
      const targetHit = dir === 1 ? bar.high >= position.target : bar.low <= position.target;
      if (stopHit && targetHit) ambiguousBars += 1;
      const gapThroughStop = dir === 1 ? bar.open <= position.stop : bar.open >= position.stop;
      const gapThroughTarget = dir === 1 ? bar.open >= position.target : bar.open <= position.target;
      if (gapThroughStop) {
        closePosition(bar.open, bar.ts, 'stop', true);
      } else if (gapThroughTarget) {
        closePosition(bar.open, bar.ts, 'target', false);
      } else if (stopHit && targetHit) {
        const highFirst = emulatorPathHitsTargetFirst(bar);
        const targetFirst = dir === 1 ? highFirst : !highFirst;
        if (targetFirst) closePosition(position.target, bar.ts, 'target', false);
        else closePosition(position.stop, bar.ts, 'stop', true);
      } else if (stopHit) {
        closePosition(position.stop, bar.ts, 'stop', true);
      } else if (targetHit) {
        closePosition(position.target, bar.ts, 'target', false);
      }
    }

    // 3) Pine per-bar state updates (order mirrors the generated script)
    const newSession = bar.inSession && (!prevInSession || newDay);
    if (newSession) {
      openingHigh = null;
      openingLow = null;
      rangeComplete = false;
    }
    if (bar.inOpeningRange && bar.inSession) {
      openingHigh = openingHigh === null ? bar.high : Math.max(openingHigh, bar.high);
      openingLow = openingLow === null ? bar.low : Math.min(openingLow, bar.low);
    }
    if (bar.inSession && !bar.inOpeningRange && openingHigh !== null && openingLow !== null) {
      rangeComplete = true;
    }

    // indicators over the full loaded series, like the Pine chart series
    ema = ema === null ? bar.close : ema + (2 / (spec.emaLength + 1)) * (bar.close - ema);
    volumes.push(bar.volume);
    if (volumes.length > VOLUME_SMA_LENGTH) volumes.shift();
    const volumeSma = volumes.length >= VOLUME_SMA_LENGTH
      ? volumes.reduce((a, b) => a + b, 0) / VOLUME_SMA_LENGTH
      : null;

    // 4) signals at bar close
    const longTrendOk = !spec.emaFilterEnabled || bar.close > ema;
    const shortTrendOk = !spec.emaFilterEnabled || bar.close < ema;
    const volumeOk = !spec.volumeFilterEnabled || (volumeSma !== null && bar.volume > volumeSma * spec.volumeMultiplier);
    const longBreakout = rangeComplete && bar.close > openingHigh;
    const shortBreakout = rangeComplete && bar.close < openingLow;
    const longRetest = rangeComplete && bar.low <= openingHigh && bar.close > openingHigh;
    const shortRetest = rangeComplete && bar.high >= openingLow && bar.close < openingLow;
    const longSignal = bar.inSession && bar.inEntryWindow && spec.allowLong && volumeOk && longTrendOk
      && (spec.entryMode === 'retest' ? longRetest : longBreakout);
    const shortSignal = bar.inSession && bar.inEntryWindow && spec.allowShort && volumeOk && shortTrendOk
      && (spec.entryMode === 'retest' ? shortRetest : shortBreakout);

    if (!position && !pendingEntry) {
      if (longSignal) pendingEntry = { direction: 'long' };
      else if (shortSignal) pendingEntry = { direction: 'short' };
    }

    // 5) strategy.exit becomes active after the close of the fill bar
    if (position && !position.exitActive) position.exitActive = true;

    // 6) forced close queued at close of a forced-window bar
    if (bar.mustForceClose && position) {
      const next = bars[i + 1];
      if (next && next.day === bar.day) {
        pendingForcedClose = true;
      } else {
        closePosition(bar.close, bar.ts, 'forced_close', false);
        warnings.push(`forced_close_fill_used_bar_close_due_to_missing_next_bar:${bar.day}`);
      }
      pendingEntry = null;
    }

    prevInSession = bar.inSession;
    prevDay = bar.day;
  }

  if (position) {
    const lastBar = bars[bars.length - 1];
    closePosition(lastBar.close, lastBar.ts, 'end_of_data', false);
    warnings.push('position_closed_at_end_of_data');
  }
  if (ambiguousBars > 0) {
    warnings.push(`ambiguous_stop_target_bars_resolved_with_emulator_assumption:${ambiguousBars}`);
  }

  return {
    ok: true,
    spec,
    trades,
    metrics: computeMetrics(trades),
    ambiguousBars,
    warnings,
  };
}

function computeMetrics(trades) {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const commission = trades.reduce((a, t) => a + t.commission, 0);
  const longTrades = trades.filter((t) => t.direction === 'long');
  const shortTrades = trades.filter((t) => t.direction === 'short');

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    consecutiveLosses = trade.netPnl < 0 ? consecutiveLosses + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
  }

  const missingMetrics = [];
  let profitFactor = null;
  if (grossLoss > 0) profitFactor = Number((grossProfit / grossLoss).toFixed(3));
  else if (trades.length) missingMetrics.push('profitFactor_undefined_no_losing_trades');
  else missingMetrics.push('no_trades_generated');

  return {
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(2)) : null,
    profitFactor,
    netPnl: Number(netPnl.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    commission: Number(commission.toFixed(2)),
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxConsecutiveLosses,
    averageTrade: trades.length ? Number((netPnl / trades.length).toFixed(2)) : null,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longNetPnl: Number(longTrades.reduce((a, t) => a + t.netPnl, 0).toFixed(2)),
    shortNetPnl: Number(shortTrades.reduce((a, t) => a + t.netPnl, 0).toFixed(2)),
    missingMetrics,
  };
}

module.exports = {
  CONTRACT_SPECS,
  TIMEFRAME_MINUTES,
  SUPPORTED_ENGINES,
  DEFAULT_MIN_READY_DAYS,
  buildOrbSpec,
  buildParityMatrix,
  assessDataReadiness,
  loadCandles,
  runOrbBacktest,
  computeMetrics,
  localClock,
  parseSession,
  parseClock,
};
