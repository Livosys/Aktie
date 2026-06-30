'use strict';

// Interactive Brokers Paper — Phase 1 read-only / dry-run preview layer.
//
// This module is INTENTIONALLY inert. It exists only to *describe* what an
// Interactive Brokers Paper integration could look like in the future. It does
// NOT connect to any broker, does NOT submit, place, queue or simulate any
// order, and does NOT touch the internal paper trading flow in any way.
//
// It reads the already-approved strategy list from the existing read-only
// paper allowlist source (paperAllowlistService, which in turn reads
// automationApprovalService). It creates NO new approval logic and changes NO
// approval rules. If no approved strategies exist it returns an empty list —
// never an error.
//
// Safety is permanently locked: paper_only, no actions, no orders, no broker,
// no live trading. The feature flags below all default to OFF.

const net = require('net');
const { IBApi, EventName } = require('@stoqey/ib');
const automationApprovalService = require('./automationApprovalService');
const marketUniverseService = require('./marketUniverseService');
const paperAllowlistService = require('./paperAllowlistService');
const paperTradingRuntimeService = require('./paperTradingRuntimeService');
const interactiveBrokersPaperMultiStrategyConfigService = require('./interactiveBrokersPaperMultiStrategyConfigService');

// Permanent safety contract — identical to the rest of the paper-only stack.
// These values are frozen and must never become "true" in Phase 1.
const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Future phases are described here purely so the UI can show what is locked.
// NOTHING in this module can unlock them — there is no order/queue/broker code.
// Each future step requires explicit manual approval and a separate build.
const NEXT_PHASE_LOCKED = Object.freeze({
  paperOrderQueue: { locked: true, reason: 'not_implemented_phase_1' },
  brokerExecution: { locked: true, reason: 'not_implemented_phase_1' },
  liveTrading: { locked: true, reason: 'permanently_blocked_paper_only' },
  manualApprovalRequired: true,
});

const PREVIEW_LIMIT = 3;
const ALLOWED_MARKET_GROUPS = new Set(['stocks', 'mag7', 'nasdaq100']);

// Curated set of well-known, liquid US equities that may be missing from the
// shared market-universe registry (e.g. NFLX). Used ONLY as a fallback when the
// registry returns no group, so symbols that already resolve — ETFs (QQQ/SPY →
// etf/nasdaq100), crypto (*USDT → crypto) — are never touched, and arbitrary
// unknown symbols are NOT classified as equity. Equities only; no ETF/crypto.
const IB_PAPER_US_EQUITY_FALLBACK = new Set([
  'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'GOOG', 'META', 'TSLA', 'NFLX',
  'AMD', 'AVGO', 'ADBE', 'CRM', 'CSCO', 'INTC', 'QCOM', 'TXN', 'AMAT', 'MU',
  'PYPL', 'COST', 'PEP', 'SBUX', 'INTU', 'ORCL', 'IBM', 'UBER', 'ABNB', 'PLTR',
]);
const PAPER_PORT = 4002;
const DEFAULT_VERIFY_TIMEOUT_MS = 6000;
const SESSION_VERIFY_TTL_MS = 5000;

const sessionVerificationCache = new Map();

// Feature flags. All OFF by default. Reading an env var can only ever turn a
// flag ON for *preview rendering* — it can NEVER enable order submission or a
// broker connection, because no such code exists in this module.
function readFlag(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(raw);
}

function getFeatureFlags() {
  return {
    previewEnabled: readFlag('IB_PAPER_PREVIEW_ENABLED'),
    orderQueueEnabled: readFlag('IB_PAPER_ORDER_QUEUE_ENABLED'),
    executionEnabled: readFlag('IB_PAPER_EXECUTION_ENABLED'),
  };
}

// ── Read-only connection readiness ──────────────────────────────────────────
// Trading OS NEVER stores or handles the IBKR password. Login must happen
// MANUALLY in IB Gateway / TWS using the IBKR Paper account. This module may
// only READ whether the local gateway socket is reachable — it never logs in,
// never requests trading permissions, never sends or queues any order.
//
// No password/secret env var is read here. Host/port/clientId are connection
// coordinates only (not secrets); we expose host/port and a boolean for whether
// a client id is configured — never any credential.
function getConnectionConfig() {
  const host = String(process.env.IB_GATEWAY_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = String(process.env.IB_GATEWAY_PORT || '').trim();
  const clientIdRaw = String(process.env.IB_GATEWAY_CLIENT_ID || '').trim();
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : null; // null = disabled/unset
  const clientId = /^\d+$/.test(clientIdRaw) ? Number(clientIdRaw) : undefined;
  return {
    checkEnabled: readFlag('IB_CONNECTION_CHECK_ENABLED'),
    host,
    port,
    clientId,
    portConfigured: port !== null,
    clientIdConfigured: clientIdRaw !== '',
  };
}

// Harmless TCP reachability probe: opens a socket, writes NOTHING, and destroys
// it immediately. It only answers "is something listening on host:port?". It
// performs NO IBKR handshake, NO login, NO account/permission request, NO order.
function tcpReachable(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, host); } catch (_) { finish(false); }
  });
}

