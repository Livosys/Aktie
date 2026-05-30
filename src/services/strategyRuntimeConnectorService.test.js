'use strict';

process.env.PAPER_ALLOW_EMA = process.env.PAPER_ALLOW_EMA || 'false';

const {
  getStrategyRuntimeSummary,
  getRuntimeStatusForStrategy,
  canCreatePaperTradeForSignal,
  SAFETY,
} = require('./strategyRuntimeConnectorService');

let passed = 0;
let failed = 0;

function assert(name, condition, got) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed += 1;
  } else {
    console.error(`  ❌ ${name}  →  got: ${JSON.stringify(got)}`);
    failed += 1;
  }
}

function byId(summary, id) {
  return summary.strategies.find((strategy) => strategy.id === id);
}

function assertSafety(prefix, item) {
  assert(`${prefix}: actions_allowed=false`, item.actions_allowed === false, item.actions_allowed);
  assert(`${prefix}: can_place_orders=false`, item.can_place_orders === false, item.can_place_orders);
  assert(`${prefix}: live_trading_enabled=false`, item.live_trading_enabled === false, item.live_trading_enabled);
  assert(`${prefix}: live_enabled=false`, item.live_enabled === false, item.live_enabled);
  assert(`${prefix}: paper_only=true`, item.paper_only === true, item.paper_only);
}

const previouslyNoEntry = [
  'vwap_momentum_long',
  'vwap_rejection_short',
  'opening_range_breakout',
  'opening_range_fakeout',
  'ema_pullback_continuation',
  'ema_breakdown',
  'volume_spike_momentum',
  'narrow_state_fakeout_reversal',
  'volume_spike_continuation',
  'pullback_to_vwap_long',
  'trend_exhaustion_short',
  'index_supported_momentum_long',
  'opening_range_retest_long',
  'mean_reversion_vwap',
  'support_bounce',
  'resistance_rejection',
  'index_confirmed_long',
  'index_confirmed_short',
  'low_volatility_breakout',
  'high_volatility_reversal',
  'gap_continuation',
  'gap_fade',
  'news_volatility_watch',
];

const expectedPartial = new Set([
  'opening_range_breakout',
  'opening_range_fakeout',
  'index_supported_momentum_long',
  'opening_range_retest_long',
  'index_confirmed_long',
  'index_confirmed_short',
  'narrow_breakout',
  'narrow_state_expansion_long',
  'narrow_state_fakeout_reversal',
  'crypto_momentum_scalper',
  'news_volatility_watch',
]);

const expectedActive = new Set([
  'vwap_momentum_long',
  'vwap_rejection_short',
  'ema_pullback_continuation',
  'ema_breakdown',
  'volume_spike_momentum',
  'volume_spike_continuation',
  'pullback_to_vwap_long',
  'trend_exhaustion_short',
  'mean_reversion_vwap',
  'trend_continuation',
  'support_bounce',
  'resistance_rejection',
  'low_volatility_breakout',
  'high_volatility_reversal',
  'gap_continuation',
  'gap_fade',
]);

// ── Test 1: previously no_entry_rule strategies are now active or partial ──
{
  const summary = getStrategyRuntimeSummary();
  for (const id of previouslyNoEntry) {
    const row = byId(summary, id);
    assert(`T1: ${id} exists`, !!row, row);
    if (!row) continue;
    assert(`T1: ${id} no longer no_entry_rule`, row.runtime_status !== 'no_entry_rule', row.runtime_status);
    assert(`T1: ${id} entry_rule_implemented=true`, row.entry_rule_implemented === true, row.entry_rule_implemented);
    assertSafety(`T1: ${id}`, row);

    if (expectedPartial.has(id)) {
      assert(`T1: ${id} runtime_status=partial`, row.runtime_status === 'partial', row.runtime_status);
      assert(`T1: ${id} can_create_paper_trade=false`, row.can_create_paper_trade === false, row.can_create_paper_trade);
      assert(`T1: ${id} has missing_data`, Array.isArray(row.missing_data) && row.missing_data.length > 0, row.missing_data);
      assert(`T1: ${id} has skip_reason`, typeof row.skip_reason_sv === 'string' && row.skip_reason_sv.length > 0, row.skip_reason_sv);
    } else {
      assert(`T1: ${id} runtime_status=active`, row.runtime_status === 'active', row.runtime_status);
      assert(`T1: ${id} can_create_paper_trade=true`, row.can_create_paper_trade === true, row.can_create_paper_trade);
      assert(`T1: ${id} has required_data`, Array.isArray(row.required_data) && row.required_data.length > 0, row.required_data);
    }
  }
}

