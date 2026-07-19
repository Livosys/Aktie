'use strict';

// Unit tests for the generic ORB parity adapter. All candles below are
// synthetic engine_test fixtures created inline for rule verification only.
// They are never written to the Pine Research store as real market data and
// never mixed with real performance results.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const adapter = require('./pineResearchOrbAdapterService');
const testRunService = require('./pineResearchTestRunService');
const { createPineResearchStore } = require('./pineResearchStoreService');

const NY_UTC_OFFSET_WINTER = 5; // 2025-01 dates below are all EST

function nyBar(day, hhmm, open, high, low, close, volume = 1000) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const ts = new Date(Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
    hh + NY_UTC_OFFSET_WINTER,
    mm,
  )).toISOString();
  return { ts, o: open, h: high, l: low, c: close, v: volume };
}

function versionInput(overrides = {}) {
  return {
    pineVersionId: overrides.pineVersionId || 'opening_range_breakout_vtest',
    candidateId: 'candidate_opening_range_breakout_001',
    baseStrategyId: 'opening_range_breakout',
    version: overrides.version || 'vtest',
    parameters: overrides.parameters || {},
    direction: overrides.direction,
    riskRules: overrides.riskRules || { commission: 2, slippage: 1 },
  };
}

// 30m opening range 21000-21050 on 2025-01-06
const RANGE_BARS = [
  nyBar('2025-01-06', '09:30', 21010, 21030, 21005, 21020),
  nyBar('2025-01-06', '09:35', 21020, 21050, 21010, 21040),
  nyBar('2025-01-06', '09:40', 21040, 21045, 21000, 21010),
  nyBar('2025-01-06', '09:45', 21010, 21020, 21005, 21015),
  nyBar('2025-01-06', '09:50', 21015, 21025, 21008, 21012),
  nyBar('2025-01-06', '09:55', 21012, 21030, 21006, 21025),
];

function normalize(bars) {
  return bars.map((raw) => ({
    ts: raw.ts,
    tsMs: Date.parse(raw.ts),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
  }));
}

function run(version, rawBars, options = {}) {
  const result = adapter.runOrbBacktest(version, normalize(rawBars), { symbol: 'MNQ', timeframe: '5m', ...options });
  assert.equal(result.ok, true, `backtest should run: ${JSON.stringify(result.issues || [])}`);
  return result;
}

function testLongBreakoutTargetWin() {
  const bars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060), // close > 21050 => long signal
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090), // entry fill 21062.25
    nyBar('2025-01-06', '10:10', 21070, 21160, 21060, 21150), // target 21155.625 hit
  ];
  const result = run(versionInput(), bars);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.direction, 'long');
  assert.equal(trade.entryPrice, 21062.25); // next bar open + 1 tick slippage
  assert.equal(trade.exitReason, 'target');
  assert.equal(trade.exitPrice, 21155.625); // entry + (entry-21000)*1.5, no slippage on limit
  assert.equal(trade.commission, 4); // $2/contract per side
  assert.equal(trade.netPnl, Number(((21155.625 - 21062.25) * 2 - 4).toFixed(2)));
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.metrics.winRate, 100);
  assert.equal(result.metrics.longTrades, 1);
  assert.equal(result.metrics.shortTrades, 0);
}

function testStopLossWithSlippage() {
  const bars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060),
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090),
    nyBar('2025-01-06', '10:10', 21050, 21055, 20990, 21000), // low <= range stop 21000
  ];
  const result = run(versionInput(), bars);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, 'stop');
  assert.equal(trade.exitPrice, 20999.75); // stop 21000 minus 1 tick slippage
  assert.equal(trade.netPnl, Number(((20999.75 - 21062.25) * 2 - 4).toFixed(2)));
}

