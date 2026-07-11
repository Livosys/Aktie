'use strict';

const model = require('./pineResearchModelService');

function parseSessionStart(session) {
  const match = String(session || '0930-1600').match(/^(\d{2})(\d{2})-/);
  if (!match) return { hour: 9, minute: 30 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function toSessionTime(hour, minute) {
  const total = Math.max(0, Math.min((23 * 60) + 59, (hour * 60) + minute));
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}${mm}`;
}

function openingRangeSession(session, minutes) {
  const start = parseSessionStart(session);
  const endTotal = (start.hour * 60) + start.minute + Math.max(1, Math.min(240, Number(minutes) || 30));
  return `${toSessionTime(start.hour, start.minute)}-${toSessionTime(Math.floor(endTotal / 60), endTotal % 60)}`;
}

function timeWindowFromStart(session, endTime) {
  const start = parseSessionStart(session);
  const cleanEnd = String(endTime || '11:30').replace(':', '').padStart(4, '0').slice(0, 4);
  return `${toSessionTime(start.hour, start.minute)}-${cleanEnd}`;
}

function forcedCloseWindow(timeValue) {
  const clean = String(timeValue || '15:55').replace(':', '').padStart(4, '0').slice(0, 4);
  const hour = Number(clean.slice(0, 2));
  const minute = Number(clean.slice(2, 4));
  const end = toSessionTime(hour, minute + 5);
  return `${clean}-${end}`;
}

function pineBool(value) {
  return value ? 'true' : 'false';
}

function pineString(value) {
  return JSON.stringify(String(value ?? ''));
}

function pineNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(fallback);
}

function directionBooleans(direction) {
  return {
    allowLong: direction === 'both' || direction === 'long_only',
    allowShort: direction === 'both' || direction === 'short_only',
  };
}

function buildSource(versionInput) {
  const version = model.normalizeVersion(versionInput);
  const p = model.defaultParameters(version.parameters || {});
  const openingSession = openingRangeSession(p.session, p.openingRangeMinutes);
  const entrySession = timeWindowFromStart(p.session, p.lastEntryTime);
  const forceSession = forcedCloseWindow(p.forcedCloseTime);
  const direction = directionBooleans(p.direction);
  const title = `Trading OS ${version.baseStrategyId} ${version.version}`.slice(0, 80);
  const fixedStopPoints = p.stopMode === 'fixed_points' || p.stopMode === 'fixed'
    ? Math.max(0.25, Number(p.stopValue) || 20)
    : 20;
  const isRetest = p.entryMode === 'retest';
  const commission = Number(version.riskRules?.commission ?? 2);
  const slippage = Number(version.riskRules?.slippage ?? 1);

  return `//@version=6
// Trading OS Pine Research Factory
// strategyId: ${version.baseStrategyId}
// candidateId: ${version.candidateId}
// pineVersionId: ${version.pineVersionId}
// parameterHash: ${version.parameterHash}
// symbolRoots: ${version.symbolRoots.join(',')}
// timeframes: ${version.timeframes.join(',')}
// timezone: ${p.timezone}
// safety: paper_only research export, no execution routing
strategy(${pineString(title)}, overlay=true, pyramiding=0, max_bars_back=500, initial_capital=100000, commission_type=strategy.commission.cash_per_contract, commission_value=${pineNumber(commission, 2)}, slippage=${pineNumber(slippage, 1)})

startDate = input.time(timestamp("01 Jan 2025 00:00 -0500"), "Startdatum")
endDate = input.time(timestamp("31 Dec 2025 23:59 -0500"), "Slutdatum")
tradeSession = input.session(${pineString(p.session)}, "Session")
openingRangeInput = input.session(${pineString(openingSession)}, "Opening range")
entryWindow = input.session(${pineString(entrySession)}, "Entry window")
forcedCloseWindow = input.session(${pineString(forceSession)}, "Forced close")

timezone = ${pineString(p.timezone)}
allowLong = ${pineBool(direction.allowLong)}
allowShort = ${pineBool(direction.allowShort)}
useRetestEntry = ${pineBool(isRetest)}
emaFilterEnabled = ${pineBool(p.emaFilterEnabled)}
emaLength = ${pineNumber(p.emaLength, 50)}
volumeFilterEnabled = ${pineBool(p.volumeFilterEnabled)}
volumeMultiplier = ${pineNumber(p.volumeMultiplier, 1.2)}
useFixedStop = ${pineBool(p.stopMode === 'fixed_points' || p.stopMode === 'fixed')}
fixedStopPoints = ${pineNumber(fixedStopPoints, 20)}
riskReward = ${pineNumber(p.riskReward, 1.5)}

inDateRange = time >= startDate and time <= endDate
inTradeSession = not na(time(timeframe.period, tradeSession, timezone))
inOpeningRange = not na(time(timeframe.period, openingRangeInput, timezone))
inEntryWindow = not na(time(timeframe.period, entryWindow, timezone))
mustForceClose = not na(time(timeframe.period, forcedCloseWindow, timezone))
newSession = inTradeSession and not inTradeSession[1]

var float openingHigh = na
var float openingLow = na
var bool rangeComplete = false

if newSession
    openingHigh := na
    openingLow := na
    rangeComplete := false

if inOpeningRange
    openingHigh := na(openingHigh) ? high : math.max(openingHigh, high)
    openingLow := na(openingLow) ? low : math.min(openingLow, low)

if inTradeSession and not inOpeningRange and not na(openingHigh) and not na(openingLow)
    rangeComplete := true

openingRange = math.max(openingHigh - openingLow, syminfo.mintick)
emaValue = ta.ema(close, emaLength)
volumeAverage = ta.sma(volume, 20)
longTrendOk = not emaFilterEnabled or close > emaValue
shortTrendOk = not emaFilterEnabled or close < emaValue
volumeOk = not volumeFilterEnabled or volume > volumeAverage * volumeMultiplier

longBreakout = rangeComplete and close > openingHigh
shortBreakout = rangeComplete and close < openingLow
longRetest = rangeComplete and low <= openingHigh and close > openingHigh
shortRetest = rangeComplete and high >= openingLow and close < openingLow

longSignal = inDateRange and inTradeSession and inEntryWindow and allowLong and volumeOk and longTrendOk and (useRetestEntry ? longRetest : longBreakout)
shortSignal = inDateRange and inTradeSession and inEntryWindow and allowShort and volumeOk and shortTrendOk and (useRetestEntry ? shortRetest : shortBreakout)

if longSignal and strategy.position_size == 0
    strategy.entry("L", strategy.long, comment="Trading OS long")

if shortSignal and strategy.position_size == 0
    strategy.entry("S", strategy.short, comment="Trading OS short")

longStop = useFixedStop ? strategy.position_avg_price - fixedStopPoints : openingLow
shortStop = useFixedStop ? strategy.position_avg_price + fixedStopPoints : openingHigh
longTarget = strategy.position_avg_price + (strategy.position_avg_price - longStop) * riskReward
shortTarget = strategy.position_avg_price - (shortStop - strategy.position_avg_price) * riskReward

if strategy.position_size > 0
    strategy.exit("L-risk", "L", stop=longStop, limit=longTarget)

if strategy.position_size < 0
    strategy.exit("S-risk", "S", stop=shortStop, limit=shortTarget)

if mustForceClose and strategy.position_size != 0
    strategy.close_all(comment="Forced intraday close")

plot(openingHigh, "Opening high", color=color.new(color.green, 0), linewidth=1)
plot(openingLow, "Opening low", color=color.new(color.red, 0), linewidth=1)
plot(emaValue, "EMA filter", color=color.new(color.blue, 40), display=emaFilterEnabled ? display.all : display.none)
`;
}

function generatePineVersion(input) {
  const initial = model.normalizeVersion(input);
  const sourceCode = buildSource(initial);
  return model.normalizeVersion({
    ...initial,
    sourceCode,
    sourceHash: model.hashText(sourceCode),
    compileStatus: 'external_validation_required',
    status: 'generated',
    generationSource: initial.generationSource || 'deterministic_generator',
  });
}

function exportFilename(version) {
  const normalized = model.normalizeVersion(version);
  return `${normalized.baseStrategyId}/${normalized.version}.pine`;
}

module.exports = {
  buildSource,
  generatePineVersion,
  exportFilename,
  openingRangeSession,
};