// ── Test 2: runtime-ready strategies remain active and runnable ──
{
  const summary = getStrategyRuntimeSummary();
  for (const id of ['vwap_volume_breakout_long', 'vwap_failed_breakout_short']) {
    const row = byId(summary, id);
    assert(`T2: ${id} exists`, !!row, row);
    if (!row) continue;
    assert(`T2: ${id} runtime_status=active`, row.runtime_status === 'active', row.runtime_status);
    assert(`T2: ${id} can_create_paper_trade=true`, row.can_create_paper_trade === true, row.can_create_paper_trade);
    assert(`T2: ${id} entry_rule_implemented=true`, row.entry_rule_implemented === true, row.entry_rule_implemented);
    assert(`T2: ${id} runtime_label=Kan köra paper trades`, row.runtime_label === 'Kan köra paper trades', row.runtime_label);
    assertSafety(`T2: ${id}`, row);
  }
}

// ── Test 3: partial strategies remain partial and blocked for paper trades ──
{
  const summary = getStrategyRuntimeSummary();
  for (const id of ['narrow_breakout', 'narrow_state_expansion_long', 'crypto_momentum_scalper', 'news_volatility_watch']) {
    const row = byId(summary, id);
    assert(`T3: ${id} exists`, !!row, row);
    if (!row) continue;
    assert(`T3: ${id} runtime_status=partial`, row.runtime_status === 'partial', row.runtime_status);
    assert(`T3: ${id} can_create_paper_trade=false`, row.can_create_paper_trade === false, row.can_create_paper_trade);
    assert(`T3: ${id} entry_rule_implemented=true`, row.entry_rule_implemented === true, row.entry_rule_implemented);
    assert(`T3: ${id} runtime_label=Delvis kopplad`, row.runtime_label === 'Delvis kopplad', row.runtime_label);
    assertSafety(`T3: ${id}`, row);
  }

  const openingRange = getRuntimeStatusForStrategy('opening_range_breakout');
  assert('T3: opening_range_breakout missing opening range data', Array.isArray(openingRange.missing_data) && openingRange.missing_data.includes('opening_range_data'), openingRange.missing_data);
  assert('T3: opening_range_breakout skip reason mentions opening range', String(openingRange.skip_reason_sv || '').toLowerCase().includes('opening_range') || String(openingRange.skip_reason_sv || '').toLowerCase().includes('opening range'), openingRange.skip_reason_sv);

  const newsWatch = getRuntimeStatusForStrategy('news_volatility_watch');
  assert('T3: news_volatility_watch missing news_feed', Array.isArray(newsWatch.missing_data) && newsWatch.missing_data.includes('news_feed'), newsWatch.missing_data);
}

// ── Test 4: summary counters reflect selected vs runnable separation ──
{
  const summary = getStrategyRuntimeSummary();
  assert('T4: total_catalog_strategies=30', summary.summary.total_catalog_strategies === 30, summary.summary.total_catalog_strategies);
  assert('T4: runtime_no_entry_rule=0', summary.summary.runtime_no_entry_rule === 0, summary.summary.runtime_no_entry_rule);
  assert('T4: runtime_active=17', summary.summary.runtime_active === 17, summary.summary.runtime_active);
  assert('T4: runtime_partial=11', summary.summary.runtime_partial === 11, summary.summary.runtime_partial);
  assert('T4: runtime_disabled=2', summary.summary.runtime_disabled === 2, summary.summary.runtime_disabled);
  assert('T4: enabled_by_user=28', summary.summary.enabled_by_user === 28, summary.summary.enabled_by_user);
  assert('T4: can_create_paper_trade_count=17', summary.summary.can_create_paper_trade_count === 17, summary.summary.can_create_paper_trade_count);
  assert('T4: runtime_connected=30', summary.summary.runtime_connected === 30, summary.summary.runtime_connected);
  assertSafety('T4: summary', SAFETY);
}

