'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createStrategyRegistryService } = require('./strategyRegistryService');
const { createStrategyScoreService } = require('./strategyScoreService');

function makeCatalog() {
  return {
    getCatalog() {
      return {
        strategies: [
          {
            id: 'INTERNAL_ACTIVE',
            name: 'Internal Active',
            status: 'active',
            enabled: true,
            description: 'Active internal strategy',
            performanceSummary: { win_rate: 0.61, avg_pnl: 1.1, trades: 18, score: 72 },
            marketRegimeTags: ['trend'],
            allowedTimeframes: ['5m'],
            entryRules: ['price_above_vwap'],
            exitRules: ['stop_loss'],
            supportScanner: true,
          },
          {
            id: 'TV_PAUSED',
            name: 'TV Paused',
            status: 'paused',
            enabled: false,
            description: 'Paused tradingview strategy',
            performanceSummary: { win_rate: 0.31, avg_pnl: -0.6, trades: 6, score: 24 },
            marketRegimeTags: ['risk_on'],
            allowedTimeframes: ['5m'],
            entryRules: ['rsi_cross'],
            exitRules: ['timeout'],
          },
        ],
      };
    },
  };
}

function makeRegistry() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-score-'));
  const registryFile = path.join(tmpDir, 'strategy-registry.jsonl');
  const registry = createStrategyRegistryService({
    registryFile,
    daytradingCatalog: makeCatalog(),
  });
  registry.registerTradingViewStrategy('TV_ACTIVE', {
    strategy_name: 'TV Active',
    source: 'tradingview',
    status: 'paper_only',
    enabled: true,
    mode: 'paper_only',
  });
  registry.pauseStrategy('TV_PAUSED', 'slow and weak');
  return registry;
}

{
  const registry = makeRegistry();
  const candidateEntries = [
    { strategy_id: 'TV_ACTIVE' },
    { strategy_id: 'TV_ACTIVE' },
    { strategy_id: 'TV_ACTIVE' },
  ];
  const paperTrades = [
    { strategy_id: 'TV_ACTIVE' },
    { strategy_id: 'TV_ACTIVE' },
  ];
  const scoreService = createStrategyScoreService({
    registryService: registry,
    candidateLoader: () => candidateEntries,
    paperTradeLoader: () => paperTrades,
  });

  const status = scoreService.getStrategyScores();
  assert.equal(status.ok, true, 'score status ok');
  assert.equal(status.total_strategies, 3, 'score total strategies');
  assert.equal(status.scored_strategies, 3, 'score scored strategies');
  assert.equal(status.top_strategies.length, 1, 'top strategies bucket');
  assert.equal(status.weak_strategies.length, 2, 'weak strategies bucket');
  assert.equal(status.uncertain_strategies.length, 2, 'uncertain strategies bucket');
  assert.equal(status.tradingview_strategies.length, 1, 'tradingview bucket');
  assert.equal(status.internal_strategies.length, 2, 'internal bucket');
  assert.equal(status.recommended_next_tests.length >= 2, true, 'recommended next tests bucket');
  assert.equal(status.latest_blocked_reason, 'slow and weak', 'latest blocked reason');
  assert.equal(status.safety.actions_allowed, false, 'score safety actions_allowed');
  assert.equal(status.safety.can_place_orders, false, 'score safety can_place_orders');
  assert.equal(status.safety.live_trading_enabled, false, 'score safety live_trading_enabled');
  assert.equal(status.safety.mode, 'paper_only', 'score safety mode');

  const active = status.strategies.find((row) => row.strategy_id === 'INTERNAL_ACTIVE');
  assert.ok(active, 'internal active score exists');
  assert.equal(active.source, 'internal', 'internal active source');
  assert.equal(active.status, 'active', 'internal active status');
  assert.equal(active.sample_size, 18, 'internal active sample size');
  assert.ok(active.confidence < 60, 'internal active confidence low-ish without additional paper');
  assert.ok(active.recommended_action.includes('replay'), 'internal active recommended replay');
  assert.ok(active.weaknesses.includes('Inget mätbart underlag ännu') === false, 'internal active has some data');

  const tvActive = status.strategies.find((row) => row.strategy_id === 'TV_ACTIVE');
  assert.ok(tvActive, 'tv active score exists');
  assert.equal(tvActive.source, 'tradingview', 'tv active source');
  assert.equal(tvActive.sample_size, 3, 'tv active sample size');
  assert.ok(tvActive.strengths.some((text) => text.includes('TradingView')), 'tv active strengths');
  assert.ok(tvActive.recommended_action.includes('replay/batch'), 'tv active recommended action');
  assert.ok(status.tradingview_strategies.some((row) => row.strategy_id === 'TV_ACTIVE'), 'tradingview bucket contains tv active');
  assert.ok(status.recommended_next_tests.some((row) => row.strategy_id === 'INTERNAL_ACTIVE'), 'recommended next tests contains internal active');

  const paused = status.strategies.find((row) => row.strategy_id === 'TV_PAUSED');
  assert.ok(paused, 'paused score exists');
  assert.equal(paused.status, 'paused', 'paused status');
  assert.equal(paused.recommended_action.includes('paper entries'), true, 'paused recommended no new paper entries');
  assert.ok(paused.weaknesses.includes('Pausad strategi'), 'paused weakness');
  assert.ok(paused.confidence <= 28, 'paused low confidence');

  const single = scoreService.getStrategyScore('TV_ACTIVE');
  assert.equal(single.ok, true, 'single ok');
  assert.equal(single.strategy.strategy_id, 'TV_ACTIVE', 'single strategy id');
}

console.log('Strategy score tests passed.');
