'use strict';

/**
 * Central research-scope for batch / replay / autopilot.
 *
 * Purpose: restrict what research (batch tests, replay, auto-batch, auto-replay,
 * strategy autopilot) is allowed to run to a small, curated universe:
 *   - S&P 500 (represented by SPY + mega-cap members)
 *   - Nasdaq 100 (represented by QQQ + mega-cap members)
 *   - Crypto majors (BTCUSDT / ETHUSDT / SOLUSDT)
 *
 * This module is intentionally PURE:
 *   - no I/O, no filesystem, no network, no API, no broker, no execution.
 *   - deterministic, unit-testable helpers only.
 *
 * It does NOT change strategy logic, risk, broker, scheduler cadence or place
 * any orders. It only decides which *symbols* research is allowed to use.
 */

// Allowed research groups (aligns with marketUniverseService group ids).
const RESEARCH_ALLOWED_GROUPS = Object.freeze(['sp500', 'nasdaq100', 'crypto']);

// Swedish/label metadata for UI badges. Kept here so UI and backend agree.
const RESEARCH_GROUP_LABELS = Object.freeze({
  sp500: 'S&P 500',
  nasdaq100: 'Nasdaq 100',
  crypto: 'Crypto',
});

// Explicit symbol -> research group map. This is the single source of truth
// for which symbols are inside the research universe. Mega-cap tech names are
// listed under nasdaq100 (all Nasdaq-listed); SPY represents S&P, QQQ Nasdaq.
const RESEARCH_SYMBOL_GROUP = Object.freeze({
  // S&P 500
  SPY: 'sp500',
  // Nasdaq 100 (index proxy + mega-cap members)
  QQQ: 'nasdaq100',
  AAPL: 'nasdaq100',
  AMD: 'nasdaq100',
  AMZN: 'nasdaq100',
  GOOGL: 'nasdaq100',
  META: 'nasdaq100',
  MSFT: 'nasdaq100',
  NVDA: 'nasdaq100',
  TSLA: 'nasdaq100',
  // Crypto majors
  BTCUSDT: 'crypto',
  ETHUSDT: 'crypto',
  SOLUSDT: 'crypto',
});

const RESEARCH_ALLOWED_SYMBOLS = Object.freeze(Object.keys(RESEARCH_SYMBOL_GROUP));

const ALLOWED_SYMBOL_SET = new Set(RESEARCH_ALLOWED_SYMBOLS);
const ALLOWED_GROUP_SET = new Set(RESEARCH_ALLOWED_GROUPS);

/**
 * Normalize a symbol into canonical research form: trimmed, upper-cased,
 * inner whitespace removed. Returns '' for null/undefined/empty.
 */
function normalizeResearchSymbol(symbol) {
  if (symbol === null || symbol === undefined) return '';
  return String(symbol).replace(/\s+/g, '').trim().toUpperCase();
}

/**
 * Return the research group id for a symbol ('sp500' | 'nasdaq100' | 'crypto'),
 * or null if the symbol is not part of the research universe.
 */
function getResearchSymbolGroup(symbol) {
  const norm = normalizeResearchSymbol(symbol);
  if (!norm) return null;
  return RESEARCH_SYMBOL_GROUP[norm] || null;
}

/**
 * True iff the symbol is inside the allowed research universe.
 */
function isResearchAllowedSymbol(symbol) {
  const norm = normalizeResearchSymbol(symbol);
  return norm !== '' && ALLOWED_SYMBOL_SET.has(norm);
}

/**
 * True iff the group id is an allowed research group.
 */
function isResearchAllowedGroup(group) {
  const value = String(group || '').trim().toLowerCase();
  return value !== '' && ALLOWED_GROUP_SET.has(value);
}

/**
 * Filter a list of symbols to the allowed research universe.
 * Preserves input order, normalizes to canonical form, and de-duplicates
 * (keeping the first occurrence). Removes blocked / unknown symbols.
 */
function filterResearchSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : (symbols === null || symbols === undefined ? [] : [symbols]);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const norm = normalizeResearchSymbol(raw);
    if (!norm || seen.has(norm)) continue;
    if (ALLOWED_SYMBOL_SET.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Split a list of symbols into { allowed, blocked } where blocked entries carry
 * a reason. Preserves order. Useful for surfacing blockedSymbols in run/start.
 */
function partitionResearchSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : (symbols === null || symbols === undefined ? [] : [symbols]);
  const seen = new Set();
  const allowed = [];
  const blocked = [];
  for (const raw of list) {
    const norm = normalizeResearchSymbol(raw);
    if (!norm) {
      blocked.push({ symbol: String(raw), normalized: '', reason: 'empty_or_invalid_symbol' });
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (ALLOWED_SYMBOL_SET.has(norm)) {
      allowed.push(norm);
    } else {
      blocked.push({
        symbol: String(raw),
        normalized: norm,
        reason: 'outside_research_scope',
        message: 'Symbolen ligger utanför research-scope (S&P, Nasdaq, Crypto).',
      });
    }
  }
  return { allowed, blocked };
}

/**
 * Return the allowed research market groups with UI labels.
 */
function getResearchMarketGroups() {
  return RESEARCH_ALLOWED_GROUPS.map((id) => ({
    id,
    label: RESEARCH_GROUP_LABELS[id] || id,
    label_sv: RESEARCH_GROUP_LABELS[id] || id,
  }));
}

module.exports = {
  RESEARCH_ALLOWED_SYMBOLS,
  RESEARCH_ALLOWED_GROUPS,
  RESEARCH_GROUP_LABELS,
  normalizeResearchSymbol,
  getResearchSymbolGroup,
  isResearchAllowedSymbol,
  isResearchAllowedGroup,
  filterResearchSymbols,
  partitionResearchSymbols,
  getResearchMarketGroups,
};
