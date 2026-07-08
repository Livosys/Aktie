'use strict';

// Tester för Strategy Trade Control: 30 min cooldown per strategyId +
// strategy family-exklusivitet. Ren regel-logik, inga trades skapas,
// paper-only — ingen live/broker-väg berörs.

const assert = require('assert/strict');

const control = require('./strategyTradeControlService');

const NOW = '2026-07-08T12:00:00.000Z';

function minutesAgo(minutes, now = NOW) {
  return new Date(new Date(now).getTime() - minutes * 60_000).toISOString();
}

// ── Default-config ────────────────────────────────────────────────────────────
{
  const cfg = control.getStrategyTradeControlConfig();
  assert.equal(cfg.cooldownMinutes, 30);
  assert.equal(cfg.familyCooldownMinutes, 30);
  assert.equal(cfg.familyExclusiveEnabled, true);
}

// ── Strategy cooldown per strategyId ─────────────────────────────────────────
{
  // Samma strategyId efter 10 min → blockeras.
  const blocked = control.evaluateStrategyCooldown({
    strategyId: 'vwap_momentum_long',
    lastTradeAt: minutesAgo(10),
    now: NOW,
  });
  assert.equal(blocked.cooldownActive, true);
  assert.equal(blocked.blockReason, 'strategy_cooldown_active');
  assert.equal(blocked.strategyCooldownDecision, 'blocked');
  assert.equal(blocked.cooldownMinutesRemaining, 20);
  assert.equal(blocked.lastTradeAt, minutesAgo(10));
  assert.equal(blocked.nextAllowedAt, minutesAgo(-20)); // 20 min framåt

  // Ny trade efter 31 min → tillåts.
  const allowed = control.evaluateStrategyCooldown({
    strategyId: 'vwap_momentum_long',
    lastTradeAt: minutesAgo(31),
    now: NOW,
  });
  assert.equal(allowed.cooldownActive, false);
  assert.equal(allowed.blockReason, null);
  assert.equal(allowed.strategyCooldownDecision, 'allowed');
  assert.equal(allowed.cooldownMinutesRemaining, 0);

  // Ingen tidigare trade → tillåts.
  const fresh = control.evaluateStrategyCooldown({ strategyId: 'ny_strategi', lastTradeAt: null, now: NOW });
  assert.equal(fresh.blockReason, null);
}

// ── resolveStrategyFamily ────────────────────────────────────────────────────
{
  // Katalog-family via strategyId.
  assert.equal(control.resolveStrategyFamily({ strategyId: 'narrow_breakout' }), 'narrow_state');
  assert.equal(control.resolveStrategyFamily({ strategyId: 'vwap_momentum_long' }), 'vwap_family');
  // Explicit strategyFamily vinner.
  assert.equal(control.resolveStrategyFamily({ strategyId: 'narrow_breakout', strategyFamily: 'Custom_Family' }), 'custom_family');
  // Okänd strategi → fallback till rå signalFamily.
  assert.equal(control.resolveStrategyFamily({ strategyId: 'finns_inte_xyz', signalFamily: 'VWAP_RECLAIM_REJECTION' }), 'vwap_reclaim_rejection');
  // Ingen familj alls → null (family gate ej tillämplig).
  assert.equal(control.resolveStrategyFamily({}), null);
}

// ── rankFamilyCandidates: två kandidater i samma familj → bara bästa rank 1 ──
{
  const a = { strategyId: 'vwap_momentum_long', strategyFamily: 'vwap_family', confidence: 0.9 };
  const b = { strategyId: 'vwap_rejection_short', strategyFamily: 'vwap_family', confidence: 0.7 };
  const c = { strategyId: 'ema_breakdown', strategyFamily: 'ema_trend_family', confidence: 0.5 };
  const ranks = control.rankFamilyCandidates([b, a, c]);
  assert.equal(ranks.get(a).familyRank, 1);
  assert.equal(ranks.get(a).isBestInFamily, true);
  assert.equal(ranks.get(b).familyRank, 2);
  assert.equal(ranks.get(b).isBestInFamily, false);
  // Annan familj påverkas inte: egen rank 1.
  assert.equal(ranks.get(c).familyRank, 1);
  assert.equal(ranks.get(c).isBestInFamily, true);
}