function parseManagedAccounts(accountsList) {
  return String(accountsList || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isPaperAccountId(accountId) {
  return /^DU/i.test(String(accountId || '').trim());
}

function buildVerificationBase(cfg) {
  const paperPortConfigured = (cfg.host === '127.0.0.1' || cfg.host === 'localhost') && Number(cfg.port) === PAPER_PORT;
  return {
    ok: true,
    dryRun: true,
    safety: { ...SAFETY },
    host: cfg.host,
    port: cfg.port,
    portConfigured: cfg.portConfigured,
    clientIdConfigured: cfg.clientIdConfigured,
    paperPortConfigured,
    connectionCheckEnabled: cfg.checkEnabled,
    gatewayReachable: false,
    status: 'disabled',
    paperMode: 'unknown',
    paperModeVerified: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    managedAccounts: [],
    managedAccountCount: 0,
    paperAccountId: null,
    sessionVerified: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    internalPaperTradingUnaffected: true,
    passwordStored: false,
    note: 'Read-only readiness. IBKR password is never stored. Log in manually in '
      + 'IB Gateway / TWS with the Paper account. The endpoint performs TCP '
      + 'reachability plus read-only nextValidId/managedAccounts verification. '
      + 'No orders are sent.',
  };
}

function buildVerificationResult(base, overrides = {}) {
  const managedAccounts = Array.isArray(overrides.managedAccounts)
    ? overrides.managedAccounts.filter(Boolean)
    : [];
  const paperAccountId = overrides.paperAccountId || managedAccounts.find(isPaperAccountId) || null;
  const ibApiVerified = overrides.ibApiVerified === true;
  const paperAccountVerified = overrides.paperAccountVerified === true;
  const sessionVerified = overrides.sessionVerified === true || (ibApiVerified && paperAccountVerified);
  const paperModeVerified = overrides.paperModeVerified === true || sessionVerified;

  return {
    ...base,
    ...overrides,
    managedAccounts,
    managedAccountCount: managedAccounts.length,
    paperAccountId,
    ibApiVerified,
    paperAccountVerified,
    sessionVerified,
    paperModeVerified,
    paperMode: paperModeVerified ? 'paper_only' : (overrides.paperMode || 'unknown'),
    status: overrides.status || (paperModeVerified ? 'verified' : base.status),
    blockedReason: overrides.blockedReason || (paperModeVerified ? 'read_only_session_verified' : base.blockedReason || 'ib_api_not_verified'),
  };
}

async function verifyPaperSession(cfg, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS);
  const cacheKey = `${cfg.host}:${cfg.port}:${cfg.clientId || 'default'}`;
  const cached = sessionVerificationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const base = buildVerificationBase(cfg);
  if (!cfg.checkEnabled) {
    return buildVerificationResult(base, {
      gatewayReachable: false,
      status: 'disabled',
      blockedReason: 'ib_connection_check_disabled',
    });
  }

  if (!cfg.portConfigured) {
    return buildVerificationResult(base, {
      gatewayReachable: false,
      status: 'not_configured',
      blockedReason: 'ib_gateway_not_configured',
    });
  }

  const reachable = await tcpReachable(cfg.host, cfg.port, Math.min(timeoutMs, 1500));
  if (!reachable) {
    return buildVerificationResult(base, {
      gatewayReachable: false,
      status: 'unreachable',
      blockedReason: 'ib_gateway_unreachable',
    });
  }

  return new Promise((resolve) => {
    const client = new IBApi({ host: cfg.host, port: cfg.port, maxReqPerSec: 10 });
    const state = {
      gatewayReachable: true,
      connected: false,
      nextValidId: null,
      managedAccounts: [],
      error: null,
      finished: false,
    };

    const finish = (overrides = {}) => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      try { client.disconnect(); } catch (_) { /* ignore */ }
      const ibApiVerified = state.nextValidId !== null;
      const paperAccountVerified = state.managedAccounts.some(isPaperAccountId);
      const sessionVerified = ibApiVerified && paperAccountVerified;
      const result = buildVerificationResult(base, {
        gatewayReachable: true,
        status: sessionVerified ? 'verified' : 'reachable',
        blockedReason: sessionVerified
          ? 'read_only_session_verified'
          : (!ibApiVerified ? 'ib_api_not_verified' : 'paper_account_not_verified'),
        ibApiVerified,
        paperAccountVerified,
        managedAccounts: state.managedAccounts,
        paperAccountId: state.managedAccounts.find(isPaperAccountId) || null,
        sessionVerified,
        paperModeVerified: sessionVerified,
        paperMode: sessionVerified ? 'paper_only' : 'unknown',
        verificationMethod: 'nextValidId+managedAccounts',
        connected: state.connected,
        nextValidId: state.nextValidId,
        error: state.error,
        ...overrides,
      });
      sessionVerificationCache.set(cacheKey, {
        expiresAt: Date.now() + SESSION_VERIFY_TTL_MS,
        value: result,
      });
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: 'timeout', blockedReason: 'ib_api_not_verified' }), timeoutMs);
    client.once(EventName.connected, () => {
      state.connected = true;
      try {
        client.reqIds(1);
        client.reqManagedAccts();
      } catch (err) {
        state.error = err?.message || String(err);
        finish({ status: 'error', blockedReason: 'ib_api_not_verified' });
      }
    });
    client.once(EventName.nextValidId, (orderId) => {
      state.nextValidId = Number(orderId);
      if (state.managedAccounts.length > 0) finish();
    });
    client.once(EventName.managedAccounts, (accountsList) => {
      state.managedAccounts = parseManagedAccounts(accountsList);
      if (state.nextValidId !== null) finish();
    });
    client.once(EventName.error, (err, code) => {
      state.error = err?.message || `IB error ${code || 'unknown'}`;
    });
    try {
      client.connect(cfg.clientId);
    } catch (err) {
      state.error = err?.message || String(err);
      finish({ status: 'error', blockedReason: 'ib_gateway_unreachable' });
    }
  });
}

