'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SAFETY,
  TARGET_SCORE,
  createStrategyEvolutionService,
  scoreBand,
} = require('./strategyEvolutionService');

function tmpFile(name = 'strategy-evolution.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-evolution-'));
  return path.join(dir, name);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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
  const file = tmpFile();
  const service = createStrategyEvolutionService({ dataFile: file });
  const result = service.readStrategyEvolution();

  assert.equal(result.ok, true, 'missing file is non-fatal');
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.items, []);
  assert.equal(result.summary.totalStrategies, 0);
  assert.ok(result.warnings.includes('strategy_evolution_file_missing'));
  assert.deepEqual(result.targetScore, TARGET_SCORE);
  assertSafety(result.safety);
  assert.equal(fs.existsSync(file), false, 'service does not create missing data file');
}

{
  const file = tmpFile();
  fs.writeFileSync(file, '{ bad json', 'utf8');
  const result = createStrategyEvolutionService({ dataFile: file }).readStrategyEvolution();

  assert.equal(result.ok, false, 'invalid JSON returns error status');
  assert.equal(result.status, 'error');
  assert.match(result.error, /invalid_strategy_evolution_json/);
  assert.deepEqual(result.items, []);
  assertSafety(result.safety);
}

{
  const file = tmpFile();
  const data = {
    strategies: [
      {
        strategyId: 'aapl_sma20_sma200',
        name: 'AAPL SMA20/SMA200',
        versions: [
          {
            version: 1,
            status: 'tested',
            source: 'ai_generated',
            pineScriptPossible: true,
            createdAt: '2026-07-07T00:00:00.000Z',
            changeSummary: 'Initial SMA20/SMA200 version',
            hypothesis: 'Trend filter should reduce noisy entries',
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
            decision: 'promising',
            nextImprovement: 'Test RSI > 50 and rising SMA200',
          },
          {
            version: 2,
            status: 'tested',
            source: 'ai_generated',
            pineScriptPossible: true,
            aiScore: 88,
            decision: 'promising',
            scoreDetails: {
              reasons: ['Manual score still valid'],
              warnings: [],
              components: {
                profitFactor: 24,
                drawdown: 18,
                winRate: 14,
                sampleSize: 9,
                stability: 18,
                riskReward: 9,
                dataQuality: 8,
              },
            },
          },
          {
            version: 3,
            source: 'ai_generated',
            pineScriptPossible: true,
            decision: 'retest',
          },
        ],
      },
      {
        strategyId: 'weak_strategy',
        name: 'Weak Strategy',
        versions: [
          {
            version: 1,
            status: 'tested',
            source: 'ai_generated',
            pineScriptPossible: true,
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
          },
        ],
      },
    ],
  };
  writeJson(file, data);
  const before = fs.readFileSync(file, 'utf8');
  const result = createStrategyEvolutionService({ dataFile: file }).readStrategyEvolution();
  const after = fs.readFileSync(file, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].strategyId, 'aapl_sma20_sma200');
  assert.equal(result.items[0].versions.length, 3);
  assert.equal(result.items[0].versions[0].aiScore, 75);
  assert.equal(result.items[0].versions[0].band, 'promising');
  assert.equal(result.items[0].versions[0].scoreBand, 'promising');
  assert.equal(result.items[0].versions[0].recommendation.recommendedAction, 'retest');
  assert.equal(result.items[0].versions[0].recommendation.priority, 'medium');
  assert.ok(Array.isArray(result.items[0].versions[0].recommendation.weaknesses));
  assert.ok(Array.isArray(result.items[0].versions[0].scoreDetails.reasons), 'auto score details reasons');
  assert.ok(result.items[0].versions[0].scoreDetails.reasons.includes('Strong profit factor'), 'auto score details reasons include PF');
  assert.equal(result.items[0].versions[0].testResult.trades, 98);
  assert.equal(result.items[0].versions[1].status, 'waiting_for_test');
  assert.equal(result.items[0].versions[1].aiScore, 88, 'existing aiScore preserved');
  assert.equal(result.items[0].versions[1].band, 'strong_candidate', 'existing aiScore band derived');
  assert.equal(result.items[0].versions[1].scoreDetails.reasons[0], 'Manual score still valid', 'existing score details preserved');
  assert.equal(result.items[0].versions[1].recommendation.recommendedAction, 'promote_candidate');
  assert.equal(result.items[0].versions[1].recommendation.priority, 'low');
  assert.equal(result.items[0].versions[1].recommendation.nextTestPlan.dryRun, true);
  assert.equal(result.items[0].versions[1].recommendation.nextTestPlan.execution, false);
  assert.equal(result.items[0].versions[1].recommendation.nextTestPlan.broker, false);
  assert.equal(result.items[0].versions[1].recommendation.nextTestPlan.orders, false);
  assert.equal(result.items[0].versions[2].status, 'waiting_for_test');
  assert.equal(result.items[0].versions[2].aiScore, null);
  assert.equal(result.items[0].versions[2].recommendation.recommendedAction, 'wait_for_test');
  assert.equal(result.items[0].versions[2].recommendation.blockedReason, 'missing_test_result');
  assert.equal(result.items[0].versions[2].scoreDetails, null);
  assert.equal(result.items[1].strategyId, 'weak_strategy');
  assert.equal(result.items[1].versions[0].band, 'weak');
  assert.equal(result.items[1].versions[0].aiScore < 40, true, 'weak score stays weak');
  assert.equal(result.items[1].versions[0].recommendation.recommendedAction, 'collect_more_data');
  assert.equal(result.items[1].versions[0].recommendation.priority, 'medium');
  assert.equal(result.items[1].versions[0].recommendation.nextTestPlan.dryRun, true);
  assert.equal(result.summary.totalStrategies, 2);
  assert.equal(result.summary.totalVersions, 4);
  assert.equal(result.summary.promisingCount >= 1, true);
  assert.equal(result.summary.strongCandidateCount >= 1, true);
  assert.equal(result.summary.needsImprovementCount >= 1, true);
  assert.equal(result.summary.waitingForTestCount, 2);
  assert.equal(result.summary.byDecision.promising >= 2, true);
  assert.equal(result.summary.recommendationSummary.promoteCandidateCount, 1);
  assert.equal(result.summary.recommendationSummary.retestCount, 1);
  assert.equal(result.summary.recommendationSummary.collectMoreDataCount, 1);
  assert.equal(result.summary.recommendationSummary.waitForTestCount, 1);
  assert.equal(result.summary.recommendationSummary.improveCount, 0);
  assert.equal(result.summary.recommendationSummary.rejectCount, 0);
  assertSafety(result.safety);
  assert.equal(after, before, 'service is read-only and does not mutate source file');
}

{
  assert.equal(scoreBand(null), 'unscored');
  assert.equal(scoreBand(35), 'weak');
  assert.equal(scoreBand(55), 'needs_improvement');
  assert.equal(scoreBand(65), 'watchlist');
  assert.equal(scoreBand(75), 'promising');
  assert.equal(scoreBand(88), 'strong_candidate');
}

console.log('strategyEvolutionService.test.js: OK');
