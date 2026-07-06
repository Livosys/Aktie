'use strict';

const assert = require('assert/strict');

const {
  SAFETY,
  calculateResearchScore,
  scoreBand,
  _internal,
} = require('./researchScoreService');

function assertSafety(safety) {
  assert.deepEqual(safety, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  });
}

{
  const score = calculateResearchScore({
    strategyId: 'aapl_sma20_sma200',
    version: 1,
    testResult: {
      netProfitPct: 6.03,
      profitFactor: 1.8,
      winRate: 33.67,
      maxDrawdownPct: -1.89,
      trades: 98,
      avgTradePct: 0.18,
      bestTradePct: 2.2,
      worstTradePct: -0.9,
      stabilityAcrossSymbols: 0.72,
      stabilityAcrossTimeframes: 0.7,
      stabilityAcrossPeriods: 0.75,
      dataQuality: 0.9,
    },
  });

  assert.equal(score.strategyId, 'aapl_sma20_sma200');
  assert.equal(score.version, 1);
  assert.ok(score.score > 70, `expected score > 70, got ${score.score}`);
  assert.ok(['promising', 'strong_candidate'].includes(score.band), 'good strategy reaches promising band');
  assert.ok(score.reasons.includes('Strong profit factor'), 'profit factor reason');
  assert.ok(score.reasons.includes('Controlled drawdown'), 'drawdown reason');
  assert.ok(score.reasons.includes('Enough trades'), 'sample reason');
  assert.ok(score.warnings.includes('Winrate can be improved'), 'low winrate warning still visible');
  assertSafety(score.safety);
}

{
  const weak = calculateResearchScore({
    strategyId: 'bad_strategy',
    testResult: {
      profitFactor: 0.7,
      winRate: 28,
      maxDrawdownPct: -20,
      trades: 10,
      avgTradePct: -0.2,
      bestTradePct: 0.8,
      worstTradePct: -2,
      stabilityAcrossSymbols: 0.25,
      stabilityAcrossTimeframes: 0.3,
      stabilityAcrossPeriods: 0.2,
      dataQuality: 0.45,
    },
  });

  assert.ok(weak.score < 40, `expected weak score < 40, got ${weak.score}`);
  assert.equal(weak.band, 'weak');
  assert.ok(weak.warnings.includes('Profit factor below breakeven'), 'weak PF warning');
  assert.ok(weak.warnings.includes('Drawdown is high'), 'drawdown warning');
  assert.ok(weak.warnings.includes('Sample size is small'), 'sample warning');
  assertSafety(weak.safety);
}

{
  const missing = calculateResearchScore({});

  assert.equal(missing.score >= 0 && missing.score <= 100, true, 'missing data score in range');
  assert.equal(missing.band, scoreBand(missing.score), 'band matches score');
  assert.ok(missing.warnings.includes('Missing test result data'), 'missing data warning');
  assert.ok(missing.warnings.includes('Profit factor missing'), 'missing PF warning');
  assert.ok(missing.warnings.includes('Trade count missing'), 'missing trades warning');
  assert.deepEqual(Object.keys(missing.components), [
    'profitFactor',
    'drawdown',
    'winRate',
    'sampleSize',
    'stability',
    'riskReward',
    'dataQuality',
  ]);
  assertSafety(missing.safety);
}

{
  const deceptive = calculateResearchScore({
    strategyId: 'high_winrate_bad_pf',
    testResult: {
      profitFactor: 0.8,
      winRate: 80,
      maxDrawdownPct: -12,
      trades: 75,
      avgTradePct: -0.05,
      bestTradePct: 0.4,
      worstTradePct: -1.1,
      stabilityAcrossSymbols: 0.45,
      stabilityAcrossTimeframes: 0.45,
      stabilityAcrossPeriods: 0.4,
      dataQuality: 0.8,
    },
  });

  assert.ok(deceptive.components.winRate >= 14, 'high winrate component rewarded');
  assert.ok(deceptive.components.profitFactor < 5, 'bad PF heavily penalized');
  assert.ok(deceptive.score < 70, `high winrate/bad PF must not be high score, got ${deceptive.score}`);
  assert.notEqual(deceptive.band, 'promising');
  assert.notEqual(deceptive.band, 'strong_candidate');
  assert.ok(deceptive.warnings.includes('Profit factor below breakeven'), 'bad PF warning');
  assertSafety(deceptive.safety);
}

{
  assert.equal(scoreBand(0), 'weak');
  assert.equal(scoreBand(39), 'weak');
  assert.equal(scoreBand(40), 'needs_improvement');
  assert.equal(scoreBand(59), 'needs_improvement');
  assert.equal(scoreBand(60), 'watchlist');
  assert.equal(scoreBand(69), 'watchlist');
  assert.equal(scoreBand(70), 'promising');
  assert.equal(scoreBand(79), 'promising');
  assert.equal(scoreBand(80), 'strong_candidate');
  assert.equal(scoreBand(100), 'strong_candidate');
}

{
  assert.equal(_internal.normalizePercent(0.5), 50);
  assert.equal(_internal.normalizePercent(-0.02), -2);
  assert.equal(_internal.normalizeRatio(75), 0.75);
  assert.equal(_internal.normalizeRatio(0.75), 0.75);
}

console.log('researchScoreService.test.js: OK');