function testDirectionGating() {
  const shortBars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21005, 21010, 20980, 20990), // close < 21000 => short signal
    nyBar('2025-01-06', '10:05', 20988, 20995, 20940, 20950), // short entry 20987.75
    nyBar('2025-01-06', '10:10', 20950, 20960, 20890, 20900), // target 20894.375 hit
  ];
  const shortOnly = run(versionInput({ parameters: { direction: 'short_only' }, direction: 'short_only' }), shortBars);
  assert.equal(shortOnly.trades.length, 1);
  assert.equal(shortOnly.trades[0].direction, 'short');
  assert.equal(shortOnly.trades[0].entryPrice, 20987.75); // open - 1 tick slippage (against short)
  assert.equal(shortOnly.trades[0].exitReason, 'target');
  assert.equal(shortOnly.trades[0].exitPrice, Number((20987.75 - (21050 - 20987.75) * 1.5).toFixed(4)));

  const longOnly = run(versionInput({ parameters: { direction: 'long_only' }, direction: 'long_only' }), shortBars);
  assert.equal(longOnly.trades.length, 0, 'long_only must ignore short breakouts');
}

function testLastEntryTimeCutoff() {
  const bars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '11:30', 21030, 21065, 21020, 21060), // breakout but at/after lastEntryTime
    nyBar('2025-01-06', '11:35', 21062, 21100, 21050, 21090),
  ];
  const result = run(versionInput(), bars);
  assert.equal(result.trades.length, 0, 'no entries at or after lastEntryTime');
}

function testForcedClose() {
  const bars = [...RANGE_BARS];
  for (let m = 600; m < 680; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    bars.push(nyBar('2025-01-06', `${hh}:${mm}`, 21030, 21045, 21020, 21030)); // inside range, no signal
  }
  bars.push(nyBar('2025-01-06', '11:20', 21030, 21060, 21020, 21055)); // long signal
  bars.push(nyBar('2025-01-06', '11:25', 21056, 21058, 21040, 21050)); // entry 21056.25
  for (let m = 690; m < 955; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    bars.push(nyBar('2025-01-06', `${hh}:${mm}`, 21050, 21060, 21040, 21050)); // neutral hold
  }
  bars.push(nyBar('2025-01-06', '15:55', 21050, 21060, 21040, 21045)); // forced close window
  bars.push(nyBar('2025-01-06', '16:00', 21048, 21052, 21044, 21050)); // fill bar
  const result = run(versionInput(), bars);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, 'forced_close');
  assert.equal(trade.exitPrice, 21047.75); // 16:00 open minus slippage
  assert.ok(trade.exitTime.startsWith('2025-01-06T21:00'), 'forced close fills at 16:00 NY');
}

function testDayResetAndOvernightPrevention() {
  const day1 = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060),
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090), // entry 21062.25
    nyBar('2025-01-06', '11:00', 21080, 21090, 21070, 21085), // day1 data ends with open position
  ];
  const day2 = [
    nyBar('2025-01-07', '09:30', 21110, 21130, 21105, 21120),
    nyBar('2025-01-07', '09:35', 21120, 21150, 21110, 21140),
    nyBar('2025-01-07', '09:40', 21140, 21145, 21100, 21110),
    nyBar('2025-01-07', '09:45', 21110, 21120, 21105, 21115),
    nyBar('2025-01-07', '09:50', 21115, 21125, 21108, 21112),
    nyBar('2025-01-07', '09:55', 21112, 21130, 21106, 21125),
    nyBar('2025-01-07', '10:00', 21130, 21165, 21120, 21160), // breakout over day2 high 21150
    nyBar('2025-01-07', '10:05', 21165, 21200, 21150, 21190), // entry 21165.25
    nyBar('2025-01-07', '10:10', 21200, 21270, 21190, 21260), // target 21263.125 hit
  ];
  const result = run(versionInput(), [...day1, ...day2]);
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].exitReason, 'end_of_session_data_gap');
  assert.ok(result.trades[0].exitTime.startsWith('2025-01-06'), 'day1 position never crosses into day2');
  assert.ok(result.warnings.some((w) => w.startsWith('overnight_prevented_close_at_last_session_bar')));
  const day2Trade = result.trades[1];
  assert.ok(day2Trade.entryTime.startsWith('2025-01-07'));
  assert.equal(day2Trade.exitPrice, Number((21165.25 + (21165.25 - 21100) * 1.5).toFixed(4)), 'day2 stop uses day2 range low 21100');
}