// Synchronous connection summary embedded in the status payload. Does NOT probe
// the network (status stays sync); the dedicated readiness endpoint performs the
// actual harmless TCP check.
function buildConnectionSummary() {
  const cfg = getConnectionConfig();
  const base = {
    host: cfg.host,
    port: cfg.port,
    portConfigured: cfg.portConfigured,
    clientIdConfigured: cfg.clientIdConfigured,
    status: 'disabled',
    // Paper mode can never be asserted from a TCP probe; it stays unknown until
    // a human verifies the IBKR Paper login inside IB Gateway / TWS.
    paperMode: 'unknown',
    paperModeVerified: false,
  };
  if (!cfg.checkEnabled) {
    return {
      ...base,
      connectionCheckEnabled: false,
      gatewayReachable: false,
      status: 'disabled',
      blockedReason: 'ib_connection_check_disabled',
    };
  }
  if (!cfg.portConfigured) {
    return {
      ...base,
      connectionCheckEnabled: true,
      gatewayReachable: false,
      status: 'not_configured',
      blockedReason: 'ib_gateway_not_configured',
    };
  }
  return {
    ...base,
    connectionCheckEnabled: true,
    gatewayReachable: null, // unknown until the readiness endpoint probes
    status: 'reachable',
    blockedReason: 'connection_check_pending',
  };
}

// Read-only connection readiness endpoint payload. When disabled (default) it
// returns immediately without any network activity.
async function getConnectionReadiness() {
  const cfg = getConnectionConfig();
  const base = buildVerificationBase(cfg);

  if (!cfg.checkEnabled) {
    return {
      ...base,
      connectionCheckEnabled: false,
      gatewayReachable: false,
      status: 'disabled',
      blockedReason: 'ib_connection_check_disabled',
    };
  }
  if (!cfg.portConfigured) {
    return {
      ...base,
      connectionCheckEnabled: true,
      gatewayReachable: false,
      status: 'not_configured',
      blockedReason: 'ib_gateway_not_configured',
    };
  }

  const verification = await verifyPaperSession(cfg, { timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS });
  return {
    ...base,
    connectionCheckEnabled: true,
    gatewayReachable: verification.gatewayReachable === true,
    status: verification.status || (verification.gatewayReachable ? 'reachable' : 'unreachable'),
    blockedReason: verification.blockedReason || (verification.gatewayReachable ? 'reachable_read_only_no_orders' : 'ib_gateway_unreachable'),
    paperMode: verification.paperMode || 'unknown',
    paperModeVerified: verification.paperModeVerified === true,
    ibApiVerified: verification.ibApiVerified === true,
    paperAccountVerified: verification.paperAccountVerified === true,
    managedAccounts: verification.managedAccounts || [],
    managedAccountCount: verification.managedAccountCount || 0,
    paperAccountId: verification.paperAccountId || null,
    sessionVerified: verification.sessionVerified === true,
    verificationMethod: verification.verificationMethod || 'nextValidId+managedAccounts',
    nextValidId: verification.nextValidId || null,
    error: verification.error || null,
  };
}

function safeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function safeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function buildApprovedStrategyIndex() {
  const approvals = automationApprovalService.getAutomationApprovals();
  const allowlist = paperAllowlistService.getPaperAllowlistStatus();
  const approved = new Set(Array.isArray(approvals?.approvedStrategyIds) ? approvals.approvedStrategyIds.filter(Boolean) : []);
  const names = new Map();

  for (const row of Array.isArray(allowlist?.allowlist) ? allowlist.allowlist : []) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    names.set(id, String(row.name || id));
    if (row.approvedForPaperTesting === true) approved.add(id);
  }

  return { approved, names, approvals, allowlist };
}

// ── IB Paper direction normalization ───────────────────────────────────────
// Resolve a candidate's trade direction from EXISTING explicit direction-bearing
// fields only. We never guess from strategy name or setup label, and conflicting
// explicit signals resolve to "unknown" (kept blocked). This is read-only and
// touches no internal paper-trading logic.
const IB_DIRECTION_BUY_TOKENS = new Set([
  'buy', 'long', 'bull', 'bullish', 'up', 'uptrend', 'call',
  'köp', 'kop', 'lång', 'lang', 'positive', 'higher',
]);
const IB_DIRECTION_SELL_TOKENS = new Set([
  'sell', 'short', 'bear', 'bearish', 'down', 'downtrend', 'put',
  'sälj', 'salj', 'kort', 'negative', 'lower',
]);
// Direction-bearing fields, highest priority first. `runtimeDirection` is an
// internal gap-fill hint injected from the read-only paper-trading runtime view.
const IB_DIRECTION_FIELDS = [
  'direction', 'side', 'action', 'entrySide', 'tradeSide', 'signalDirection',
  'setupDirection', 'trendDirection', 'trend', 'bias', 'nextMoveBias', 'compassBias',
  'underlying_signal_direction', 'expectedMove', 'recommendation', 'runtimeDirection',
];

// Map a single raw value to 'BUY' | 'SELL' | null. null means "present but not
// directional" (e.g. UNCERTAIN/NEUTRAL) or unrecognised — never a guess.
function directionTokenToSide(value) {
  let raw = value;
  if (raw && typeof raw === 'object') {
    raw = raw.decision || raw.direction || raw.side || raw.bias || raw.trend || '';
  }
  const token = String(raw == null ? '' : raw).trim().toLowerCase();
  if (token === '') return null;
  const tokens = [token, ...token.split(/[^a-zåäö0-9]+/i).map((item) => item.trim().toLowerCase()).filter(Boolean)];
  if (tokens.some((item) => IB_DIRECTION_BUY_TOKENS.has(item))) return 'BUY';
  if (tokens.some((item) => IB_DIRECTION_SELL_TOKENS.has(item))) return 'SELL';
  return null;
}

// Robustly normalize direction from a candidate's existing fields. Returns the
// canonical side plus debug fields. Ambiguous/missing -> direction null.
function normalizeIbPaperDirection(candidate = {}) {
  const rawDirectionFields = {};
  const resolved = [];
  for (const field of IB_DIRECTION_FIELDS) {
    const value = candidate[field];
    if (value == null || value === '') continue;
    rawDirectionFields[field] = value;
    const side = directionTokenToSide(value);
    if (side === 'BUY' || side === 'SELL') resolved.push({ field, side });
  }
  const distinct = [...new Set(resolved.map((r) => r.side))];
  if (distinct.length === 0) {
    return { normalizedDirection: null, direction: null, directionSource: null, rawDirectionFields, ambiguous: false, directionConfidence: null };
  }
  if (distinct.length > 1) {
    // Conflicting explicit direction fields -> refuse to pick one.
    return { normalizedDirection: null, direction: null, directionSource: 'conflict', rawDirectionFields, ambiguous: true, directionConfidence: 'conflict' };
  }
  const side = distinct[0];
  return {
    normalizedDirection: side,
    direction: side === 'BUY' ? 'long' : 'short',
    directionSource: resolved[0].field,
    rawDirectionFields,
    ambiguous: false,
    directionConfidence: 'explicit',
  };
}

