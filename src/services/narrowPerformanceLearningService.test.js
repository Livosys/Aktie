'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function loadServiceWithData(seedFn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-performance-'));
  fs.mkdirSync(path.join(tmpDir, 'paper-trading'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'strategy-batches', 'results'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'replay', 'runs', 'run_test'), { recursive: true });

  if (typeof seedFn === 'function') seedFn(tmpDir);

  process.env.NARROW_DATA_DIR = tmpDir;
  const servicePath = require.resolve('./narrowPerformanceLearningService');
  delete require.cache[servicePath];
  return require('./narrowPerformanceLearningService');
}

{
  const service = loadServiceWithData((tmpDir) => {
    writeJsonl(path.join(tmpDir, 'paper-trading', 'trades.jsonl'), [
      {
        tradeId: 'vw_1',
        symbol: 'BTCUSDT',
        signalFamily: 'VWAP_MOMENTUM_LONG',
        result: 'WIN',
        pnlPct: 0.42,
      },
    ]);

    writeJson(path.join(tmpDir, 'strategy-batches', 'results', 'batch_old.json'), {
      strategy_id: 'narrow_state_expansion_long',
      symbol: 'BTCUSDT',
      trades: 12,
      wins: 6,
      losses: 4,
      avg_pnl: 0.2,
      total_pnl: 2.4,
      created_at: '2026-05-27T00:00:00.000Z',
    });

    writeJsonl(path.join(tmpDir, 'replay', 'runs', 'run_test', 'events.jsonl'), [
      {
        strategy_id: 'vwap_volume_breakout_long',
        symbol: 'AAPL',
        result: 'WIN',
        pnlPct: 0.2,
      },
    ]);
  });

  const summary = service.buildNarrowPerformanceSummary();
  assert.equal(summary.summary.status, 'needs_more_data', 'empty dataset status');
  assert.equal(summary.summary.totalTrades, 0, 'empty dataset total trades');
  assert.equal(summary.summary.message, 'Systemet har ännu för lite Narrow State-data för säker slutsats.', 'empty dataset message');
  assert.equal(summary.rankings.length, 3, 'empty dataset ranking scaffold');
  assert.equal(summary.scoreBands.length, 4, 'empty dataset score-band scaffold');
  assert.equal(summary.confirmations.length, 5, 'empty dataset confirmation scaffold');
  assert.equal(summary.recommendedNextTest.strategy_id, 'narrow_breakout_v1', 'empty dataset next test');
  assert.ok(summary.warnings.includes('no_narrow_state_data'), 'empty dataset warning');
  for (const row of summary.rankings) {
    assert.equal(row.trades, 0, 'empty ranking trades');
    assert.equal(row.verdict, 'needs_more_data', 'empty ranking verdict');
  }
  assert.equal(summary.actions_allowed, false, 'safety actions_allowed');
  assert.equal(summary.can_place_orders, false, 'safety can_place_orders');
  assert.equal(summary.live_trading_enabled, false, 'safety live_trading_enabled');
  assert.equal(summary.broker_enabled, false, 'safety broker_enabled');
}

{
  const service = loadServiceWithData((tmpDir) => {
    writeJsonl(path.join(tmpDir, 'paper-trading', 'trades.jsonl'), [
      {
        tradeId: 'narrow_trade_1',
        symbol: 'NVDA',
        strategy_id: 'narrow_breakout_v1',
        strategy_family: 'narrow_state',
        narrowScore: 84,
        regimeLabel: 'narrow_breakout_watch',
        confirmationUsed: { vwap: true, volume: true },
        entryPrice: 100,
        exitPrice: 101,
        result: 'WIN',
        pnlPct: 1.0,
      },
    ]);

    writeJson(path.join(tmpDir, 'strategy-batches', 'results', 'batch_narrow.json'), {
      strategy_id: 'narrow_fakeout_reversal_v1',
      strategy_family: 'narrow_state',
      symbol: 'NVDA',
      trades: 3,
      wins: 1,
      losses: 2,
      avg_pnl: -0.15,
      total_pnl: -0.45,
      created_at: '2026-05-27T00:00:00.000Z',
    });
  });

  const summary = service.buildNarrowPerformanceSummary();
  assert.equal(summary.summary.status, 'low_confidence', 'mixed dataset status');
  assert.equal(summary.summary.totalTrades, 4, 'mixed dataset total trades');
  assert.equal(summary.rankings.length, 2, 'mixed dataset rankings');
  assert.equal(summary.rankings[0].strategy_id, 'narrow_breakout_v1', 'best strategy');
  assert.ok(summary.warnings.includes('missing_narrowScore:batch'), 'batch missing narrowScore warning');
  assert.ok(summary.warnings.includes('missing_regimeLabel:batch'), 'batch missing regime warning');
  assert.equal(summary.scoreBands.some((band) => band.band === 'strong_compression' && band.trades === 1), true, 'strong band counted');
  assert.equal(summary.confirmations.find((c) => c.confirmation === 'vwap').impact, 'insufficient_data', 'confirmation impact low data');
}

console.log('Narrow performance learning tests passed.');