function testFifteenMinuteRange() {
  const bars = [
    nyBar('2025-01-06', '09:30', 21010, 21040, 21010, 21020),
    nyBar('2025-01-06', '09:35', 21020, 21050, 21000, 21040),
    nyBar('2025-01-06', '09:40', 21040, 21045, 21005, 21010),
    nyBar('2025-01-06', '09:45', 21040, 21060, 21030, 21055), // 15m range complete => breakout
    nyBar('2025-01-06', '09:50', 21056, 21100, 21050, 21090), // entry
    nyBar('2025-01-06', '10:00', 21070, 21160, 21060, 21150), // target hit
  ];
  const result = run(versionInput({ parameters: { openingRangeMinutes: 15 } }), bars);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 21056.25);
}

function testFixedStop() {
  const bars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060),
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090), // entry 21062.25, fixed stop 21042.25
    nyBar('2025-01-06', '10:10', 21055, 21060, 21040, 21045), // hits fixed stop, not range stop
  ];
  const result = run(versionInput({ parameters: { stopMode: 'fixed_points', stopValue: 20 } }), bars);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, 'stop');
  assert.equal(result.trades[0].exitPrice, 21042); // 21042.25 - slippage
}

function testRetestEntry() {
  const pureBreakout = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21055, 21070, 21052, 21060), // low 21052 > 21050 => no retest
    nyBar('2025-01-06', '10:05', 21060, 21070, 21048, 21060), // low 21048 <= 21050 and close > 21050 => retest signal
    nyBar('2025-01-06', '10:10', 21062, 21100, 21050, 21090), // entry
  ];
  const result = run(versionInput({ parameters: { entryMode: 'retest' } }), pureBreakout);
  assert.equal(result.trades.length, 1);
  assert.ok(result.trades[0].entryTime.startsWith('2025-01-06T15:10'), 'retest entry fills on the 10:10 bar');
}

function testVolumeFilterWarmup() {
  const bars = [
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060, 9000), // high volume but SMA20 not warm
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090, 9000),
  ];
  const result = run(versionInput({ parameters: { volumeFilterEnabled: true, volumeMultiplier: 1.4 } }), bars);
  assert.equal(result.trades.length, 0, 'volume filter requires 20 bars of SMA history, like Pine na-comparison');

  const preBars = [];
  for (let m = 8 * 60; m < 570; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    preBars.push(nyBar('2025-01-06', `${hh}:${mm}`, 21010, 21015, 21005, 21010, 1000)); // pre-session warmup bars
  }
  const warm = run(
    versionInput({ parameters: { volumeFilterEnabled: true, volumeMultiplier: 1.4 } }),
    [...preBars, ...RANGE_BARS, ...[
      nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060, 9000),
      nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090, 9000),
      nyBar('2025-01-06', '10:10', 21070, 21160, 21060, 21150, 9000),
    ]],
  );
  assert.equal(warm.trades.length, 1, 'high-volume breakout passes the warm SMA filter');
}

function testEmaFilterBlocksCounterTrend() {
  const preBars = [];
  for (let m = 8 * 60; m < 570; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    preBars.push(nyBar('2025-01-06', `${hh}:${mm}`, 22000, 22005, 21995, 22000)); // pre-session bars anchor EMA far above
  }
  const bars = [
    ...preBars,
    ...RANGE_BARS,
    nyBar('2025-01-06', '10:00', 21030, 21065, 21020, 21060),
    nyBar('2025-01-06', '10:05', 21062, 21100, 21050, 21090),
  ];
  const result = run(versionInput({ parameters: { emaFilterEnabled: true, emaLength: 50 } }), bars);
  assert.equal(result.trades.length, 0, 'long breakout below EMA is filtered out');
}

function testParityMatrix() {
  const certified = adapter.buildParityMatrix(versionInput(), { engine: 'internal_preview', symbol: 'MNQ', timeframe: '5m' });
  assert.equal(certified.certified, true);
  assert.equal(certified.parityStatus, 'certified');
  assert.equal(certified.unsupportedRules.length, 0);
  assert.ok(certified.matrix.every((row) => ['exact', 'equivalent'].includes(row.matchStatus) || row.mandatory === false));

  const batchEngine = adapter.buildParityMatrix(versionInput(), { engine: 'batch', symbol: 'MNQ', timeframe: '5m' });
  assert.equal(batchEngine.certified, false, 'batch engine has no certified ORB path');

  const badStop = adapter.buildParityMatrix(versionInput({ parameters: { stopMode: 'trailing' } }), { engine: 'internal_preview', symbol: 'MNQ', timeframe: '5m' });
  assert.equal(badStop.certified, false);
  assert.ok(badStop.unsupportedRules.includes('stop mode'));

  const wrongFamily = adapter.buildParityMatrix({ ...versionInput(), baseStrategyId: 'mean_reversion' }, { engine: 'internal_preview', symbol: 'MNQ', timeframe: '5m' });
  assert.equal(wrongFamily.certified, false);

  const retestMatrix = adapter.buildParityMatrix(versionInput({ parameters: { entryMode: 'retest' } }), { engine: 'internal_preview', symbol: 'MNQ', timeframe: '5m' });
  assert.equal(retestMatrix.certified, true, 'retest is a certified mapped rule');
}

