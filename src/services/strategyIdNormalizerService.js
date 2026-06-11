'use strict';

/**
 * strategyIdNormalizerService — READ-ONLY bridge from legacy strategy keys to
 * canonical strategy_id.
 *
 * Single source of truth: daytradingStrategyCatalogService (the 33 canonical
 * runtime strategy_id values). strategyRegistryService is an overlay/adapter;
 * strategyCatalogService is a legacy/preset view. This service only READS the
 * canonical catalog and a curated legacy-alias table. It never registers,
 * mutates, pauses, activates, forwards, or executes anything.
 *
 * Ambiguous legacy keys are NEVER auto-resolved to a single canonical id — they
 * are returned with ambiguous=true and the full list of candidates so a human
 * can decide. No silent guessing.
 *
 * Safety: this module is read-only and cannot affect live trading. It exposes a
 * frozen SAFETY stamp for callers that echo it.
 */

const catalog = require('./daytradingStrategyCatalogService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const CANONICAL_SOURCE = 'daytradingStrategyCatalogService';
const REGISTRY_ROLE = 'overlay';
const LEGACY_ROLE = 'preset_adapter';

// Curated mapping from legacy/preset concept keys to canonical strategy_id(s).
// A single candidate => legacy_alias. Multiple candidates => ambiguous (never
// auto-picked). Candidates are validated against the live canonical catalog at
// call time, so a stale entry can never surface a non-existent id.
const LEGACY_ALIASES = Object.freeze({
  ema_pullback: ['ema_pullback_continuation'],
  vwap_momentum: ['vwap_momentum_long'],
  vwap_rejection: ['vwap_rejection_short'],
  mean_reversion: ['mean_reversion_vwap'],
  pullback_continuation: ['ema_pullback_continuation', 'pullback_to_vwap_long'],
  volume_spike: ['volume_spike_momentum', 'volume_spike_continuation'],
  crypto_momentum: ['crypto_fast_momentum', 'crypto_momentum_scalper'],
  narrow_state: [
    'narrow_breakout',
    'narrow_breakout_v1',
    'narrow_fakeout_reversal_v1',
    'narrow_state_expansion_long',
    'narrow_state_fakeout_reversal',
    'narrow_vwap_mean_reversion_v1',
  ],
  breakout: [
    'low_volatility_breakout',
    'opening_range_breakout',
    'narrow_breakout',
    'narrow_breakout_v1',
    'vwap_volume_breakout_long',
    'vwap_failed_breakout_short',
  ],
  momentum: [
    'crypto_fast_momentum',
    'crypto_momentum_scalper',
    'index_supported_momentum_long',
    'vwap_momentum_long',
    'volume_spike_momentum',
  ],
});

// Known legacy/preset concept keys (from strategyCatalogService) that have no
// canonical equivalent — surfaced as unknown in the report so the gap is visible.
const LEGACY_KEYS_WITHOUT_CANONICAL = Object.freeze([
  'ema_trend',
  'index_stocks',
  'index_trend_mode',
  'loose_discovery',
  'opening_range_test',
  'sector_confirmation',
  'tight_scalp',
  'vwap_reclaim',
  'vwap_scalper',
]);

function sanitize(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  return s.length ? s : null;
}

function canonicalIds() {
  const list = Array.isArray(catalog.STRATEGIES) ? catalog.STRATEGIES : [];
  return list.map((row) => row && (row.id || row.strategy_id)).filter(Boolean);
}

function isCanonical(id) {
  if (!id) return false;
  try {
    return Boolean(catalog.getStrategyById(id));
  } catch (_) {
    return canonicalIds().includes(id);
  }
}

function result({ input, canonicalStrategyId, status, ambiguous, possibleCanonicalIds, reason }) {
  return {
    input,
    canonicalStrategyId: canonicalStrategyId || null,
    status,
    ambiguous: Boolean(ambiguous),
    possibleCanonicalIds: Array.isArray(possibleCanonicalIds) ? possibleCanonicalIds : [],
    reason,
  };
}

/**
 * Resolve any strategy key (canonical id or legacy alias) to its canonical form.
 * Returns a descriptor object; never throws on bad input.
 */
function normalizeStrategyId(input) {
  const key = sanitize(input);
  if (!key) {
    return result({
      input: input === undefined ? null : input,
      status: 'unknown',
      reason: 'empty_or_invalid_input',
      possibleCanonicalIds: [],
    });
  }

  // 1) Exact canonical match.
  if (isCanonical(key)) {
    return result({
      input: key,
      canonicalStrategyId: key,
      status: 'canonical',
      ambiguous: false,
      possibleCanonicalIds: [key],
      reason: 'exact_canonical_match',
    });
  }

  // 2) Curated legacy alias — validate candidates against the live catalog.
  if (Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, key)) {
    const valid = LEGACY_ALIASES[key].filter(isCanonical);
    if (valid.length === 1) {
      return result({
        input: key,
        canonicalStrategyId: valid[0],
        status: 'legacy_alias',
        ambiguous: false,
        possibleCanonicalIds: valid,
        reason: 'legacy_alias_mapped_to_canonical',
      });
    }
    if (valid.length > 1) {
      return result({
        input: key,
        canonicalStrategyId: null,
        status: 'ambiguous',
        ambiguous: true,
        possibleCanonicalIds: valid,
        reason: 'legacy_key_matches_multiple_canonical_strategies',
      });
    }
    // Mapping existed but no candidate is canonical anymore.
    return result({
      input: key,
      status: 'unknown',
      reason: 'legacy_alias_candidates_not_in_canonical_catalog',
      possibleCanonicalIds: [],
    });
  }

  // 3) Unknown.
  return result({
    input: key,
    status: 'unknown',
    reason: 'not_found_in_canonical_or_legacy_aliases',
    possibleCanonicalIds: [],
  });
}