// Build a read-only direction index keyed by `${strategyId}:${SYMBOL}` from the
// public paper-trading runtime view. Only the NEWEST record per key is kept; if
// that newest record is UNCERTAIN/non-directional the entry resolves to null so
// stale older signals can never override a fresh uncertain one. Read-only.
function buildRuntimeDirectionIndex(runtime) {
  const index = new Map();
  let rt = runtime;
  if (!rt) {
    try {
      rt = paperTradingRuntimeService.buildPaperTradingRuntime({ limit: 100 });
    } catch (err) {
      return index; // never throw from a read-only preview helper
    }
  }
  const rows = []
    .concat(Array.isArray(rt?.openTrades) ? rt.openTrades : [])
    .concat(Array.isArray(rt?.closedTrades) ? rt.closedTrades : [])
    .concat(Array.isArray(rt?.recentEvents) ? rt.recentEvents : []);
  rows.sort((a, b) => String(b?.timestamp || '').localeCompare(String(a?.timestamp || '')));
  for (const row of rows) {
    const strategyId = String(row?.strategy_id || row?.strategyId || '').trim();
    const symbol = safeUpper(row?.symbol);
    if (!strategyId || !symbol) continue;
    const key = `${strategyId}:${symbol}`;
    if (index.has(key)) continue; // newest wins
    const rawValue = row?.direction != null ? row.direction : row?.nextMoveBias;
    const side = directionTokenToSide(rawValue);
    index.set(key, {
      side: side === 'BUY' || side === 'SELL' ? side : null,
      raw: rawValue == null ? null : rawValue,
      source: row?.source || null,
      timestamp: row?.timestamp || null,
    });
  }
  return index;
}

function inferDirection(candidate = {}) {
  const explicit = safeLower(candidate.direction || candidate.nextMoveBias || candidate.side);
  if (explicit === 'long' || explicit === 'short') return explicit;
  if (explicit === 'up' || explicit === 'bull' || explicit === 'buy') return 'long';
  if (explicit === 'down' || explicit === 'bear' || explicit === 'sell') return 'short';

  const blob = safeUpper([
    candidate.setup,
    candidate.signalSubtype,
    candidate.signalFamily,
    candidate.reason,
    candidate.strategyName,
  ].filter(Boolean).join(' '));

  if (/(LONG|BULL|BUY|UP)/.test(blob)) return 'long';
  if (/(SHORT|BEAR|SELL|DOWN)/.test(blob)) return 'short';
  return null;
}

function classifySymbol(candidate = {}) {
  const normalized = safeUpper(candidate.symbol);
  const fallbackGroup = candidate.marketGroup || candidate.group || candidate.market_group || null;
  const marketGroup = normalized
    ? marketUniverseService.getGroupForSymbol(normalized, fallbackGroup || undefined)
    : (fallbackGroup ? String(fallbackGroup) : null);
  let group = marketGroup ? String(marketGroup) : null;
  let marketGroupSource = group ? 'market_universe' : null;
  // Fallback ONLY when the registry has no group: classify a curated set of
  // well-known US equities as 'stocks'. Never overrides an existing group, so
  // ETF/QQQ/crypto classification is unaffected, and arbitrary unknowns stay null.
  if (!group && normalized && IB_PAPER_US_EQUITY_FALLBACK.has(normalized)) {
    group = 'stocks';
    marketGroupSource = 'ib_paper_us_equity_fallback';
  }
  return {
    symbol: normalized || null,
    marketGroup: group,
    normalizedMarketGroup: group,
    marketGroupSource,
    isCrypto: group === 'crypto',
    isEtf: group === 'etf' || group === 'leveraged_etf',
    isQqq: normalized === 'QQQ',
    isAllowedGroup: Boolean(group && ALLOWED_MARKET_GROUPS.has(group)),
    isKnown: Boolean(group),
  };
}

function joinReasons(reasons = []) {
  const list = reasons.filter(Boolean).map((item) => String(item).replace(/[.]\s*$/, ''));
  if (list.length === 0) return 'Godkänd för IB Paper-preview.';
  return `Blockerad: ${list.join('. ')}.`;
}

function selectionGroupRank(marketGroup) {
  const group = String(marketGroup || '').toLowerCase();
  if (group === 'nasdaq100') return 3;
  if (group === 'stocks') return 2;
  if (group === 'mag7') return 1;
  return 0;
}