function writeFixtureDay(rootDir, symbol, timeframe, day, bars) {
  const dir = path.join(rootDir, `candles-${timeframe}`, symbol);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), bars.map((bar) => JSON.stringify(bar)).join('\n') + '\n', 'utf8');
}

function fullSessionDay(day, base) {
  const bars = [];
  for (let m = 570; m < 960; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const drift = (m - 570) * 0.05;
    bars.push(nyBar(day, `${hh}:${mm}`, base + drift, base + drift + 12, base + drift - 12, base + drift + 4));
  }
  return bars;
}

function testDataReadinessAndSingleRun() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-data-'));
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-store-'));
  try {
    const missing = adapter.assessDataReadiness(
      { symbol: 'MNQ', timeframe: '5m' },
      { dateRange: { from: '2025-01-01', to: '2025-01-31' }, rootDir: dataRoot },
    );
    assert.equal(missing.dataStatus, 'missing');
    assert.equal(missing.bars, 0);

    const days = ['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10'];
    days.forEach((day, idx) => writeFixtureDay(dataRoot, 'MNQ', '5m', day, fullSessionDay(day, 21000 + idx * 20)));

    const ready = adapter.assessDataReadiness(
      { symbol: 'MNQ', timeframe: '5m' },
      { dateRange: { from: '2025-01-01', to: '2025-01-31' }, rootDir: dataRoot },
    );
    assert.equal(ready.dataStatus, 'ready');
    assert.equal(ready.completeSessionDays, 5);
    assert.equal(ready.bars, 5 * 78);

    const store = createPineResearchStore({ rootDir: storeRoot });
    const preview = testRunService.previewSingleTestRun(versionInput(), {
      symbol: 'MNQ',
      timeframe: '5m',
      dateRange: { from: '2025-01-01', to: '2025-01-31' },
      dataRootDir: dataRoot,
    });
    assert.equal(preview.parityStatus, 'certified');
    assert.equal(preview.dataStatus, 'ready');
    assert.equal(preview.wouldRun, true);
    assert.equal(preview.blockedReason, null);
    assert.equal(preview.safety.actions_allowed, false);

    const single = testRunService.runSingleTestRun(versionInput(), {
      store,
      symbol: 'MNQ',
      timeframe: '5m',
      dateRange: { from: '2025-01-01', to: '2025-01-31' },
      dataRootDir: dataRoot,
    });
    assert.equal(single.ok, true);
    assert.equal(single.status, 'completed');
    assert.equal(single.testRun.parityStatus, 'certified');
    assert.ok(Number.isFinite(single.testRun.metrics.netPnl));
    assert.ok(single.testRun.resultArtifact, 'trades artifact is written');
    assert.equal(store.list('testRuns').length, 1);

    const blocked = testRunService.runSingleTestRun(versionInput(), {
      store,
      symbol: 'MES',
      timeframe: '5m',
      dateRange: { from: '2025-01-01', to: '2025-01-31' },
      dataRootDir: dataRoot,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.testRun, null, 'blocked single runs are not persisted');
    assert.equal(store.list('testRuns').length, 1);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

function main() {
  testLongBreakoutTargetWin();
  testStopLossWithSlippage();
  testDirectionGating();
  testLastEntryTimeCutoff();
  testForcedClose();
  testDayResetAndOvernightPrevention();
  testFifteenMinuteRange();
  testFixedStop();
  testRetestEntry();
  testVolumeFilterWarmup();
  testEmaFilterBlocksCounterTrend();
  testParityMatrix();
  testDataReadinessAndSingleRun();
  console.log('pineResearchOrbAdapterService.test.js passed');
}

main();