/** Convenience: canonical id string, or null if not a unique canonical match. */
function getCanonicalStrategyId(input) {
  return normalizeStrategyId(input).canonicalStrategyId;
}

/** Same descriptor as normalizeStrategyId plus a short human-readable note. */
function explainStrategyId(input) {
  const res = normalizeStrategyId(input);
  const notes = {
    exact_canonical_match: 'Redan ett canonical strategy_id.',
    legacy_alias_mapped_to_canonical: `Legacy-nyckel mappad till canonical ${res.canonicalStrategyId}.`,
    legacy_key_matches_multiple_canonical_strategies:
      'Legacy-nyckel matchar flera canonical strategier — välj manuellt, väljs aldrig automatiskt.',
    legacy_alias_candidates_not_in_canonical_catalog:
      'Legacy-alias finns men inga kandidater finns kvar i canonical-katalogen.',
    not_found_in_canonical_or_legacy_aliases: 'Okänd nyckel — varken canonical eller känt legacy-alias.',
    empty_or_invalid_input: 'Tom eller ogiltig indata.',
  };
  return { ...res, note: notes[res.reason] || null };
}

/** All curated legacy mappings, each normalized through the same logic. */
function listLegacyMappings() {
  return Object.keys(LEGACY_ALIASES)
    .sort()
    .map((legacyKey) => {
      const res = normalizeStrategyId(legacyKey);
      return {
        legacyKey,
        status: res.status,
        ambiguous: res.ambiguous,
        canonicalStrategyId: res.canonicalStrategyId,
        possibleCanonicalIds: res.possibleCanonicalIds,
        reason: res.reason,
      };
    });
}

/**
 * Read-only report: canonical inventory + legacy mappings + unmapped legacy keys.
 * Pure data; changes nothing.
 */
function buildStrategyNormalizationReport() {
  const canonical = canonicalIds();
  const canonicalMappings = canonical.map((id) => normalizeStrategyId(id));
  const legacyMappings = Object.keys(LEGACY_ALIASES).map((key) => normalizeStrategyId(key));
  const unknownMappings = LEGACY_KEYS_WITHOUT_CANONICAL.map((key) => normalizeStrategyId(key));

  const mappings = [...canonicalMappings, ...legacyMappings, ...unknownMappings];

  const summary = {
    canonicalCount: canonicalMappings.length,
    legacyAliasCount: legacyMappings.filter((m) => m.status === 'legacy_alias').length,
    ambiguousCount: legacyMappings.filter((m) => m.status === 'ambiguous').length,
    unknownCount: mappings.filter((m) => m.status === 'unknown').length,
  };

  return {
    canonicalSource: CANONICAL_SOURCE,
    registryRole: REGISTRY_ROLE,
    legacyRole: LEGACY_ROLE,
    summary,
    mappings,
    safety: {
      actions_allowed: SAFETY.actions_allowed,
      can_place_orders: SAFETY.can_place_orders,
      live_trading_enabled: SAFETY.live_trading_enabled,
      broker_enabled: SAFETY.broker_enabled,
    },
  };
}

module.exports = {
  SAFETY,
  CANONICAL_SOURCE,
  REGISTRY_ROLE,
  LEGACY_ROLE,
  LEGACY_ALIASES,
  normalizeStrategyId,
  getCanonicalStrategyId,
  explainStrategyId,
  listLegacyMappings,
  buildStrategyNormalizationReport,
};
