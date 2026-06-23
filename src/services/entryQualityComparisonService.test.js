'use strict';

const assert = require('assert');
const svc = require('./entryQualityComparisonService');

// ── deriveEntrySignals ─────────────────────────────────────────────────────
(() => {
  const s = svc.deriveEntrySignals({
    symbol: 'aapl',
    statusAtEntry: 'caution',
    signalSubtype: 'REGULAR_PULLBACK',
    extensionLevel: 'mild',
    entryReasonSv: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
    result: 'LOSS',
    pnlPct: -0.2,
  });
  assert.equal(s.isCaution, true, 'caution detected');
  assert.equal(s.isRegularPullback, true, 'regular pullback detected from subtype');
  assert.equal(s.isExtended, true, 'extended detected from extensionLevel/text');
  assert.equal(s.needs2mConfirmation, true, 'missing 2m confirmation detected from text');
  assert.equal(s.symbol, 'AAPL', 'symbol upper-cased');
  assert.equal(s.isLoss, true);
})();

(() => {
  const s = svc.deriveEntrySignals({
    statusAtEntry: 'watch',
    signalSubtype: 'NARROW_BULL_ENTRY',
    extensionLevel: 'none',
    entryReasonSv: 'Stark volym',
    result: 'WIN',
  });
  assert.equal(s.isCaution, false);
  assert.equal(s.isRegularPullback, false);
  assert.equal(s.isExtended, false);
  assert.equal(s.needs2mConfirmation, false);
  assert.equal(s.has2mConfirmation, true);
  assert.equal(s.isWin, true);
})();

// reads from .raw when given a normalized trade wrapper
(() => {
  const s = svc.deriveEntrySignals({ raw: { statusAtEntry: 'caution', signalFamily: 'REGULAR_PULLBACK', result: 'WIN' } });
  assert.equal(s.isCaution, true);
  assert.equal(s.isRegularPullback, true);
})();

// ── evaluateEntryQuality (preview) ─────────────────────────────────────────
(() => {
  const p = svc.evaluateEntryQuality({
    statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK',
    entryReasonSv: 'Bevaka rekyl eller ny 2m-bekräftelse.', result: 'LOSS', extensionLevel: 'mild',
  });
  assert.equal(p.entryQualityDecision, 'require_2m_confirmation');
  assert.equal(p.wouldSkipByEntryFilter, true);
  assert.equal(p.wouldRequire2mConfirmation, true);
  assert.equal(p.reasonSv, '2m-confirmation saknades');
  assert.equal(p.read_only, true);
  assert.equal(p.can_place_orders, false);
})();

(() => {
  // caution + pullback but confirmation present (no "ny 2m" hint) → skip, not require-2m
  const p = svc.evaluateEntryQuality({
    statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK',
    entryReasonSv: 'Setup bekräftad.', result: 'LOSS', extensionLevel: 'none',
  });
  assert.equal(p.entryQualityDecision, 'skip');
  assert.equal(p.reasonSv, 'Entry var caution + REGULAR_PULLBACK');
})();

(() => {
  const p = svc.evaluateEntryQuality({ statusAtEntry: 'watch', signalSubtype: 'NARROW_BULL_ENTRY', result: 'WIN' });
  assert.equal(p.entryQualityDecision, 'allow');
  assert.equal(p.wouldSkipByEntryFilter, false);
})();

// ── buildEntryQualityComparison (synthetic dataset) ────────────────────────
(() => {
  const trades = [];
  // 10 caution + regular pullback losses (weak flow the filters should cut)
  for (let i = 0; i < 10; i += 1) {
    trades.push({ symbol: 'BTCUSDT', strategyName: 'Trend Continuation', statusAtEntry: 'caution', signalSubtype: 'REGULAR_PULLBACK', extensionLevel: 'mild', entryReasonSv: 'Bevaka rekyl eller ny 2m-bekräftelse.', result: 'LOSS', pnlPct: -0.3, maxFavorablePct: 0.02, maxAdversePct: -0.3, duration_seconds: 300 });
  }
  // 10 watch / narrow wins (clean flow nothing should cut)
  for (let i = 0; i < 10; i += 1) {
    trades.push({ symbol: 'AAPL', strategyName: 'Narrow Breakout', statusAtEntry: 'watch', signalSubtype: 'NARROW_BULL_ENTRY', extensionLevel: 'none', entryReasonSv: 'Stark volym', result: 'WIN', pnlPct: 0.4, maxFavorablePct: 0.5, maxAdversePct: -0.05, duration_seconds: 600 });
  }
  // 1 open trade ignored (not WIN/LOSS/TIMEOUT)
  trades.push({ symbol: 'NVDA', result: 'OPEN' });

  const rep = svc.buildEntryQualityComparison({ trades });
  assert.equal(rep.ok, true);
  assert.equal(rep.tradesAnalyzed, 20, 'only closed trades counted');
  assert.equal(rep.read_only, true);
  assert.equal(rep.can_place_orders, false);
  assert.equal(rep.live_trading_enabled, false);

  const baseline = rep.profiles.find((p) => p.profile === 'baseline');
  assert.equal(baseline.kept.trades, 20);
  assert.equal(baseline.kept.winRate, 50);

  const skip = rep.profiles.find((p) => p.profile === 'skip_caution_regular_pullback');
  assert.equal(skip.kept.trades, 10, 'skip removes the 10 caution pullbacks');
  assert.equal(skip.kept.winRate, 100, 'remaining are all wins');
  assert.equal(skip.filtered.count, 10);
  assert.equal(skip.filtered.wins, 0, 'no winning trades filtered in this dataset');

  // best should be a real entry filter that beats baseline here
  assert.ok(rep.best, 'a best profile is chosen');
  assert.equal(rep.beatsBaseline, true);
  assert.ok(['skip', 'require_2m_confirmation', 'confidence_penalty'].includes(rep.bestVariantClass));
})();

// empty dataset is safe
(() => {
  const rep = svc.buildEntryQualityComparison({ trades: [] });
  assert.equal(rep.ok, true);
  assert.equal(rep.tradesAnalyzed, 0);
  assert.equal(rep.best, null);
  assert.equal(rep.beatsBaseline, false);
})();

// feature flag default OFF
assert.equal(svc.isGateEnabled(), false, 'gate disabled by default');

console.log('# entryQualityComparisonService tests passed.');