function buildOrderPreviewCandidate(candidate = {}, context = {}) {
  const approvedIndex = context.approvedIndex || buildApprovedStrategyIndex();
  // Multi-strategy test mode context. Defaults OFF -> behaviour unchanged.
  const multi = context.multiStrategy || { enabled: false, includeEtf: false };
  const etfAllowed = multi.enabled === true && multi.includeEtf === true;
  const strategyId = String(candidate.canonicalStrategyId || candidate.strategyId || candidate.strategy_id || '').trim() || null;
  const strategyName = String(
    candidate.strategyName
    || candidate.strategy_name
    || (strategyId ? approvedIndex.names.get(strategyId) : '')
    || strategyId
    || 'Okänd strategi',
  ).trim();
  const symbolInfo = classifySymbol(candidate);
  // Resolve direction from the candidate's own explicit fields first. Only if
  // none are present (and not ambiguous) do we gap-fill from the read-only
  // runtime direction index, so an explicit candidate direction always wins and
  // an injected hint can never conflict with provided fields.
  let directionInfo = normalizeIbPaperDirection(candidate);
  if (!directionInfo.direction && !directionInfo.ambiguous && context.directionIndex && strategyId) {
    const hit = context.directionIndex.get(`${strategyId}:${safeUpper(candidate.symbol)}`);
    if (hit && (hit.side === 'BUY' || hit.side === 'SELL')) {
      directionInfo = normalizeIbPaperDirection({ ...candidate, runtimeDirection: hit.side });
    }
  }
  const direction = directionInfo.direction;
  const confidence = candidate.confidence ?? candidate.score ?? null;
  const gateScore = candidate.score ?? candidate.gateScore ?? null;
  const blockers = [];

  if (!strategyId) blockers.push('Saknar strategyId');
  if (!strategyId || !approvedIndex.approved.has(strategyId)) blockers.push('Strategin är inte godkänd i allowlisten');
  // Crypto is ALWAYS blocked (multi-strategy mode never relaxes this). ETF/QQQ
  // stay blocked unless multi-strategy mode is ON *and* INCLUDE_ETF is true.
  if (!symbolInfo.symbol) blockers.push('Saknar symbol');
  else if (symbolInfo.isCrypto) blockers.push('Krypto är blockerat i denna fas');
  else if (symbolInfo.isQqq && !etfAllowed) blockers.push('QQQ är blockerat i denna fas');
  else if (symbolInfo.isEtf && !etfAllowed) blockers.push('ETF är blockerat i denna fas');
  else if (!symbolInfo.isKnown) blockers.push('Okänd marknadsgrupp');
  else if (!symbolInfo.isAllowedGroup && !(etfAllowed && (symbolInfo.isEtf || symbolInfo.isQqq))) blockers.push('Symbolen är inte en Nasdaq100- eller US-stock-kandidat');
  if (!direction) blockers.push('Riktningen kunde inte verifieras tydligt');

  const allowedForIbPaperPreview = blockers.length === 0;
  const reasonSv = allowedForIbPaperPreview
    ? 'Godkänd för IB Paper-preview: godkänd strategi, tillåten marknad och tydlig riktning. Inga order skickas ännu.'
    : joinReasons(blockers);

  return {
    strategyId,
    strategyName,
    symbol: symbolInfo.symbol,
    direction: direction || 'unknown',
    // Read-only direction-normalization debug fields (never enable an order).
    normalizedDirection: directionInfo.normalizedDirection,
    directionSource: directionInfo.directionSource,
    directionConfidence: directionInfo.directionConfidence,
    directionAmbiguous: directionInfo.ambiguous === true,
    rawDirectionFields: directionInfo.rawDirectionFields,
    source: String(candidate.source || 'unknown'),
    confidence,
    gateScore,
    price: candidate.price ?? null,
    currentPrice: candidate.currentPrice ?? null,
    entryPrice: candidate.entryPrice ?? null,
    stopLoss: candidate.stopLoss ?? candidate.stopLossPrice ?? null,
    takeProfit: candidate.takeProfit ?? candidate.takeProfit1 ?? null,
    stopLossPct: candidate.stopLossPct ?? candidate.stop_loss_pct ?? null,
    takeProfitPct: candidate.takeProfitPct ?? candidate.take_profit_pct ?? null,
    allowedForIbPaperPreview,
    blockers,
    reasonSv,
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    marketGroup: symbolInfo.marketGroup,
    normalizedMarketGroup: symbolInfo.normalizedMarketGroup,
    marketGroupSource: symbolInfo.marketGroupSource,
    previewOnly: true,
    blockedExecution: true,
    // Additive multi-strategy planning hints (read-only; never enable an order).
    ibPaperMultiStrategyMode: multi.enabled === true,
    wouldForceQuantity: 1,
    bracketRequired: true,
    entryOnlyBlocked: true,
    multiStrategyBlockers: multi.enabled === true ? [...blockers] : [],
    approvalStatus: strategyId && approvedIndex.approved.has(strategyId) ? 'approved' : 'not_approved',
    selectionRank: (allowedForIbPaperPreview ? 10_000 : 0)
      + (symbolInfo.isAllowedGroup ? 1_000 : 0)
      + (selectionGroupRank(symbolInfo.marketGroup) * 100)
      + (Number.isFinite(Number(gateScore)) ? Number(gateScore) : Number.isFinite(Number(confidence)) ? Number(confidence) : 0),
  };
}

