'use strict';

process.env.PAPER_ALLOW_EMA = process.env.PAPER_ALLOW_EMA || 'false';

const { getStrategyRuntimeSummary, getRuntimeStatusForStrategy, canCreatePaperTradeForSignal, SAFETY } = require('./strategyRuntimeConnectorService');

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

// ── Test 1: strategies enabled_by_user=true but missing runtime entry are no_entry_rule ──
{
  const summary = getStrategyRuntimeSummary();
  const missing = [
    'trend_continuation',
    'vwap_momentum_long',
  ].map((id) => byId(summary, id));

  for (const row of missing) {
    assert(`T1: ${row?.id} exists`, !!row, row);
    if (!row) continue;
    assert(`T1: ${row.id} enabled_by_user=true`, row.enabled_by_user === true, row.enabled_by_user);
    assert(`T1: ${row.id} runtime_status=no_entry_rule`, row.runtime_status === 'no_entry_rule', row.runtime_status);
    assert(`T1: ${row.id} entry_rule_implemented=false`, row.entry_rule_implemented === false, row.entry_rule_implemented);
    assert(`T1: ${row.id} can_create_paper_trade=false`, row.can_create_paper_trade === false, row.can_create_paper_trade);
    assertSafety(`T1: ${row.id}`, row);
  }
}

// ── Test 2: runtime-ready strategies are actually runnable ──
{
  const summary = getStrategyRuntimeSummary();
  for (const id of ['vwap_volume_breakout_long', 'vwap_failed_breakout_short']) {
    const row = byId(summary, id);
    assert(`T2: ${id} exists`, !!row, row);
    if (!row) continue;
    assert(`T2: ${id} runtime_status=active`, row.runtime_status === 'active', row.runtime_status);
    assert(`T2: ${id} can_create_paper_trade=true`, row.can_create_paper_trade === true, row.can_create_paper_trade);
    assert(`T2: ${id} entry_rule_implemented=true`, row.entry_rule_implemented === true, row.entry_rule_implemented);
    assert(`T2: ${id} enabled_by_user=true`, row.enabled_by_user === true, row.enabled_by_user);
    assertSafety(`T2: ${id}`, row);
  }
}

// ── Test 3: partial strategies remain partial and are not counted as fully runnable ──
{
  const summary = getStrategyRuntimeSummary();
  for (const id of ['narrow_breakout', 'narrow_state_expansion_long', 'crypto_momentum_scalper']) {
    const row = byId(summary, id);
    assert(`T3: ${id} exists`, !!row, row);
    if (!row) continue;
    assert(`T3: ${id} runtime_status=partial`, row.runtime_status === 'partial', row.runtime_status);
    assert(`T3: ${id} entry_rule_implemented=true`, row.entry_rule_implemented === true, row.entry_rule_implemented);
    assert(`T3: ${id} can_create_paper_trade=partial`, row.can_create_paper_trade === 'partial', row.can_create_paper_trade);
    assertSafety(`T3: ${id}`, row);
  }
}

// ── Test 4: summary counters reflect selected vs runnable separation ──
{
  const summary = getStrategyRuntimeSummary();
  assert('T4: runtime_no_entry_rule=24', summary.summary.runtime_no_entry_rule === 24, summary.summary.runtime_no_entry_rule);
  assert('T4: enabled_by_user=29', summary.summary.enabled_by_user === 29, summary.summary.enabled_by_user);
  assert('T4: can_create_paper_trade_count=2', summary.summary.can_create_paper_trade_count === 2, summary.summary.can_create_paper_trade_count);
  assert('T4: runtime_active=2', summary.summary.runtime_active === 2, summary.summary.runtime_active);
  assert('T4: runtime_partial=3', summary.summary.runtime_partial === 3, summary.summary.runtime_partial);
  assert('T4: runtime_disabled=1', summary.summary.runtime_disabled === 1, summary.summary.runtime_disabled);
  assertSafety('T4: summary', SAFETY);
}

// ── Test 5: strategy inference and paper-trade gating agree on runtime-only behavior ──
{
  const noEntryRuntime = getRuntimeStatusForStrategy('trend_continuation');
  assert('T5: trend_continuation runtime_status=no_entry_rule', noEntryRuntime.runtime_status === 'no_entry_rule', noEntryRuntime.runtime_status);
  assert('T5: trend_continuation can_create_paper_trade=false', noEntryRuntime.can_create_paper_trade === false, noEntryRuntime.can_create_paper_trade);
  assertSafety('T5: noEntryRuntime', noEntryRuntime);

  const readyDecision = canCreatePaperTradeForSignal({ raw_strategy: 'VWAP_RECLAIM_UP', symbol: 'AAPL', marketGroup: 'stocks' });
  assert('T5: VWAP_RECLAIM_UP allowed', readyDecision.allowed === true, readyDecision);
  assert('T5: VWAP_RECLAIM_UP strategy active', readyDecision.strategy?.runtime_status === 'active', readyDecision.strategy?.runtime_status);
  assertSafety('T5: readyDecision', readyDecision);

  const partialDecision = canCreatePaperTradeForSignal({ raw_strategy: 'VWAP_RECLAIM_UP', symbol: 'BTCUSDT', marketGroup: 'crypto' });
  assert('T5: crypto VWAP partial allowed', partialDecision.allowed === true, partialDecision);
  assert('T5: crypto VWAP runtime_status=partial', partialDecision.strategy?.runtime_status === 'partial', partialDecision.strategy?.runtime_status);
  assert('T5: crypto VWAP can_create_paper_trade=partial', partialDecision.strategy?.can_create_paper_trade === 'partial', partialDecision.strategy?.can_create_paper_trade);
  assertSafety('T5: partialDecision', partialDecision);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${passed + failed} total — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