// ── Test 5: strategy inference and paper-trade gating agree with runtime state ──
{
  const readyDecision = canCreatePaperTradeForSignal({
    strategy_id: 'vwap_momentum_long',
    symbol: 'AAPL',
    raw_strategy: 'VWAP_RECLAIM_UP',
  });
  assert('T5: vwap_momentum_long allowed', readyDecision.allowed === true, readyDecision);
  assert('T5: vwap_momentum_long runtime_status=active', readyDecision.strategy?.runtime_status === 'active', readyDecision.strategy?.runtime_status);
  assert('T5: vwap_momentum_long strategy_id preserved', readyDecision.strategy?.strategy_id === 'vwap_momentum_long', readyDecision.strategy?.strategy_id);
  assertSafety('T5: readyDecision', readyDecision);

  const cryptoReclaimDecision = canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    raw_strategy: 'VWAP_RECLAIM_UP',
  });
  assert('T5: crypto VWAP_RECLAIM_UP allowed', cryptoReclaimDecision.allowed === true, cryptoReclaimDecision);
  assert('T5: crypto VWAP_RECLAIM_UP runtime_status=active', cryptoReclaimDecision.strategy?.runtime_status === 'active', cryptoReclaimDecision.strategy?.runtime_status);
  assert('T5: crypto VWAP_RECLAIM_UP strategy_id=vwap_volume_breakout_long', cryptoReclaimDecision.strategy?.strategy_id === 'vwap_volume_breakout_long', cryptoReclaimDecision.strategy?.strategy_id);
  assert('T5: crypto VWAP_RECLAIM_UP can_create_paper_trade=true', cryptoReclaimDecision.strategy?.can_create_paper_trade === true, cryptoReclaimDecision.strategy?.can_create_paper_trade);
  assertSafety('T5: cryptoReclaimDecision', cryptoReclaimDecision);

  const cryptoRejectDecision = canCreatePaperTradeForSignal({
    symbol: 'ADAUSDT',
    raw_strategy: 'VWAP_REJECTION_DOWN',
  });
  assert('T5: crypto VWAP_REJECTION_DOWN allowed', cryptoRejectDecision.allowed === true, cryptoRejectDecision);
  assert('T5: crypto VWAP_REJECTION_DOWN runtime_status=active', cryptoRejectDecision.strategy?.runtime_status === 'active', cryptoRejectDecision.strategy?.runtime_status);
  assert('T5: crypto VWAP_REJECTION_DOWN strategy_id=vwap_failed_breakout_short', cryptoRejectDecision.strategy?.strategy_id === 'vwap_failed_breakout_short', cryptoRejectDecision.strategy?.strategy_id);
  assert('T5: crypto VWAP_REJECTION_DOWN can_create_paper_trade=true', cryptoRejectDecision.strategy?.can_create_paper_trade === true, cryptoRejectDecision.strategy?.can_create_paper_trade);
  assertSafety('T5: cryptoRejectDecision', cryptoRejectDecision);

  const cryptoMomentumDecision = canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    raw_strategy: 'CRYPTO_MOMENTUM_SCALPER',
  });
  assert('T5: generic crypto momentum blocked', cryptoMomentumDecision.allowed === false, cryptoMomentumDecision);
  assert('T5: generic crypto momentum strategy partial', cryptoMomentumDecision.strategy?.runtime_status === 'partial', cryptoMomentumDecision.strategy?.runtime_status);
  assert('T5: generic crypto momentum strategy_id=crypto_momentum_scalper', cryptoMomentumDecision.strategy?.strategy_id === 'crypto_momentum_scalper', cryptoMomentumDecision.strategy?.strategy_id);
  assert('T5: generic crypto momentum can_create_paper_trade=false', cryptoMomentumDecision.strategy?.can_create_paper_trade === false, cryptoMomentumDecision.strategy?.can_create_paper_trade);
  assertSafety('T5: cryptoMomentumDecision', cryptoMomentumDecision);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${passed + failed} total — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