function getIbPaperOrderPreview(options = {}) {
  const approvedIndex = buildApprovedStrategyIndex();
  // Multi-strategy test mode (default OFF). When OFF, limit/caps are unchanged:
  // PREVIEW_LIMIT=3 and maxPerDay=3. When ON, the limit widens to maxCandidates
  // and maxPerDay mirrors the global daily cap.
  const multi = options.multiStrategy || interactiveBrokersPaperMultiStrategyConfigService.getIbPaperMultiStrategyConfig();
  const previewLimit = multi.enabled === true ? multi.maxCandidates : PREVIEW_LIMIT;
  const dailySelectionPreview = options.dailySelectionPreview
    || paperTradingRuntimeService._internal.buildDailySelectionPreview({
      selectionCount: previewLimit,
      now: options.now,
      files: options.files,
    });
  const rawCandidates = Array.isArray(options.candidates)
    ? options.candidates
    : Array.isArray(dailySelectionPreview?.candidates)
      ? dailySelectionPreview.candidates
      : [];

  // Read-only direction index from the public paper-trading runtime view. Used
  // only to gap-fill direction when a candidate carries no explicit direction.
  const directionIndex = options.directionIndex || buildRuntimeDirectionIndex(options.runtime);
  const classified = rawCandidates
    .map((candidate) => buildOrderPreviewCandidate(candidate, { approvedIndex, multiStrategy: multi, directionIndex }))
    .sort((a, b) => {
      if (a.selectionRank !== b.selectionRank) return b.selectionRank - a.selectionRank;
      return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
    })
    .slice(0, previewLimit);

  const allowedCandidates = classified.filter((row) => row.allowedForIbPaperPreview);
  const blockedCandidates = classified.filter((row) => !row.allowedForIbPaperPreview);
  const blockerCounts = {};
  for (const row of blockedCandidates) {
    for (const reason of row.blockers || []) {
      blockerCounts[reason] = (blockerCounts[reason] || 0) + 1;
    }
  }
  const totalAllowed = allowedCandidates.length;
  const totalBlocked = blockedCandidates.length;
  const blockerSummary = Object.keys(blockerCounts).join(', ') || 'policygrindar';
  const summaryNote = totalAllowed === previewLimit
    ? (previewLimit === PREVIEW_LIMIT
      ? 'Tre kandidater är tillåtna för IB Paper-preview idag.'
      : `${totalAllowed} kandidater är tillåtna för IB Paper-preview idag.`)
    : totalAllowed > 0
      ? `Endast ${totalAllowed} kandidat${totalAllowed === 1 ? '' : 'er'} uppfyller alla IB Paper-preview-grindar. Övriga blockerades av ${blockerSummary}.`
      : `Inga kandidater uppfyller alla IB Paper-preview-grindar just nu. ${totalBlocked} kandidat${totalBlocked === 1 ? '' : 'er'} blockerades.`;

  return {
    ok: true,
    mode: 'preview_only',
    maxPerDay: multi.enabled === true ? multi.globalDailyCap : PREVIEW_LIMIT,
    maxCandidates: previewLimit,
    cryptoBlocked: true,
    etfBlocked: multi.enabled === true ? multi.includeEtf !== true : true,
    qqqBlocked: multi.enabled === true ? multi.includeEtf !== true : true,
    multiStrategyMode: multi.enabled === true,
    perStrategyDailyCap: multi.enabled === true ? multi.perStrategyDailyCap : null,
    includeEtf: multi.enabled === true ? multi.includeEtf === true : false,
    executionEnabled: false,
    orderQueueEnabled: false,
    brokerExecutionEnabled: false,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    candidates: classified,
    allowedCandidates,
    blockedCandidates,
    generatedAt: new Date().toISOString(),
    summary: {
      totalCandidates: classified.length,
      allowedCandidates: totalAllowed,
      blockedCandidates: totalBlocked,
      availableAllowedCandidates: totalAllowed,
      availableBlockedCandidates: totalBlocked,
      previewSource: 'paperTradingRuntimeService._internal.buildDailySelectionPreview',
      noteSv: summaryNote,
      blockerCounts,
      cryptoBlocked: true,
      etfBlocked: true,
      qqqBlocked: true,
    },
    source: {
      dailySelectionPreviewMode: dailySelectionPreview?.mode || 'preview_only',
      dailySelectionPreviewDate: dailySelectionPreview?.date || null,
      dailySelectionPreviewCount: dailySelectionPreview?.selectedCount || 0,
      approvedStrategyCount: approvedIndex.approved.size,
    },
  };
}

