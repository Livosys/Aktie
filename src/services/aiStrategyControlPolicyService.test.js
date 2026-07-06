'use strict';

const assert = require('assert/strict');

const policy = require('./aiStrategyControlPolicyService');

function assertSafety(safety) {
  assert.deepEqual(safety, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
    affects_trading: false,
  });
}

{
  const route = policy.evaluateArea({ route: '/interactive-brokers' });
  assert.equal(route.allowed, false, 'interactive brokers route blocked');
  assert.equal(route.reason, 'interactive_brokers_route');

  const nested = policy.evaluateArea({ route: '/api/interactive-brokers/paper-execute' });
  assert.equal(nested.allowed, false, 'interactive brokers api route blocked');
}

{
  const file = policy.evaluateArea({ filePath: 'src/services/interactiveBrokersPreviewService.js' });
  assert.equal(file.allowed, false, 'interactive brokers service file blocked');
  assert.equal(file.reason, 'protected_ib_file');
}

{
  const orderIntent = policy.evaluateArea({ area: 'strategy_research', operation: 'submit order' });
  assert.equal(orderIntent.allowed, false, 'order intent blocked');
  assert.equal(orderIntent.reason, 'protected_trade_intent');
}

{
  const paperWrite = policy.evaluateArea({ route: '/paper-trading', operation: 'start paper trading' });
  assert.equal(paperWrite.allowed, false, 'paper trading write intent blocked');
  assert.equal(paperWrite.reason, 'paper_trading_read_only_only');

  const paperRead = policy.evaluateArea({ route: '/paper-trading', operation: 'read-only performance analysis' });
  assert.equal(paperRead.allowed, true, 'paper trading read-only analysis allowed');
}

{
  assert.equal(policy.isTradeApprovedStrategy({ strategy_id: 'x', status: 'trade_approved' }), true, 'trade approved status detected');
  assert.equal(policy.isTradeApprovedStrategy({ strategy_id: 'x', approvedForTrade: true }), true, 'trade approved flag detected');
  assert.equal(policy.isTradeApprovedStrategy({ strategy_id: 'x', status: 'paper_only', approvedForPaperTesting: true }), false, 'paper-only approval is not trade approval');
}

{
  const allowed = policy.canAiWorkOnStrategy(
    { strategy_id: 'research_only', status: 'paper_only' },
    { area: 'strategy_research', operation: 'run replay analysis' },
  );
  assert.equal(allowed.allowed, true, 'research strategy allowed');
  assert.equal(allowed.affects_trading, false, 'research strategy cannot affect trading');
  assertSafety(allowed.safety);

  const blocked = policy.canAiWorkOnStrategy(
    { strategy_id: 'live_ready', approvedForTrade: true },
    { area: 'strategy_research', operation: 'compare results' },
  );
  assert.equal(blocked.allowed, false, 'trade-approved strategy blocked');
  assert.equal(blocked.reason, 'trade_approved_strategy_protected');
}

{
  const rec = policy.buildRecommendationExplanation({
    strategy: { strategy_id: 'weak_research_strategy', status: 'paper_only' },
    context: { area: 'strategy_research', operation: 'recommend replay' },
    whatAiSaw: 'Svag win rate och litet dataunderlag.',
    whyItMatters: 'Strategin kan vara for tunn for paper-observation.',
    improvement: 'Samla replay och batch innan vidare beslut.',
    riskLevel: 'medium',
    nextStep: 'Kor read-only replayplan och jamfor med batchresultat.',
  });

  assert.equal(rec.allowed, true, 'recommendation allowed');
  assert.equal(rec.vad_ai_sag.includes('Svag win rate'), true, 'what AI saw present');
  assert.equal(rec.riskniva, 'medel', 'risk normalized');
  assert.equal(rec.paverkar_trading, 'nej', 'trading impact visible');
  assert.equal(rec.affects_trading, false, 'machine trading impact false');
  assert.equal(rec.blocked_reason, null, 'no blocked reason');
}

{
  assert.equal(policy.requiresUserApproval('commit'), true, 'commit requires approval');
  assert.equal(policy.requiresUserApproval('pm2-restart'), true, 'pm2 restart requires approval');
  assert.equal(policy.requiresUserApproval('copy_update'), false, 'small copy update does not require policy approval');

  const summary = policy.getPolicySummary();
  assert.equal(summary.ok, true, 'summary ok');
  assert.ok(summary.protected_areas.includes('/interactive-brokers'), 'summary names protected IB area');
  assertSafety(summary.safety);
}

console.log('aiStrategyControlPolicyService.test.js: OK');
