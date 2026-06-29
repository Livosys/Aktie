'use strict';

/**
 * IB Paper Preview — Asset Activation Toggles.
 *
 * Controls ONLY which asset classes are allowed to appear in the IB Paper
 * *preview* / candidate allowlist. It is a UI-driven preference and nothing else.
 *
 * Hard guarantees:
 *   - Toggling an asset NEVER enables live trading, NEVER enables the broker,
 *     NEVER allows an order, and NEVER changes broker_enabled / can_place_orders
 *     / actions_allowed / live_trading_enabled. Those are not represented here and
 *     cannot be set from this module.
 *   - Crypto and QQQ/ETF are preview-only forever in this phase: even when their
 *     toggle is ON, the rest of the stack still blocks them from any submit path
 *     (submit is independently hard-gated by IB_PAPER_SUBMIT_ROUTES_ENABLED).
 *   - State is a tiny local JSON file. No broker connection, no order, no env
 *     mutation.
 */

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STATE_FILE = path.resolve(__dirname, '../../data/ib-paper-trading/preview-asset-toggles.json');

// The only asset keys the UI can toggle. Anything else is rejected.
const ASSET_KEYS = ['stocks', 'etfQqq', 'crypto'];

const DEFAULT_TOGGLES = Object.freeze({
  stocks: true,    // equities may default ON
  etfQqq: false,   // QQQ/ETF default OFF, preview-only when enabled
  crypto: false,   // crypto default OFF, preview-only when enabled
});

// Per-asset metadata: whether it can ever reach a submit path (always false for
// QQQ/ETF and crypto in this phase) plus the Swedish safety warning shown in UI.
const ASSET_META = Object.freeze({
  stocks: {
    label: 'Aktier',
    previewOnly: false,
    submitEverAllowedThisPhase: false,
    warningSv: 'Denna knapp aktiverar endast IB Paper-preview för denna tillgångstyp. Den aktiverar inte live trading och skickar inga order.',
  },
  etfQqq: {
    label: 'QQQ / ETF',
    previewOnly: true,
    submitEverAllowedThisPhase: false,
    warningSv: 'QQQ/ETF är endast tillåtet i preview-läge. Denna knapp aktiverar inte live trading och skickar inga order.',
  },
  crypto: {
    label: 'Krypto',
    previewOnly: true,
    submitEverAllowedThisPhase: false,
    warningSv: 'Krypto är endast tillåtet i preview-läge och får inte skickas som order i denna fas. Knappen aktiverar inte live trading.',
  },
});

function normalizeToggles(raw) {
  const out = { ...DEFAULT_TOGGLES };
  if (raw && typeof raw === 'object') {
    for (const key of ASSET_KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
  }
  return out;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      paperPreviewAssetToggles: normalizeToggles(parsed?.paperPreviewAssetToggles),
      updatedAt: parsed?.updatedAt || null,
      updatedBy: parsed?.updatedBy || null,
    };
  } catch (_) {
    return { paperPreviewAssetToggles: { ...DEFAULT_TOGGLES }, updatedAt: null, updatedBy: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function buildView(state) {
  const toggles = state.paperPreviewAssetToggles;
  const assets = ASSET_KEYS.map((key) => ({
    key,
    label: ASSET_META[key].label,
    enabled: toggles[key] === true,
    previewOnly: ASSET_META[key].previewOnly,
    submitEverAllowedThisPhase: false, // hard invariant for every asset this phase
    warningSv: ASSET_META[key].warningSv,
  }));
  return {
    ok: true,
    mode: 'ib_paper_preview_asset_toggles',
    readOnly: false, // this endpoint can update the preview allowlist (only)
    affectsPreviewAllowlistOnly: true,
    paperPreviewAssetToggles: { ...toggles },
    assets,
    // Echo the hard safety invariants so the UI can prove nothing dangerous moved.
    brokerUnaffected: true,
    liveTradingUnaffected: true,
    canPlaceOrdersUnaffected: true,
    actionsAllowedUnaffected: true,
    submitRoutesUnaffected: true,
    noteSv: 'Dessa knappar ändrar endast vilka tillgångar som visas i IB Paper-preview. '
      + 'De aktiverar aldrig live trading, broker eller order.',
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
    safety: { ...SAFETY },
  };
}

/** Read-only: the current asset toggles + metadata. */
function getAssetToggles() {
  return buildView(readState());
}

/**
 * Update the preview asset toggles. Accepts either:
 *   { asset: 'stocks'|'etfQqq'|'crypto', enabled: boolean }   (single)
 *   { paperPreviewAssetToggles: { stocks, etfQqq, crypto } }  (bulk)
 *
 * SAFETY: this can ONLY change the three preview-allowlist booleans. Any other
 * field in the body is ignored. It cannot change broker/live/order flags.
 */
function setAssetToggles(body = {}) {
  const current = readState();
  const next = { ...current.paperPreviewAssetToggles };
  const rejected = [];

  if (body && typeof body === 'object' && body.paperPreviewAssetToggles && typeof body.paperPreviewAssetToggles === 'object') {
    for (const [key, value] of Object.entries(body.paperPreviewAssetToggles)) {
      if (ASSET_KEYS.includes(key) && typeof value === 'boolean') next[key] = value;
      else rejected.push(key);
    }
  }

  const singleAsset = body?.asset || body?.assetClass || body?.key;
  if (singleAsset != null) {
    const key = String(singleAsset).trim();
    if (ASSET_KEYS.includes(key) && typeof body.enabled === 'boolean') next[key] = body.enabled;
    else rejected.push(key);
  }

  const state = {
    paperPreviewAssetToggles: normalizeToggles(next),
    updatedAt: new Date().toISOString(),
    updatedBy: 'ib_paper_preview_ui',
  };
  const persisted = writeState(state);

  const view = buildView(persisted ? state : current);
  return {
    ...view,
    updated: persisted,
    persisted,
    rejectedKeys: [...new Set(rejected.filter(Boolean))],
  };
}

/** Helper for other read-only services: is an asset class preview-allowed now? */
function isAssetPreviewEnabled(assetKey) {
  const toggles = readState().paperPreviewAssetToggles;
  if (assetKey === 'stocks') return toggles.stocks === true;
  if (assetKey === 'etfQqq') return toggles.etfQqq === true;
  if (assetKey === 'crypto') return toggles.crypto === true;
  return false;
}

/**
 * Map a candidate (market group / symbol) to one of the toggle asset keys, then
 * tell whether it is preview-enabled. Read-only. Submit is NEVER implied.
 */
function classifyCandidateAsset(candidate = {}) {
  const group = String(candidate.marketGroup || candidate.market_group || candidate.group || '').trim().toLowerCase();
  const symbol = String(candidate.symbol || '').trim().toUpperCase();
  let assetKey = 'stocks';
  if (group === 'crypto' || symbol.endsWith('USDT') || symbol.endsWith('USDC')) assetKey = 'crypto';
  else if (group === 'etf' || group === 'leveraged_etf' || symbol === 'QQQ') assetKey = 'etfQqq';
  return {
    assetKey,
    label: ASSET_META[assetKey].label,
    previewEnabled: isAssetPreviewEnabled(assetKey),
    previewOnly: ASSET_META[assetKey].previewOnly,
    submitEverAllowedThisPhase: false,
  };
}

module.exports = {
  SAFETY,
  STATE_FILE,
  ASSET_KEYS,
  DEFAULT_TOGGLES,
  ASSET_META,
  getAssetToggles,
  setAssetToggles,
  isAssetPreviewEnabled,
  classifyCandidateAsset,
  _internal: { readState, writeState, normalizeToggles, buildView },
};