// Map the existing read-only allowlist rows into a minimal, IB-preview-shaped
// view. We expose ONLY already-approved strategies. No mutation, no new fields
// that imply execution.
//
// sourceStatus:
//   'ok'       — source read, at least one approved strategy
//   'empty'    — source read, but no approved strategies (not an error)
//   'degraded' — source missing/errored (still ok:true at the endpoint level)
function readApprovedStrategies() {
  let status;
  try {
    status = paperAllowlistService.getPaperAllowlistStatus();
  } catch (err) {
    // Defensive: never throw out of the preview. Treat as a degraded source.
    return {
      approvedStrategies: [],
      sourceAvailable: false,
      sourceStatus: 'degraded',
      sourceError: err.message || String(err),
    };
  }

  if (!status || !Array.isArray(status.allowlist)) {
    return {
      approvedStrategies: [],
      sourceAvailable: false,
      sourceStatus: 'degraded',
      sourceError: 'approval_allowlist_source_unavailable',
    };
  }

  const approvedStrategies = status.allowlist.map((row) => ({
    id: row.id,
    name: row.name || row.id,
    approvedForPaperTesting: row.approvedForPaperTesting === true,
    // Preview-only readiness hint. This reflects the INTERNAL paper-simulation
    // runtime readiness as reported by the existing allowlist — it never means
    // "ready to send an IB order".
    paperRuntimeReady: row.readyForPaperRuntime === true,
    runtimeConnectionStatus: row.runtimeConnectionStatus || 'unknown',
  }));

  return {
    approvedStrategies,
    sourceAvailable: true,
    sourceStatus: approvedStrategies.length === 0 ? 'empty' : 'ok',
    sourceError: null,
  };
}

// Build the canonical IB Paper status payload (Phase 1).
function getIbPaperStatus() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceAvailable, sourceStatus, sourceError } = readApprovedStrategies();

  // blockedReason precedence: if the preview feature flag is off, that is the
  // governing reason. Otherwise, order sending is still blocked because Phase 1
  // never builds execution.
  const blockedReason = flags.previewEnabled
    ? 'execution_not_implemented_phase_1'
    : 'feature_flag_disabled';

  return {
    ok: true,
    dryRun: true,
    ibPaper: {
      enabled: false,
      previewEnabled: flags.previewEnabled,
      // orderQueueEnabled mirrors the env flag for transparency, but the queue
      // is ALWAYS blocked (see orderQueueBlocked) — no queue code exists.
      orderQueueEnabled: flags.orderQueueEnabled,
      executionEnabled: flags.executionEnabled,
    },
    safety: { ...SAFETY },
    // Hard, env-independent blocks. These never flip to false in Phase 1.
    orderSendingBlocked: true,
    orderQueueBlocked: true,
    executionBlocked: true,
    // Phase 1 can NEVER create an IB Paper order. This is hard-coded false.
    wouldCreateIbPaperOrder: false,
    blockedReason,
    nextPhaseLocked: { ...NEXT_PHASE_LOCKED },
    connection: buildConnectionSummary(),
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    approvedStrategiesSource: {
      available: sourceAvailable,
      status: sourceStatus,
      via: 'paperAllowlistService.getPaperAllowlistStatus',
    },
    // The internal paper trading flow is completely separate and untouched.
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: 'Read-only Phase 1 preview. No broker connection, no order submission, '
      + 'no order queue, no execution. Internal paper trading is separate and '
      + 'unchanged.',
  };
}

// Approved-strategies-only preview endpoint. Returns an empty list (not an
// error) when nothing is approved, and a degraded status if the source is
// unavailable — always ok:true.
function getApprovedStrategiesPreview() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceAvailable, sourceStatus, sourceError } = readApprovedStrategies();

  const explanation = sourceStatus === 'degraded'
    ? 'Approval/allowlist source is unavailable; showing empty list. This is not an error.'
    : (sourceStatus === 'empty'
      ? 'No strategies are approved yet in the existing approval/allowlist source.'
      : 'Only already-approved strategies are shown.');

  return {
    ok: true,
    dryRun: true,
    previewEnabled: flags.previewEnabled,
    degraded: sourceStatus === 'degraded',
    safety: { ...SAFETY },
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    approvedStrategiesSource: {
      available: sourceAvailable,
      status: sourceStatus,
      via: 'paperAllowlistService.getPaperAllowlistStatus',
    },
    // What *would* be eligible to preview as IB Paper signals in the future.
    // Still nothing is sent — this is purely descriptive.
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    blockedReason: flags.previewEnabled ? 'execution_not_implemented_phase_1' : 'feature_flag_disabled',
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: explanation + ' No new approval logic. No orders are created or sent.',
  };
}

module.exports = {
  SAFETY,
  NEXT_PHASE_LOCKED,
  getFeatureFlags,
  getConnectionConfig,
  getConnectionReadiness,
  getIbPaperStatus,
  getApprovedStrategiesPreview,
  getIbPaperOrderPreview,
  _internal: {
    safeUpper,
    safeLower,
    buildApprovedStrategyIndex,
    inferDirection,
    normalizeIbPaperDirection,
    directionTokenToSide,
    buildRuntimeDirectionIndex,
    classifySymbol,
    buildOrderPreviewCandidate,
  },
};