// ── evaluateFamilyGate ───────────────────────────────────────────────────────
{
  const cfg = { cooldownMinutes: 30, familyCooldownMinutes: 30, familyExclusiveEnabled: true };

  // Öppen trade i samma familj blockerar.
  const posOpen = control.evaluateFamilyGate({
    strategyFamily: 'vwap_family',
    familyRank: 1,
    familyHasOpenPosition: true,
    now: NOW,
    config: cfg,
  });
  assert.equal(posOpen.familyGateDecision, 'blocked');
  assert.equal(posOpen.familyBlockReason, 'strategy_family_position_open');

  // Family cooldown blockerar.
  const famCooldown = control.evaluateFamilyGate({
    strategyFamily: 'vwap_family',
    familyRank: 1,
    familyHasOpenPosition: false,
    familyLastTradeAt: minutesAgo(10),
    now: NOW,
    config: cfg,
  });
  assert.equal(famCooldown.familyGateDecision, 'blocked');
  assert.equal(famCooldown.familyBlockReason, 'strategy_family_cooldown_active');
  assert.equal(famCooldown.familyCooldownMinutesRemaining, 20);
  assert.equal(famCooldown.familyNextAllowedAt, minutesAgo(-20));

  // Inte bästa kandidaten → blockeras.
  const notBest = control.evaluateFamilyGate({
    strategyFamily: 'vwap_family',
    familyRank: 2,
    familyHasOpenPosition: false,
    familyLastTradeAt: null,
    now: NOW,
    config: cfg,
  });
  assert.equal(notBest.familyGateDecision, 'blocked');
  assert.equal(notBest.familyBlockReason, 'strategy_family_not_best_candidate');

  // Bästa kandidaten utan öppna trades/cooldown → tillåts.
  const ok = control.evaluateFamilyGate({
    strategyFamily: 'vwap_family',
    familyRank: 1,
    familyHasOpenPosition: false,
    familyLastTradeAt: minutesAgo(31),
    now: NOW,
    config: cfg,
  });
  assert.equal(ok.familyGateDecision, 'allowed');
  assert.equal(ok.familyBlockReason, null);

  // Ingen familj → gaten är inte tillämplig.
  const noFamily = control.evaluateFamilyGate({ strategyFamily: null, now: NOW, config: cfg });
  assert.equal(noFamily.familyGateDecision, 'not_applicable');
  assert.equal(noFamily.familyBlockReason, null);

  // Exklusivitet avstängd → gaten släpper igenom.
  const disabled = control.evaluateFamilyGate({
    strategyFamily: 'vwap_family',
    familyRank: 2,
    familyHasOpenPosition: true,
    now: NOW,
    config: { ...cfg, familyExclusiveEnabled: false },
  });
  assert.equal(disabled.familyGateDecision, 'not_applicable');
  assert.equal(disabled.familyBlockReason, null);
}

// ── evaluateStrategyTradeControl: samlad bedömning + metadata ────────────────
{
  // Cooldown vinner över family gate i blockReason.
  const both = control.evaluateStrategyTradeControl({
    strategyId: 'vwap_momentum_long',
    lastTradeAt: minutesAgo(5),
    familyHasOpenPosition: true,
    now: NOW,
  });
  assert.equal(both.allowed, false);
  assert.equal(both.blockReason, 'strategy_cooldown_active');
  assert.equal(both.strategyFamily, 'vwap_family');
  assert.equal(both.familyBlockReason, 'strategy_family_position_open');
  assert.equal(both.nextAllowedAt, minutesAgo(-25));
  assert.equal(both.mode, 'paper_only');
  assert.equal(both.live_trading_enabled, false);
  assert.equal(both.broker_enabled, false);
  assert.equal(both.actions_allowed, false);
  assert.equal(both.can_place_orders, false);

  // Family cooldown ger nextAllowedAt när strategy cooldown inte är aktiv.
  const famOnly = control.evaluateStrategyTradeControl({
    strategyId: 'vwap_rejection_short',
    lastTradeAt: null,
    familyLastTradeAt: minutesAgo(12),
    now: NOW,
  });
  assert.equal(famOnly.blockReason, 'strategy_family_cooldown_active');
  assert.equal(famOnly.strategyCooldownDecision, 'allowed');
  assert.equal(famOnly.nextAllowedAt, minutesAgo(-18));

  // Helt fri strategi → tillåten med komplett metadata.
  const free = control.evaluateStrategyTradeControl({
    strategyId: 'gap_fade',
    familyRank: 1,
    now: NOW,
  });
  assert.equal(free.allowed, true);
  assert.equal(free.blockReason, null);
  assert.equal(free.strategyFamily, 'gap_family');
  assert.equal(free.familyGateDecision, 'allowed');
  assert.equal(free.strategyCooldownDecision, 'allowed');
  assert.equal(free.familyRank, 1);
  assert.equal(free.nextAllowedAt, null);
}

console.log('strategyTradeControlService.test.js passed');
