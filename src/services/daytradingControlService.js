'use strict';

const fs = require('fs');
const path = require('path');

const { getLatestResults, getScanStatus, getGroups } = require('../scanner/scheduler');
const { getCryptoResults, getCryptoStatus } = require('../scanner/cryptoScheduler');
const daytradingCatalog = require('./daytradingStrategyCatalogService');
const strategyPerformance = require('./strategyPerformanceService');
const marketUniverse = require('./marketUniverseService');
const dataCoverage = require('./dataCoverageExpansionService');
const candidateLog = require('./candidateLogService');
const auditTrail = require('./auditTrailService');
const paperTrading = require('../paperTrading/paperTradingAgent');
const executionSafety = require('./executionSafetyService');
const strategyRuntimeConnector = require('./strategyRuntimeConnectorService');
const { buildCryptoSignalContext } = strategyRuntimeConnector;

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
});

const CONFIG_FILE = path.resolve(__dirname, '../../data/config/daytrading-control.json');
const IMPACT_FILE = path.resolve(__dirname, '../../data/daytrading-control/latest-impact.json');
const PAPER_TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const PAPER_EVENTS_FILE = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');

const DEFAULT_CONFIG = Object.freeze({
  market: 'all',
  symbols: [],
  auto_scan: false,
  strategies: {},
  market_control_filters: {
    min_score: 60,
    min_confidence: 70,
    max_risk_class: 'extreme',
    max_trades_per_hour: 10,
    cooldown_minutes: 5,
    max_spread_percent: 0.5,
    max_leverage: 10,
  },
});

const MARKET_LABELS = Object.freeze({
  all: 'Alla',
  stocks: 'Aktier',
  nasdaq: 'Nasdaq',
  crypto: 'Krypto',
  etf: 'ETF',
  index: 'Index',
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function rawSignalOf(row = {}) {
  return row.signalSubtype || row.signal_subtype || row.signal || row.eventType || row.signalFamily || null;
}

function paperTimeOf(row = {}) {
  return row.opened_at || row.entryTime || row.timestamp || row.ts || row.created_at || null;
}

function isWithinHours(iso, hours) {
  const time = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(time) && Date.now() - time <= hours * 60 * 60 * 1000;
}

function toIsoIfValid(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function minutesSince(iso, referenceMs = Date.now()) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((referenceMs - time) / 60000));
}

function paperSignalTimeOf(row = {}) {
  return toIsoIfValid(
    row.detected_at ||
    row.evaluated_at ||
    row.ts ||
    row.timestamp ||
    row.created_at ||
    row.opened_at ||
    row.lastUpdate ||
    null,
  );
}

function paperTradeTimeOf(row = {}) {
  return toIsoIfValid(
    row.opened_at ||
    row.entryTime ||
    row.timestamp ||
    row.createdAt ||
    row.created_at ||
    row.exitTime ||
    row.closed_at ||
    null,
  );
}

function sortNewestFirstByTime(a, b) {
  const aTime = new Date(a || 0).getTime() || 0;
  const bTime = new Date(b || 0).getTime() || 0;
  return bTime - aTime;
}

function isoDateOnly(value) {
  const iso = toIsoIfValid(value);
  return iso ? iso.slice(0, 10) : null;
}

function tradeTimestampOf(trade = {}) {
  return toIsoIfValid(
    trade.closed_at ||
    trade.exitTime ||
    trade.exit_time ||
    trade.entryTime ||
    trade.opened_at ||
    trade.createdAt ||
    trade.timestamp ||
    trade.last_update_at ||
    null,
  );
}

function tradeOpenTimestampOf(trade = {}) {
  return toIsoIfValid(
    trade.opened_at ||
    trade.entryTime ||
    trade.createdAt ||
    trade.timestamp ||
    null,
  );
}

function tradeExitTimestampOf(trade = {}) {
  return toIsoIfValid(
    trade.closed_at ||
    trade.exitTime ||
    trade.exit_time ||
    trade.last_update_at ||
    null,
  );
}

function tradeSideLabel(trade = {}) {
  const raw = String(trade.direction || trade.nextMoveBias || trade.side || trade.type || '').toUpperCase();
  if (raw.includes('DOWN') || raw.includes('SHORT') || raw.includes('SELL')) return 'Short';
  if (raw.includes('UP') || raw.includes('LONG') || raw.includes('BUY')) return 'Long';
  return '–';
}

function tradeStatusLabel(trade = {}) {
  const result = String(trade.result || '').toUpperCase();
  const exitReason = String(trade.exitReason || trade.exit_reason || trade.exit_reason_code || trade.exitReasonCode || '').toUpperCase();
  if (result === 'OPEN') return 'Öppen';
  if (result === 'TIMEOUT') return 'Timeout';
  if (exitReason.includes('STOP')) return 'SL';
  if (exitReason.includes('TARGET') || exitReason.includes('TP')) return 'TP';
  return 'Stängd';
}

function tradeSourceLabel(trade = {}) {
  const source = String(trade.source || '').toLowerCase();
  if (source === 'open_trade') return 'Öppen';
  if (source === 'recent_closed') return 'Stängd idag';
  if (source === 'history') return 'Historik';
  if (source === 'latest_scan') return 'Aktuell';
  return '–';
}

function strategyMetadataOf(row = {}) {
  const sourceStrategyId = row.sourceStrategyId || null;
  const explicitStrategyId = row.strategyId || row.strategy_id || row.setupId || sourceStrategyId || row.resolvedStrategyId || null;
  const signalSubtype = String(row.signalSubtype || row.signal_subtype || '').toUpperCase();
  const signalFamily = String(row.signalFamily || row.signal_family || '').toUpperCase();
  let strategyId = explicitStrategyId;
  let resolvedStrategyId = row.resolvedStrategyId || explicitStrategyId || null;
  let strategyName = row.strategyName || row.strategy_name || null;
  let resolvedStrategyName = row.resolvedStrategyName || strategyName || null;
  let mappingSource = row.mappingSource || (explicitStrategyId ? 'explicit' : 'unknown');

  if (!strategyId) {
    if (signalSubtype === 'VWAP_RECLAIM_UP' || signalFamily === 'VWAP_RECLAIM_UP') {
      strategyId = 'vwap_volume_breakout_long';
      resolvedStrategyId = strategyId;
      strategyName = strategyName || 'VWAP Volume Breakout Long';
      resolvedStrategyName = resolvedStrategyName || strategyName;
      mappingSource = 'metadata_recovery';
    } else if (signalSubtype === 'VWAP_REJECTION_DOWN' || signalFamily === 'VWAP_REJECTION_DOWN') {
      strategyId = 'vwap_failed_breakout_short';
      resolvedStrategyId = strategyId;
      strategyName = strategyName || 'VWAP Failed Breakout Short';
      resolvedStrategyName = resolvedStrategyName || strategyName;
      mappingSource = 'metadata_recovery';
    }
  }

  return {
    sourceStrategyId,
    sourceStrategyName: row.sourceStrategyName || null,
    strategyId,
    strategyName,
    resolvedStrategyId,
    resolvedStrategyName,
    mappingSource,
  };
}

function tradeAgeMinutesOf(trade = {}, nowMs = Date.now()) {
  const ts = trade.openedAt || trade.opened_at || trade.entryTime || trade.createdAt || trade.tradeTimestamp || trade.time || null;
  if (!ts) return null;
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((nowMs - time) / 60000));
}

function tradePnlKr(trade = {}) {
  const riskSek = Number(trade.riskPositionSizeSek ?? trade.position_size_sek ?? trade.riskPositionSize ?? trade.positionSizeSek ?? null);
  const pnlPct = Number(trade.pnlPct ?? trade.unrealizedPct ?? trade.pnl ?? null);
  if (!Number.isFinite(riskSek) || !Number.isFinite(pnlPct)) return null;
  return Math.round((riskSek * pnlPct / 100) * 100) / 100;
}

function normalizeStrategyKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function buildStrategyIndex(rows = []) {
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (row?.id) byId.set(String(row.id), row);
    if (row?.name) byName.set(normalizeStrategyKey(row.name), row);
    if (row?.strategy_name) byName.set(normalizeStrategyKey(row.strategy_name), row);
  }
  return { byId, byName };
}

function resolveStrategyRow(input = {}, index = {}, options = {}) {
  const allowInference = options.allowInference !== false;
  const directId = input.strategy_id || input.strategyId || input.setupId || null;
  if (directId && index.byId?.has(String(directId))) return index.byId.get(String(directId));
  const directName = input.strategy_name || input.strategyName || input.strategy || null;
  if (directName && index.byName?.has(normalizeStrategyKey(directName))) return index.byName.get(normalizeStrategyKey(directName));
  if (!allowInference) return null;
  const inferred = strategyRuntimeConnector.inferStrategyForSignal(input);
  if (inferred?.strategy_id && index.byId?.has(String(inferred.strategy_id))) return index.byId.get(String(inferred.strategy_id));
  return inferred?.strategy_id ? { id: inferred.strategy_id, name: inferred.strategy_name || inferred.strategy_id } : null;
}

function strategyDiagnosticLabel(strategy = {}) {
  return strategy.name || strategy.strategy_name || strategy.id || '–';
}

function strategyHasEntryRule(strategy = {}, runtime = {}) {
  if (runtime?.entry_rule_implemented === true) return true;
  return Array.isArray(strategy.signal_rules) && strategy.signal_rules.length > 0;
}

function strategyHasExitRule(strategy = {}) {
  return strategy.default_stop_loss_pct != null || strategy.default_stop_loss_r != null || strategy.default_take_profit_r != null || strategy.default_timeout_min != null || strategy.default_holding_time_min != null;
}

function countBy(arr = [], keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function getPaperTradeSummary48h() {
  const rows = readJsonl(PAPER_TRADES_FILE, []);
  const recent = rows.filter((row) => isWithinHours(paperTimeOf(row), 48));
  const counts = {};
  for (const row of recent) {
    const raw = rawSignalOf(row) || 'OKÄND';
    counts[raw] = (counts[raw] || 0) + 1;
  }
  const vwapReclaim = counts.VWAP_RECLAIM_UP || 0;
  const vwapReject = counts.VWAP_REJECTION_DOWN || 0;
  return {
    window_hours: 48,
    source: 'data/paper-trading/trades.jsonl',
    total: recent.length,
    by_raw_signal: Object.entries(counts)
      .map(([raw_signal, count]) => ({ raw_signal, count }))
      .sort((a, b) => b.count - a.count),
    vwap_reclaim_up: vwapReclaim,
    vwap_rejection_down: vwapReject,
    other_strategies: Math.max(0, recent.length - vwapReclaim - vwapReject),
    text_sv: 'Just nu kommer faktiska paper trades nästan bara från VWAP-familjen. Övriga strategier kan finnas i katalogen men är inte nödvändigtvis kopplade till paper-runtime.',
    ...SAFETY,
  };
}

function stoppageLabel(event = {}) {
  const raw = String(rawSignalOf(event) || '').toUpperCase();
  const reason = String(event.reasonSv || event.reason || '').trim();
  if (raw === 'REGULAR_PULLBACK') return 'REGULAR_PULLBACK: stoppas ofta av "Jaga inte" / "Vänta"';
  if (raw === 'EMA_PULLBACK_UP' || raw === 'EMA_PULLBACK_DOWN') return 'EMA_PULLBACK_UP/DOWN: EMA pausad i paper test';
  if (raw === 'NARROW_WAIT') return 'NARROW_WAIT: vänteläge/svag volym';
  if (raw.includes('VWAP')) return 'VWAP: kan stoppas av gate, redan öppen position eller vänteläge';
  return raw ? `${raw}: ${reason || 'stoppades innan paper trade'}` : (reason || 'Stoppad innan paper trade');
}

function getPaperStoppageSummary48h() {
  const rows = readJsonl(PAPER_EVENTS_FILE, [])
    .filter((row) => isWithinHours(row.timestamp || row.ts, 48))
    .filter((row) => row.decision === 'skipped' || row.type === 'TRADE_SKIPPED' || row.type === 'MAX_TRADES_REACHED');
  const counts = {};
  for (const row of rows) {
    const label = stoppageLabel(row);
    counts[label] = (counts[label] || 0) + 1;
  }
  return {
    window_hours: 48,
    source: 'data/paper-trading/events.jsonl',
    total: rows.length,
    top_reasons: Object.entries(counts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    text_sv: 'Strategier kan stoppas innan paper trade om signalen är för svag, marknaden inte passar, cooldown finns, eller strategin är pausad.',
    ...SAFETY,
  };
}

function loadConfig() {
  const saved = readJson(CONFIG_FILE, {});
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    strategies: saved.strategies && typeof saved.strategies === 'object' ? saved.strategies : {},
    market_control_filters: {
      ...DEFAULT_CONFIG.market_control_filters,
      ...(saved.market_control_filters && typeof saved.market_control_filters === 'object' ? saved.market_control_filters : {}),
    },
    ...SAFETY,
  };
}

function saveConfig(config) {
  const next = {
    ...DEFAULT_CONFIG,
    ...config,
    updated_at: nowIso(),
    ...SAFETY,
  };
  writeJson(CONFIG_FILE, next);
  return next;
}

function normalizeMarket(market) {
  const key = String(market || 'all').toLowerCase();
  if (key === 'aktier') return 'stocks';
  if (key === 'krypto') return 'crypto';
  if (key === 'alla') return 'all';
  if (key === 'etfs') return 'etf';
  return MARKET_LABELS[key] ? key : 'all';
}

function safeArray(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (value == null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function marketForSymbol(symbol, fallback = 'stocks') {
  const sym = normalizeSymbol(symbol);
  if (!sym) return fallback;
  if (sym.endsWith('USDT')) return 'crypto';
  if (['QQQ', 'SPY', 'IWM', 'DIA'].includes(sym)) return 'etf';
  return fallback || 'stocks';
}

function hasLiveOrderRequest(patch = {}) {
  return patch.live_enabled === true ||
    patch.live_trading_enabled === true ||
    patch.can_place_orders === true ||
    patch.actions_allowed === true ||
    patch.mode === 'live' ||
    patch.testMode === 'live';
}

function liveOrderBlockedResponse() {
  return {
    ok: false,
    error: 'Live/order-flaggor är avstängda. Endast paper/test/scanner/replay/batch är tillåtet.',
    ...SAFETY,
  };
}

function groupMatches(filter, group, symbol) {
  const f = normalizeMarket(filter);
  const g = String(group || marketForSymbol(symbol)).toLowerCase();
  if (f === 'all') return true;
  if (f === 'nasdaq') return g === 'nasdaq' || g === 'nasdaq100' || ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'TSLA', 'AMD', 'QQQ'].includes(normalizeSymbol(symbol));
  if (f === 'etf') return g === 'etf' || g === 'index' || g === 'leveraged_etf';
  if (f === 'stocks') return ['stocks', 'stock', 'nasdaq100', 'sp500', 'mag7'].includes(g);
  return g === f;
}

function currentScanRows() {
  const stocks = (getLatestResults() || []).map((row) => ({ ...row, market_group: row.marketGroup || row.marketType || 'stocks' }));
  const crypto = (getCryptoResults() || []).map((row) => {
    const cryptoContext = buildCryptoSignalContext({ ...row, market_group: 'crypto', marketType: 'crypto' });
    return {
      ...row,
      market_group: 'crypto',
      marketType: 'crypto',
      crypto_signal_context: cryptoContext,
      crypto_context: cryptoContext,
    };
  });
  return [...stocks, ...crypto];
}

function filterScanRows(rows, config) {
  const symbols = safeArray(config.symbols).map(normalizeSymbol);
  return (rows || []).filter((row) => {
    const sym = normalizeSymbol(row.symbol);
    if (symbols.length && !symbols.includes(sym)) return false;
    if (!marketUniverse.symbolEnabledFor(sym, 'scanner', row.market_group || row.marketGroup || row.marketType)) return false;
    return groupMatches(config.market, row.market_group || row.marketGroup || row.marketType, sym);
  });
}

function simpleSignalStatus(row) {
  const score = Number(row.tradeScore ?? row.signalScore ?? row.priorityScore ?? row.score ?? 0) || 0;
  const signal = String(row.signal || row.status || '').toUpperCase();
  if (score < 45) return 'Blockerad av låg score';
  if (signal.includes('BLOCK')) return 'Blockerad av riskfilter';
  if (signal.includes('LONG') || signal.includes('SHORT')) return 'Signal';
  return 'Kandidat';
}

function pipelineFromScan(rows, config, phase = 'klar') {
  const first = rows[0] || {};
  const strategy = first.strategy_name || first.strategyLabel || 'Ingen strategi matchade ännu';
  const symbol = first.symbol || safeArray(config.symbols)[0] || 'Alla symboler';
  const score = Number(first.tradeScore ?? first.signalScore ?? first.priorityScore ?? first.score ?? 0) || 0;
  const safetyBlocked = true;
  const hasRows = rows.length > 0;
  const statuses = phase === 'running'
    ? ['klar', 'kor', 'kor', 'vantar', 'vantar', 'vantar', 'vantar', 'vantar', 'vantar', 'vantar', 'vantar']
    : ['klar', 'klar', hasRows ? 'klar' : 'vantar', hasRows ? 'klar' : 'vantar', hasRows ? 'klar' : 'vantar', 'blockerad', hasRows ? 'blockerad' : 'vantar', 'vantar', 'vantar', 'vantar', 'vantar'];

  return [
    { id: 'data', label: 'Data hämtas', status: statuses[0], text: hasRows ? `${rows.length} rader finns i senaste scan.` : 'Ingen matchande data i senaste scan.' },
    { id: 'scanner', label: 'Scanner kör', status: statuses[1], text: phase === 'running' ? 'Ny testsökning startad.' : 'Senaste scan läst från backend.' },
    { id: 'symbol', label: 'Symbol analyseras', status: statuses[2], text: hasRows ? `${symbol} analyseras.` : 'Väntar på kandidat.' },
    { id: 'strategy', label: 'Strategi matchas', status: statuses[3], text: hasRows ? `${strategy} matchade.` : 'Ingen strategi matchad ännu.' },
    { id: 'risk', label: 'Riskfilter kontrolleras', status: statuses[4], text: score ? `Score ${Math.round(score)} kontrolleras mot filter.` : 'Väntar på score.' },
    { id: 'safety', label: 'Safety kontrolleras', status: statuses[5], text: 'Safety blockerar riktiga ordrar.' },
    { id: 'paper', label: 'Paper trade eller blockering', status: statuses[6], text: safetyBlocked ? 'Riktig order blockeras. Endast test/paper är möjligt.' : 'Paper trade kan öppnas.' },
    { id: 'follow', label: 'Trade följs', status: statuses[7], text: 'Pågående paper trades följs i paper-agenten.' },
    { id: 'exit', label: 'Exit sker', status: statuses[8], text: 'Exit sparas när paper trade stängs.' },
    { id: 'result', label: 'Resultat sparas', status: statuses[9], text: 'Resultat sparas som testdata.' },
    { id: 'learning', label: 'Lärande uppdateras', status: statuses[10], text: 'Historiskt lärande uppdateras via analysflödet.' },
  ];
}

function latestImpactFallback() {
  return {
    ok: true,
    before: { candidates: 0, signals: 0, blocked: 0 },
    after: { candidates: 0, signals: 0, blocked: 0 },
    changed_symbols: [],
    winner: null,
    summary_sv: 'Ingen ändring körd ännu.',
    generated_at: null,
    ...SAFETY,
  };
}

function writeImpact(beforeRows, afterRows, config, reason) {
  const countSignals = (rows) => rows.filter((r) => simpleSignalStatus(r) === 'Signal').length;
  const countBlocked = (rows) => rows.filter((r) => simpleSignalStatus(r).startsWith('Blockerad')).length;
  const perf = strategyPerformance.compareStrategies();
  const winner = (perf.strategies || [])
    .filter(hasTradeHistory)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] || null;
  const afterSymbols = [...new Set(afterRows.map((r) => normalizeSymbol(r.symbol)).filter(Boolean))];
  const impact = {
    ok: true,
    before: {
      candidates: beforeRows.length,
      signals: countSignals(beforeRows),
      blocked: countBlocked(beforeRows),
    },
    after: {
      candidates: afterRows.length,
      signals: countSignals(afterRows),
      blocked: countBlocked(afterRows),
    },
    changed_symbols: afterSymbols,
    winner,
    reason: reason || 'filter_changed',
    summary_sv: afterRows.length
      ? `Efter ändringen hittades ${afterRows.length} kandidater: ${afterSymbols.slice(0, 6).join(', ')}. ${countBlocked(afterRows)} blockerades av filter eller safety.`
      : 'Efter ändringen hittades inga kandidater. Testa bredare marknad, fler symboler eller lägre min score i paper/testläge.',
    generated_at: nowIso(),
    ...SAFETY,
  };
  writeJson(IMPACT_FILE, impact);
  return impact;
}

function strategyConfigFor(id, strategy) {
  const config = loadConfig();
  const saved = config.strategies[id] || {};
  const active = saved.enabled_by_user ?? saved.active ?? strategy.active ?? true;
  return {
    active,
    enabled_by_user: active === true,
    status: saved.status || (active ? 'Aktiv' : 'Pausad'),
    market: saved.market || strategy.market_group || strategy.market || 'all',
    symbols: safeArray(saved.symbols),
    min_score: Number(saved.min_score ?? 50),
    min_confidence: Number(saved.min_confidence ?? strategy.confidence_threshold ?? 65),
    timeframe: saved.timeframe || strategy.default_timeframes?.[0] || '2m',
    direction: saved.direction || strategy.direction || 'both',
    stop_loss: Number(saved.stop_loss ?? strategy.default_stop_loss_pct ?? strategy.default_sl ?? 0.2),
    take_profit: Number(saved.take_profit ?? strategy.default_take_profit_r ?? strategy.default_tp ?? 1.5),
    max_trades: Number(saved.max_trades ?? 3),
    paper_only: true,
    avoid_weak_signals: saved.avoid_weak_signals !== false,
    hide_avoid: saved.hide_avoid === true,
    ...SAFETY,
  };
}

async function getStatus() {
  const scan = getScanStatus();
  const crypto = getCryptoStatus();
  const paper = paperTrading.getStatus();
  let safetyStatus = null;
  try { safetyStatus = await executionSafety.getSafetyStatus(); } catch (_) {}
  const rows = currentScanRows();
  const latestScan = scan.lastScan || crypto.lastScan || null;
  return {
    ok: true,
    backend_connected: true,
    scanner_active: Boolean(scan.scanning || crypto.scanning || latestScan),
    scanner_paused: !(scan.scanning || crypto.scanning) && !latestScan,
    data_active: rows.length > 0,
    learning_active: true,
    latest_scan: latestScan,
    live_trading: false,
    paper_trading: Boolean(paper.enabled),
    paper_status: paper,
    safety: {
      active: true,
      status: safetyStatus || null,
      message_sv: 'Safety aktiv: systemet analyserar och paper-tradar men kan inte lägga riktiga ordrar.',
      ...SAFETY,
    },
    ...SAFETY,
  };
}

function getMarkets() {
  const universe = marketUniverse.getUniverse();
  const groups = universe.groups || {};
  const markets = ['all', 'stocks', 'nasdaq', 'crypto', 'etf'].map((id) => ({
    id,
    label: MARKET_LABELS[id],
    enabled: id === 'all' ? true : groups[id]?.enabled !== false,
    paper_enabled: id === 'all' ? true : groups[id]?.paper_enabled !== false,
    live_enabled: false,
    can_place_orders: false,
    actions_allowed: false,
  }));
  return { ok: true, markets, active_market: loadConfig().market || 'all', ...SAFETY };
}

function getMarketControls() {
  const controls = marketUniverse.getMarketControls();
  return {
    ...controls,
    filters: loadConfig().market_control_filters,
    ...SAFETY,
  };
}

function updateMarketControl(groupId, patch = {}) {
  if (hasLiveOrderRequest(patch)) return liveOrderBlockedResponse();
  const result = marketUniverse.patchMarketControl(groupId, patch);
  return {
    ...result,
    filters: loadConfig().market_control_filters,
    ...SAFETY,
  };
}

function setRiskMarketControls(enabled) {
  const result = marketUniverse.setRiskControls(enabled === true);
  return {
    ...result,
    filters: loadConfig().market_control_filters,
    ...SAFETY,
  };
}

function setAllMarketControls(enabled) {
  const result = marketUniverse.setAllMarketControls(enabled === true);
  return {
    ...result,
    filters: loadConfig().market_control_filters,
    ...SAFETY,
  };
}

function saveMarketControlSliders(patch = {}) {
  if (hasLiveOrderRequest(patch)) return liveOrderBlockedResponse();
  const riskClasses = new Set(['normal', 'high', 'extreme']);
  const current = loadConfig();
  const nextFilters = {
    ...current.market_control_filters,
    min_score: Math.max(0, Math.min(100, Number(patch.min_score ?? current.market_control_filters.min_score) || 0)),
    min_confidence: Math.max(0, Math.min(100, Number(patch.min_confidence ?? current.market_control_filters.min_confidence) || 0)),
    max_risk_class: riskClasses.has(patch.max_risk_class) ? patch.max_risk_class : current.market_control_filters.max_risk_class,
    max_trades_per_hour: Math.max(0, Math.min(100, Number(patch.max_trades_per_hour ?? current.market_control_filters.max_trades_per_hour) || 0)),
    cooldown_minutes: Math.max(0, Math.min(240, Number(patch.cooldown_minutes ?? current.market_control_filters.cooldown_minutes) || 0)),
    max_spread_percent: Math.max(0, Math.min(25, Number(patch.max_spread_percent ?? current.market_control_filters.max_spread_percent) || 0)),
    max_leverage: Math.max(1, Math.min(100, Number(patch.max_leverage ?? current.market_control_filters.max_leverage) || 1)),
  };
  const next = saveConfig({ ...current, market_control_filters: nextFilters });
  auditTrail.logAuditEvent({
    type: 'DAYTRADING_MARKET_CONTROL_FILTERS_UPDATED',
    source: 'daytrading_control',
    timestamp: nowIso(),
    message: 'Market & risk-filter uppdaterade för paper/scanner.',
    details: { filters: nextFilters, safety: SAFETY },
  });
  return {
    ok: true,
    filters: next.market_control_filters,
    message_sv: 'Filter sparade för paper/scanner.',
    ...SAFETY,
  };
}

function getSymbols() {
  const universe = marketUniverse.getUniverse();
  const coverage = dataCoverage.getAllSymbolCoverage().symbols || [];
  const coverageBySymbol = Object.fromEntries(coverage.map((row) => [normalizeSymbol(row.symbol), row]));
  const symbols = (universe.symbols || []).map((row) => {
    const sym = normalizeSymbol(row.symbol);
    const cov = coverageBySymbol[sym] || {};
    const hasData = (cov.candles_count || cov.candles_2m_count || cov.days_covered || 0) > 0;
    return {
      symbol: sym,
      market_group: row.marketGroup || row.group || marketForSymbol(sym),
      enabled: row.enabled !== false,
      paused: row.paused === true,
      has_data: hasData,
      data_status_sv: hasData ? 'Har data' : `${sym} saknar historik för replay`,
      usable_for_replay: cov.usable_for_replay === true,
      usable_for_batch: cov.usable_for_batch === true,
      days_covered: cov.days_covered || 0,
      candles_count: cov.candles_count || cov.candles_2m_count || 0,
      ...SAFETY,
    };
  });
  return { ok: true, symbols, count: symbols.length, selected_symbols: loadConfig().symbols || [], ...SAFETY };
}

function getStrategies() {
  const catalog = daytradingCatalog.getCatalog();
  const perf = strategyPerformance.getStrategyPerformance();
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const runtimeById = Object.fromEntries((runtimeSummary.strategies || []).map((row) => [row.id || row.strategy_id, row]));
  const byId = Object.fromEntries((perf.strategies || []).map((row) => [row.strategy_id, row]));
  // Learning Engine v1 — read-only, fail-safe. Lazy require (undvik circular dep).
  let learnById = {};
  try {
    const learning = require('./daytradingLearningEngineService');
    const summary = learning.getLearningSummary({ hours: 48, limit: 1000 });
    learnById = Object.fromEntries((summary.by_strategy || []).map((row) => [row.key, row]));
  } catch (err) {
    console.warn('[daytrading] learning summary unavailable:', err.message);
  }
  const rows = (catalog.strategies || []).map((strategy) => {
    const p = byId[strategy.id] || {};
    const cfg = strategyConfigFor(strategy.id, strategy);
    const trades = Number(p.trades || 0);
    const runtime = runtimeById[strategy.id] || strategyRuntimeConnector.getRuntimeStatusForStrategy(strategy.id);
    return {
      ...strategy,
      config: cfg,
      status: cfg.status || (cfg.active ? 'Aktiv' : 'Pausad'),
      runtime,
      runtime_status: runtime.runtime_status,
      runtime_label: runtime.runtime_label,
      runtime_raw_signals: runtime.runtime_raw_signals || [],
      connected: runtime.connected === true,
      enabled_by_user: runtime.enabled_by_user === true,
      entry_rule_implemented: runtime.entry_rule_implemented === true,
      paper_trades_48h: runtime.paper_trades_48h || 0,
      last_paper_trade_at: runtime.last_paper_trade_at || null,
      skip_reasons: runtime.skip_reasons || [],
      runtime_comment_sv: runtime.runtime_comment_sv || runtime.comment_sv || null,
      mapping_confidence: runtime.mapping_confidence,
      can_create_paper_trade: runtime.can_create_paper_trade,
      catalog_badges: [
        'Katalog',
        runtime.connected === true ? 'Connected' : null,
        trades ? 'Historisk statistik' : null,
        runtime.runtime_label,
      ].filter(Boolean),
      market_label: MARKET_LABELS[cfg.market] || strategy.market_label || cfg.market,
      win_rate: p.win_rate ?? null,
      avg_pnl: p.avg_pnl ?? null,
      trades,
      latest_signal: p.latest_result?.test_completed_at || p.latest_result?.created_at || null,
      latest_result: p.performance_badge?.label || (trades ? 'Testad' : 'Ingen historik ännu'),
      score: p.score ?? (trades ? 50 : 0),
      needs_more_data: trades < 10 && ((learnById[strategy.id]?.closed || 0) < 20),
      learning_present: Boolean(learnById[strategy.id]),
      learning_summary: learnById[strategy.id]
        ? {
          closed: learnById[strategy.id].closed,
          win_rate: learnById[strategy.id].win_rate,
          avg_pl: learnById[strategy.id].avg_pl,
          total_pl: learnById[strategy.id].total_pl,
          skipped: learnById[strategy.id].skipped,
          top_skip_reason: learnById[strategy.id].top_skip_reason,
          status: learnById[strategy.id].status,
        }
        : null,
      ...SAFETY,
    };
  });
  return { ok: true, strategies: rows, count: rows.length, config: loadConfig(), learning_present: Object.keys(learnById).length > 0, ...SAFETY };
}

function updateStrategy(id, patch = {}) {
  if (patch.live_trading_enabled === true || patch.can_place_orders === true || patch.actions_allowed === true || patch.mode === 'live') {
    return {
      ok: false,
      error: 'Riktig handel är avstängd. Ändringen blockerades av safety.',
      ...SAFETY,
    };
  }
  const strategy = daytradingCatalog.getStrategyById(id);
  if (!strategy) return { ok: false, error: 'Strategin finns inte.', ...SAFETY };

  const allRows = currentScanRows();
  const beforeRows = filterScanRows(allRows, loadConfig());
  const config = loadConfig();
  const current = strategyConfigFor(id, strategy);
  const next = {
    ...current,
    ...patch,
    active: patch.enabled_by_user === undefined && patch.active === undefined
      ? current.active
      : (patch.enabled_by_user ?? patch.active) === true,
    market: normalizeMarket(patch.market || patch.market_group || current.market),
    symbols: safeArray(patch.symbols).map(normalizeSymbol),
    min_score: Math.max(0, Math.min(100, Number(patch.min_score ?? current.min_score) || 0)),
    min_confidence: Math.max(0, Math.min(100, Number(patch.min_confidence ?? current.min_confidence) || 0)),
    timeframe: String(patch.timeframe || current.timeframe || '2m'),
    direction: String(patch.direction || current.direction || 'both'),
    stop_loss: Math.max(0, Number(patch.stop_loss ?? current.stop_loss) || 0),
    take_profit: Math.max(0, Number(patch.take_profit ?? current.take_profit) || 0),
    max_trades: Math.max(1, Number(patch.max_trades ?? current.max_trades) || 1),
    paper_only: true,
    ...SAFETY,
  };
  next.enabled_by_user = next.active === true;
  next.status = next.active ? 'Aktiv' : 'Pausad';
  config.strategies[id] = next;
  saveConfig(config);
  const afterRows = filterScanRows(allRows, { ...config, market: next.market, symbols: next.symbols });
  const impact = writeImpact(beforeRows, afterRows, config, 'strategy_updated');
  auditTrail.logAuditEvent({
    type: 'DAYTRADING_STRATEGY_UPDATED',
    source: 'daytrading_control',
    timestamp: nowIso(),
    strategy_id: id,
    message: `${strategy.name} uppdaterad i testläge`,
    details: { config: next, safety: SAFETY },
  });
  return { ok: true, strategy_id: id, config: next, impact, message_sv: 'Strategin uppdaterad', ...SAFETY };
}

function setAllRuntimeStrategies(enabled) {
  const catalogRows = daytradingCatalog.getCatalog().strategies || [];
  const config = loadConfig();
  for (const strategy of catalogRows) {
    const current = strategyConfigFor(strategy.id, strategy);
    config.strategies[strategy.id] = {
      ...current,
      active: enabled === true,
      enabled_by_user: enabled === true,
      status: enabled === true ? 'Aktiv' : 'Pausad',
      paper_only: true,
      ...SAFETY,
    };
  }
  saveConfig(config);
  auditTrail.logAuditEvent({
    type: enabled ? 'DAYTRADING_RUNTIME_ENABLE_ALL' : 'DAYTRADING_RUNTIME_DISABLE_ALL',
    source: 'daytrading_control',
    timestamp: nowIso(),
    message: enabled ? 'Alla katalogstrategier aktiverade i paper test' : 'Alla katalogstrategier pausade i paper test',
    details: { count: catalogRows.length, enabled_by_user: enabled === true, safety: SAFETY },
  });
  const runtime = getRuntimeStrategies();
  return {
    ok: true,
    message_sv: enabled ? 'Alla strategier är på i paper test.' : 'Alla strategier är pausade i paper test.',
    enabled_by_user: enabled === true,
    runtime,
    strategies: runtime.strategies || [],
    ...SAFETY,
  };
}

function toggleRuntimeStrategy(id) {
  const strategy = daytradingCatalog.getStrategyById(id);
  if (!strategy) return { ok: false, error: 'Strategin finns inte.', ...SAFETY };
  const current = strategyConfigFor(id, strategy);
  return updateStrategy(id, { enabled_by_user: current.enabled_by_user !== true });
}

function updateFilters(patch = {}) {
  const allRows = currentScanRows();
  const beforeRows = filterScanRows(allRows, loadConfig());
  const config = loadConfig();
  config.market = normalizeMarket(patch.market || config.market);
  if (patch.symbols !== undefined) config.symbols = safeArray(patch.symbols).map(normalizeSymbol);
  if (patch.auto_scan !== undefined) config.auto_scan = patch.auto_scan === true;
  saveConfig(config);
  const afterRows = filterScanRows(allRows, config);
  const impact = writeImpact(beforeRows, afterRows, config, 'filters_updated');
  return { ok: true, config, impact, message_sv: 'Filter uppdaterat', ...SAFETY };
}

function runScan(input = {}) {
  const patch = input && typeof input === 'object' ? input : {};
  const config = patch.market || patch.symbols ? updateFilters(patch).config : loadConfig();
  const rows = filterScanRows(currentScanRows(), config);
  const impact = writeImpact([], rows, config, 'scan_run');
  const pipeline = pipelineFromScan(rows, config, 'klar');
  auditTrail.logAuditEvent({
    type: 'DAYTRADING_SCAN_REQUESTED',
    source: 'daytrading_control',
    timestamp: nowIso(),
    message: 'Daytrading-scan körd i testläge',
    details: { market: config.market, symbols: config.symbols, candidates: rows.length, safety: SAFETY },
  });
  return {
    ok: true,
    scan_mode: 'test_reuse_latest_scan',
    message_sv: 'Ny testsökning körd mot senaste scannerdata. Inga riktiga ordrar skickades.',
    last_scan: getScanStatus().lastScan || getCryptoStatus().lastScan || nowIso(),
    candidates: rows.map((row) => ({
      symbol: row.symbol,
      market: row.market_group || row.marketGroup || row.marketType || marketForSymbol(row.symbol),
      strategy: row.strategy_name || row.strategyLabel || row.signalFamily || 'Okänd strategi',
      score: row.tradeScore ?? row.signalScore ?? row.priorityScore ?? row.score ?? null,
      status: simpleSignalStatus(row),
      reason: row.reasonSv || row.reason || row.signal || 'Senaste scan-data',
    })),
    impact,
    pipeline,
    ...SAFETY,
  };
}

function getPipeline() {
  const config = loadConfig();
  const rows = filterScanRows(currentScanRows(), config);
  return { ok: true, updated_at: nowIso(), pipeline: pipelineFromScan(rows, config, 'klar'), ...SAFETY };
}

function normalizeTradeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 500);
}

function numericPnl(value) {
  if (value == null || value === '–') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tradeSummary(rows) {
  const total = rows.length;
  const wins = rows.filter((t) => String(t.result || '').toUpperCase() === 'WIN' || String(t.status || '').toLowerCase().includes('vinst')).length;
  const losses = rows.filter((t) => String(t.result || '').toUpperCase() === 'LOSS' || String(t.status || '').toLowerCase().includes('förlust')).length;
  const timeout = rows.filter((t) => String(t.result || '').toUpperCase() === 'TIMEOUT' || String(t.status || '').toLowerCase().includes('timeout')).length;
  const open = rows.filter((t) => String(t.result || '').toUpperCase() === 'OPEN' || String(t.status || '').toLowerCase().includes('pågående')).length;
  const closed = rows.filter((t) => String(t.result || '').toUpperCase() !== 'OPEN' && !String(t.status || '').toLowerCase().includes('pågående'));
  const pnlValues = rows.map((t) => numericPnl(t.pnl)).filter((v) => v != null);
  const totalPl = pnlValues.reduce((sum, v) => sum + v, 0);
  const longUp = rows.filter((t) => ['UP', 'LONG'].includes(String(t.direction || '').toUpperCase())).length;
  const shortDown = rows.filter((t) => ['DOWN', 'SHORT'].includes(String(t.direction || '').toUpperCase())).length;
  return {
    total,
    wins,
    losses,
    timeout,
    open,
    closed: closed.length,
    win_rate: closed.length ? Math.round((wins / closed.length) * 10000) / 100 : null,
    timeout_rate: total ? Math.round((timeout / total) * 10000) / 100 : null,
    avg_pl: pnlValues.length ? Math.round((totalPl / pnlValues.length) * 100) / 100 : null,
    total_pl: pnlValues.length ? Math.round(totalPl * 100) / 100 : null,
    best_pl: pnlValues.length ? Math.round(Math.max(...pnlValues) * 100) / 100 : null,
    worst_pl: pnlValues.length ? Math.round(Math.min(...pnlValues) * 100) / 100 : null,
    long_up: longUp,
    short_down: shortDown,
  };
}

function firstText(...values) {
  const value = values.find((candidate) => {
    if (Array.isArray(candidate)) return candidate.length > 0;
    return candidate != null && candidate !== '';
  });
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : (value || null);
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signalMarket(row = {}) {
  const market = String(row.marketType || row.market || row.market_group || row.marketGroup || '').toLowerCase();
  if (market) return market;
  const sym = normalizeSymbol(row.symbol);
  if (sym.endsWith('USDT')) return 'crypto';
  return marketForSymbol(sym);
}

function signalSide(row = {}) {
  const raw = String(
    row.side ||
    row.signalSide ||
    row.direction ||
    row.nextMoveBias ||
    row.daytradeDirection ||
    row.signal ||
    '',
  ).toUpperCase();
  if (raw.includes('BUY') || raw.includes('LONG') || raw.includes('UP') || raw.includes('KÖP')) return 'Köp';
  if (raw.includes('SELL') || raw.includes('SHORT') || raw.includes('DOWN') || raw.includes('SÄLJ')) return 'Sälj';
  return 'Vänta';
}

function signalAction(status = '') {
  if (status === 'Redo för paper trade') return 'Skapa paper';
  if (status === 'Öppen paper trade') return 'Följ trade';
  if (status === 'Stängd' || status === 'Timeout') return 'Visa resultat';
  if (status === 'Blockerad') return 'Visa orsak';
  if (status === 'Saknar data') return 'Kontrollera data';
  return 'Väntar';
}

function normalizePaperSignalStatus(row = {}, runtime = {}, paperTrade = null, blocker = null) {
  if (paperTrade?.result === 'OPEN') return 'Öppen paper trade';
  if (paperTrade?.result === 'TIMEOUT') return 'Timeout';
  if (paperTrade && paperTrade.result && paperTrade.result !== 'OPEN') return 'Stängd';
  if (blocker?.blocked) return 'Blockerad';

  const raw = String(row.status || row.daytradeStatus || row.blockerMode || '').toLowerCase();
  if (raw.includes('timeout')) return 'Timeout';
  if (raw.includes('block') || raw.includes('reject')) return 'Blockerad';
  if (raw.includes('wait') || raw.includes('vänta')) return 'Väntar på entry';
  if (raw.includes('missing') || raw.includes('saknar')) return 'Saknar data';

  if (runtime?.runtime_status === 'disabled') return 'Blockerad';
  if (runtime?.runtime_status === 'no_entry_rule') return 'Blockerad';
  if (runtime?.runtime_status === 'partial') return 'Väntar på entry';

  return blocker?.ready ? 'Redo för paper trade' : 'Väntar på entry';
}

function buildPaperSignalBlocker(row = {}, runtime = {}, config = {}) {
  const filters = config.market_control_filters || {};
  const minScore = Number(filters.min_score ?? 0) || 0;
  const minConfidence = Number(filters.min_confidence ?? 0) || 0;
  const score = toFiniteNumber(row.tradeScore ?? row.signalScore ?? row.priorityScore ?? row.score ?? row.daytradeScore ?? null);
  const confidence = toFiniteNumber(row.confidenceScore ?? row.baseConfidenceScore ?? row.confidence ?? null);
  const entry = toFiniteNumber(row.entry ?? row.entryPrice ?? row.price ?? row.currentPrice ?? null);
  const stopLoss = toFiniteNumber(row.stopLoss ?? row.stop_loss ?? row.stopPct ?? row.riskEvaluation?.stop_loss ?? null);
  const takeProfit = toFiniteNumber(row.takeProfit ?? row.take_profit ?? row.targetPct ?? row.riskEvaluation?.take_profit ?? null);
  const riskReward = entry != null && stopLoss != null && takeProfit != null && stopLoss > 0
    ? Math.round((takeProfit / stopLoss) * 100) / 100
    : null;
  const rawStatus = String(row.status || row.daytradeStatus || row.blockerMode || '').toLowerCase();
  const reasons = [];
  const fixes = [];

  if (!row.symbol) {
    reasons.push('data saknas');
    fixes.push('symbol saknas i scannerdata');
  }
  if (runtime?.runtime_status === 'disabled' || row.strategy_paused === true) {
    reasons.push('strategi pausad');
    fixes.push('aktivera strategin i runtime');
  } else if (runtime?.runtime_status === 'no_entry_rule' || runtime?.entry_rule_implemented === false) {
    reasons.push('saknar entry');
    fixes.push('koppla entry-regeln till runtime');
  } else if (runtime?.runtime_status === 'partial') {
    reasons.push('väntar');
    fixes.push('entry-regeln behöver bekräftelse');
  }
  if (score != null && score < minScore) {
    reasons.push('score för låg');
    fixes.push(`kräver score ${minScore}+`);
  }
  if (confidence != null && confidence < minConfidence) {
    reasons.push('confidence för låg');
    fixes.push(`kräver confidence ${minConfidence}%+`);
  }
  if (entry == null) {
    reasons.push('saknar entry');
    fixes.push('vänta på bekräftad entry');
  }
  if (stopLoss == null) {
    reasons.push('saknar stop loss');
    fixes.push('riskprofilen behöver stop loss');
  }
  if (takeProfit == null) {
    reasons.push('saknar take profit');
    fixes.push('riskprofilen behöver take profit');
  }
  if (riskReward != null && riskReward < 1.25) {
    reasons.push('risk/reward för svag');
    fixes.push('kräver bättre risk/reward');
  }
  if (rawStatus.includes('timeout')) {
    reasons.push('timeout');
    fixes.push('signalen hann inte bli bekräftad i tid');
  }
  if (rawStatus.includes('missing') || rawStatus.includes('saknar')) {
    reasons.push('data saknas');
    fixes.push('vänta på komplett scannerdata');
  }
  if (row.marketWarning || row.market_regime === 'blocked' || ['choppy', 'panic', 'extreme'].includes(String(row.marketRegime || '').toLowerCase())) {
    reasons.push('market regime blockerar');
    fixes.push('vänta på lugnare market regime');
  }
  if (row.executionSafety?.blocked === true || row.executionSafety?.can_place_orders === false) {
    reasons.push('safety blocker');
    fixes.push('safety tillåter inte orderläggning');
  }

  const blocked = reasons.some((reason) => reason !== 'väntar');
  const waiting = !blocked && (
    rawStatus.includes('wait') ||
    rawStatus.includes('vänta') ||
    row.signal === 'VÄNTA' ||
    row.signal === 'WAIT' ||
    score == null ||
    confidence == null ||
    entry == null
  );
  const ready = !blocked && !waiting && (
    runtime?.can_create_paper_trade === true ||
    runtime?.runtime_status === 'active' ||
    row.paperTradeCreated === true
  );

  return {
    blocked,
    waiting,
    ready,
    blockerReason: blocked ? reasons[0] : null,
    requiredFix: fixes[0] || null,
    score,
    confidence,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
  };
}

function matchPaperTradeBySignal(row = {}, trades = []) {
  const signalId = row.signalId || row.signal_id || null;
  const symbol = normalizeSymbol(row.symbol);
  const strategyId = row.resolvedStrategyId || row.sourceStrategyId || row.strategy_id || row.strategyId || null;
  const raw = String(row.signalSubtype || row.signal_subtype || row.signalFamily || row.signal || '').toUpperCase();
  return trades.find((trade) => {
    if (signalId && (trade.signalId || trade.signal_id) === signalId) return true;
    if (normalizeSymbol(trade.symbol) !== symbol) return false;
    const tradeStrategyId = trade.resolvedStrategyId || trade.sourceStrategyId || trade.strategy_id || trade.strategyId || null;
    if (strategyId && String(tradeStrategyId || '').toLowerCase() !== String(strategyId).toLowerCase()) return false;
    if (!raw) return true;
    const tradeRaw = String(trade.signalSubtype || trade.signal_subtype || trade.raw_strategy || trade.signalFamily || '').toUpperCase();
    return !tradeRaw || tradeRaw === raw;
  }) || null;
}

function formatPaperTrade(trade = {}) {
  const result = String(trade.result || '').toUpperCase();
  const meta = strategyMetadataOf(trade);
  const status = result === 'OPEN'
    ? 'Öppen paper trade'
    : result === 'TIMEOUT'
      ? 'Timeout'
      : 'Stängd';
  return {
    symbol: trade.symbol || '–',
    market: trade.marketType || trade.market || marketForSymbol(trade.symbol),
    side: signalSide(trade),
    strategy: trade.resolvedStrategyName || trade.strategy_name || trade.strategyName || trade.strategy || trade.raw_strategy || 'Paper-strategi',
    score: toFiniteNumber(trade.confidenceScore ?? trade.tradeScore ?? trade.signalScore ?? trade.priorityScore ?? null),
    confidence: toFiniteNumber(trade.confidenceScore ?? trade.baseConfidenceScore ?? null),
    entry: trade.entryPrice ?? trade.entry ?? null,
    stopLoss: trade.stopPct ?? trade.stop_loss ?? null,
    takeProfit: trade.targetPct ?? trade.take_profit ?? null,
    riskReward: trade.stopPct && trade.targetPct ? Math.round((Number(trade.targetPct) / Number(trade.stopPct)) * 100) / 100 : null,
    status,
    reason: trade.reasonSv || trade.entryReasonSv || trade.exitReason || trade.observeOnlyReasonSv || 'Paper trade',
    blockerReason: null,
    createdAt: trade.opened_at || trade.entryTime || trade.createdAt || trade.timestamp || null,
    openedAt: trade.opened_at || trade.entryTime || trade.createdAt || trade.timestamp || null,
    closedAt: trade.closed_at || trade.exitTime || null,
    pnl: trade.pnlPct ?? trade.unrealizedPct ?? null,
    result,
    tradeId: trade.tradeId || trade.trade_id || trade.id || null,
    sourceStrategyId: meta.sourceStrategyId,
    sourceStrategyName: meta.sourceStrategyName,
    resolvedStrategyId: meta.resolvedStrategyId,
    resolvedStrategyName: meta.resolvedStrategyName,
    mappingSource: meta.mappingSource,
    strategyId: meta.resolvedStrategyId,
  };
}

function formatPaperSignalRow(row = {}, runtime = {}, paperTrade = null, blocker = null) {
  const meta = strategyMetadataOf(row);
  const status = normalizePaperSignalStatus(row, runtime, paperTrade, blocker);
  const score = toFiniteNumber(row.tradeScore ?? row.signalScore ?? row.priorityScore ?? row.score ?? row.daytradeScore ?? null);
  const confidence = toFiniteNumber(row.confidenceScore ?? row.baseConfidenceScore ?? row.confidence ?? null);
  const entry = toFiniteNumber(row.entry ?? row.entryPrice ?? row.price ?? row.currentPrice ?? null);
  const stopLoss = toFiniteNumber(row.stopLoss ?? row.stop_loss ?? row.stopPct ?? row.riskEvaluation?.stop_loss ?? null);
  const takeProfit = toFiniteNumber(row.takeProfit ?? row.take_profit ?? row.targetPct ?? row.riskEvaluation?.take_profit ?? null);
  const riskReward = entry != null && stopLoss != null && takeProfit != null && stopLoss > 0
    ? Math.round((takeProfit / stopLoss) * 100) / 100
    : null;
  const reason = firstText(
    row.reasonSv,
    row.runtime_comment_sv,
    row.actionSv,
    row.daytradeStatus,
    row.signal,
    paperTrade?.reasonSv,
    paperTrade?.entryReasonSv,
    blocker?.blockerReason,
  ) || 'Väntar på signal';
  const createdAt = row.detected_at || row.evaluated_at || row.ts || row.timestamp || row.created_at || row.opened_at || null;
  return {
    symbol: row.symbol || '–',
    market: signalMarket(row),
    side: signalSide(row),
    strategy: row.resolvedStrategyName || row.sourceStrategyName || row.strategy_name || row.strategyName || row.strategyLabel || row.strategy_id || row.strategyId || row.setupId || 'Paper-strategi',
    strategyId: row.strategyId || row.strategy_id || row.setupId || row.resolvedStrategyId || null,
    score,
    confidence,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    status,
    reason,
    blockerReason: blocker?.blockerReason || (status === 'Blockerad' ? firstText(row.wouldHaveBeenBlockedBy, row.reasons, row.warnings, row.blockReason) : null),
    requiredFix: blocker?.requiredFix || null,
    createdAt,
    tradeId: paperTrade?.tradeId || paperTrade?.trade_id || null,
    result: paperTrade?.result || null,
    openAt: paperTrade?.opened_at || paperTrade?.entryTime || null,
    closeAt: paperTrade?.closed_at || paperTrade?.exitTime || null,
    pnl: paperTrade?.pnlPct ?? paperTrade?.unrealizedPct ?? null,
    sourceStrategyId: meta.sourceStrategyId,
    sourceStrategyName: meta.sourceStrategyName,
    strategyId: meta.strategyId || meta.resolvedStrategyId || null,
    resolvedStrategyId: meta.resolvedStrategyId,
    resolvedStrategyName: meta.resolvedStrategyName,
    mappingSource: meta.mappingSource,
  };
}

function getLiveTrades(options = {}) {
  const limit = normalizeTradeLimit(options.limit);
  const allTrades = paperTrading.getTrades().trades || [];
  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  const rows = allTrades
    .map((trade) => {
      const enriched = strategyRuntimeConnector.enrichPaperTradeWithStrategy(trade);
      const market = enriched.marketType || enriched.market || marketForSymbol(enriched.symbol);
      const time = tradeTimestampOf(enriched);
      const openTime = tradeOpenTimestampOf(enriched);
      const exitTime = tradeExitTimestampOf(enriched);
      const result = String(enriched.result || '').toUpperCase();
      const status = tradeStatusLabel(enriched);
      const currentPrice = result === 'OPEN'
        ? (enriched.currentPrice ?? enriched.exitPrice ?? null)
        : (enriched.exitPrice ?? enriched.currentPrice ?? null);
      const pnlPct = enriched.pnlPct ?? enriched.unrealizedPct ?? null;
      const pnlKr = tradePnlKr(enriched);
      const source = result === 'OPEN'
        ? 'open_trade'
        : isoDateOnly(exitTime) === today
          ? 'recent_closed'
          : 'history';
      return {
        time: openTime || time || null,
        symbol: enriched.symbol,
        market,
        strategy: enriched.strategy || enriched.raw_strategy || enriched.signalSubtype || enriched.signalFamily || 'Paper-strategi',
        raw_signal: enriched.raw_strategy || enriched.signal_subtype || enriched.signalSubtype || '–',
        raw_strategy: enriched.raw_strategy || enriched.signal_subtype || enriched.signalSubtype || null,
        signal_subtype: enriched.signal_subtype || enriched.signalSubtype || null,
        strategy_id: enriched.strategy_id || null,
        strategy_name: enriched.strategy_name || null,
        strategy_family: enriched.strategy_family || null,
        catalog_strategy: enriched.strategy_name || 'Ej kopplad',
        catalog_mapping_confidence: enriched.mapping_confidence || 'low',
        catalog_mapping_note: enriched.runtime_comment_sv || null,
        runtime_status: enriched.runtime_status || 'not_connected',
        runtime_label: enriched.runtime_label || null,
        direction: tradeSideLabel(enriched),
        entry: enriched.entryPrice ?? enriched.entry ?? null,
        exit: currentPrice,
        current_price: currentPrice,
        stop_loss: enriched.stopPct ?? enriched.stop_loss ?? null,
        take_profit: enriched.targetPct ?? enriched.take_profit ?? null,
        pnl: pnlPct,
        pnlKr,
        result,
        status,
        confidence: enriched.confidenceScore ?? enriched.baseConfidenceScore ?? null,
        riskPositionSizeSek: enriched.riskPositionSizeSek ?? enriched.riskEvaluation?.position_size_sek ?? null,
        riskPositionUnits: enriched.riskPositionUnits ?? enriched.riskEvaluation?.position_size_units ?? null,
        risk_reason: firstText(enriched.riskBlockReasons, enriched.riskWarnings, enriched.riskEvaluation?.block_reasons, enriched.riskEvaluation?.warnings),
        block_reason: firstText(enriched.safetyBlockReasons, enriched.executionSafety?.paper_block_reasons, enriched.executionSafety?.block_reasons, enriched.observeOnlyReasonSv),
        exit_reason: enriched.exitReason || enriched.exitReasonCode || null,
        duration: enriched.duration_label || null,
        reason: enriched.reasonSv || enriched.exitReason || enriched.signal || enriched.entryReasonSv || 'Paper/test',
        trade_id: enriched.tradeId || enriched.trade_id || enriched.id || '',
        age_minutes: tradeAgeMinutesOf(enriched, nowMs),
        sentToLearning: true,
        source,
        isToday: source !== 'history',
        todayDate: today,
        ...SAFETY,
      };
    })
    .sort((a, b) => sortNewestFirstByTime(a.time || a.trade_id, b.time || b.trade_id));

  const todayOpenTrades = rows.filter((row) => row.result === 'OPEN');
  const todayClosedTrades = rows.filter((row) => row.result !== 'OPEN' && isoDateOnly(row.time || row.closed_at || row.exitTime || row.createdAt) === today);
  const todayTrades = [...todayOpenTrades, ...todayClosedTrades]
    .sort((a, b) => sortNewestFirstByTime(a.time || a.trade_id, b.time || b.trade_id));
  const todayWins = todayClosedTrades.filter((row) => row.result === 'WIN').length;
  const todayLosses = todayClosedTrades.filter((row) => row.result === 'LOSS').length;
  const todayTimeouts = todayClosedTrades.filter((row) => row.result === 'TIMEOUT').length;
  const todayPnLPct = Math.round((todayClosedTrades.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0)) * 100) / 100;
  const todayStats = {
    date: today,
    totalTrades: todayTrades.length,
    openTrades: todayOpenTrades.length,
    closedTrades: todayClosedTrades.length,
    wins: todayWins,
    losses: todayLosses,
    timeouts: todayTimeouts,
    winRate: todayClosedTrades.length ? Math.round((todayWins / todayClosedTrades.length) * 100) : null,
    pnlPercent: todayPnLPct,
    latestTradeAt: todayTrades[0]?.time || null,
    latestClosedTradeAt: todayClosedTrades[0]?.time || null,
  };
  const historicalTrades = rows.filter((row) => row.result !== 'OPEN' && isoDateOnly(row.time || row.closed_at || row.exitTime || row.createdAt) !== today);
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const paperSummary = getPaperTradeSummary48h();
  const summary = tradeSummary(rows);
  return {
    ok: true,
    limit,
    total_available: allTrades.length,
    trades: rows,
    todayTrades,
    todayOpenTrades,
    todayClosedTrades,
    todayStats,
    historicalTrades,
    count: rows.length,
    summary,
    summary_48h: { ...paperSummary, runtime: runtimeSummary.summary },
    runtime_summary: runtimeSummary.summary,
    runtime_strategies: runtimeSummary.strategies,
    stoppage_summary_48h: getPaperStoppageSummary48h(),
    latestTradeAt: rows[0]?.time || null,
    source_of_truth: {
      strategy_control: 'Strategikontroll = katalog + teststatistik + historik',
      candidates_paper: 'Kandidater & paper trades = faktiska paper trades från scanner',
      safety: 'Safety = live trading är avstängt',
      ...SAFETY,
    },
    ...SAFETY,
  };
}

function getPaperSignals(options = {}) {
  const limit = normalizeTradeLimit(options.limit);
  const config = loadConfig();
  const scan = getScanStatus();
  const crypto = getCryptoStatus();
  const allRows = currentScanRows();
  const rows = filterScanRows(allRows, config);
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const runtimeById = Object.fromEntries((runtimeSummary.strategies || []).map((strategy) => [strategy.id || strategy.strategy_id, strategy]));
  const paperStatus = paperTrading.getStatus();
  const tradesData = paperTrading.getTrades();
  const trades = Array.isArray(tradesData.trades) ? tradesData.trades : [];
  const latestScanAt = scan.lastScan || crypto.lastScan || null;
  const freshnessWindowMinutes = 24 * 60;
  const freshnessWindowHours = 24;
  const nowMs = Date.now();
  const recentCandidates = candidateLog.loadRecent(100);

  const scanSignals = rows
    .map((row) => {
      const enrichedRow = strategyRuntimeConnector.enrichSignalWithStrategy(row);
      const metadata = strategyRuntimeConnector.resolveStrategyMetadata(enrichedRow, { allowLegacyFallback: false }) || {};
      const resolvedStrategyId = metadata.resolvedStrategyId || enrichedRow.strategy_id || enrichedRow.strategyId || null;
      const runtime = runtimeById[resolvedStrategyId] || (resolvedStrategyId ? strategyRuntimeConnector.getRuntimeStatusForStrategy(resolvedStrategyId) : {}) || {};
      const paperTrade = matchPaperTradeBySignal(enrichedRow, trades);
      const blocker = buildPaperSignalBlocker(enrichedRow, runtime, config, paperStatus);
      const signal = formatPaperSignalRow({
        ...row,
        ...enrichedRow,
        sourceStrategyId: metadata.sourceStrategyId,
        sourceStrategyName: metadata.sourceStrategyName,
        resolvedStrategyId,
        resolvedStrategyName: metadata.resolvedStrategyName || runtime?.strategy_name || null,
        mappingSource: metadata.mappingSource,
      }, runtime, paperTrade, blocker);
      const signalTimestamp = paperSignalTimeOf(row) || paperSignalTimeOf(signal) || latestScanAt;
      const signalAgeMinutes = minutesSince(signalTimestamp, nowMs);
      const isFresh = signalAgeMinutes != null && signalAgeMinutes <= freshnessWindowMinutes;
      return {
        ...signal,
        createdAt: signalTimestamp,
        signalTimestamp,
        signalAgeMinutes,
        freshnessWindow: freshnessWindowMinutes,
        isFresh,
        source: isFresh ? 'latest_scan' : 'history',
        status: isFresh ? signal.status : 'Inaktuell',
      };
    })
    .sort((a, b) => {
      const aTime = new Date(a.signalTimestamp || a.createdAt || 0).getTime() || 0;
      const bTime = new Date(b.signalTimestamp || b.createdAt || 0).getTime() || 0;
      if (aTime !== bTime) return bTime - aTime;
      return Number(b.score ?? 0) - Number(a.score ?? 0);
    });

  const currentSignals = scanSignals.filter((signal) => signal.isFresh === true).slice(0, limit);
  const historySignals = scanSignals
    .filter((signal) => signal.isFresh !== true)
    .map((signal) => ({ ...signal, status: 'Inaktuell', source: 'history' }))
    .slice(0, limit);

  const openTrades = trades
    .filter((trade) => String(trade.result || '').toUpperCase() === 'OPEN')
    .map((trade) => {
      const formatted = formatPaperTrade(trade);
      const tradeTimestamp = paperTradeTimeOf(trade) || formatted.createdAt || formatted.openedAt || null;
      const signalAgeMinutes = minutesSince(tradeTimestamp, nowMs);
      return {
        ...formatted,
        createdAt: tradeTimestamp,
        tradeTimestamp,
        signalAgeMinutes,
        freshnessWindow: freshnessWindowMinutes,
        isFresh: true,
        source: 'open_trade',
      };
    })
    .sort((a, b) => sortNewestFirstByTime(a.createdAt || a.tradeTimestamp, b.createdAt || b.tradeTimestamp));

  const closedTrades = trades
    .filter((trade) => String(trade.result || '').toUpperCase() !== 'OPEN')
    .map((trade) => {
      const formatted = formatPaperTrade(trade);
      const tradeTimestamp = paperTradeTimeOf(trade) || formatted.closeAt || formatted.createdAt || null;
      const signalAgeMinutes = minutesSince(tradeTimestamp, nowMs);
      const isFresh = signalAgeMinutes != null && signalAgeMinutes <= freshnessWindowMinutes;
      return {
        ...formatted,
        createdAt: tradeTimestamp,
        tradeTimestamp,
        signalAgeMinutes,
        freshnessWindow: freshnessWindowMinutes,
        isFresh,
        source: isFresh ? 'recent_closed' : 'history',
        status: 'Historik',
      };
    })
    .sort((a, b) => sortNewestFirstByTime(a.createdAt || a.tradeTimestamp, b.createdAt || b.tradeTimestamp));

  const recentClosedTrades = closedTrades.filter((trade) => trade.source === 'recent_closed').slice(0, limit);
  const historicClosedTrades = closedTrades.filter((trade) => trade.source === 'history').slice(0, limit);
  const history = [
    ...historySignals,
    ...recentClosedTrades,
    ...historicClosedTrades,
  ].sort((a, b) => sortNewestFirstByTime(
    a.signalTimestamp || a.tradeTimestamp || a.createdAt,
    b.signalTimestamp || b.tradeTimestamp || b.createdAt,
  )).slice(0, limit);

  const readySignals = currentSignals.filter((signal) => signal.status === 'Redo för paper trade').length;
  const blockedSignals = currentSignals.filter((signal) => signal.status === 'Blockerad').length;
  const waitingSignals = currentSignals.filter((signal) => signal.status === 'Väntar på entry').length;
  const openPaperTrades = openTrades.length;
  const closedPaperTrades = closedTrades.length;

  const blockedFromSignals = currentSignals
    .filter((signal) => signal.status === 'Blockerad')
    .map((signal) => ({
      symbol: signal.symbol,
      strategy: signal.strategy,
      score: signal.score,
      reason: signal.blockerReason || signal.reason || 'Blockerad',
      requiredFix: signal.requiredFix || signal.reason || 'Kontrollera signalen',
    }))
    .slice(0, 5);

  const blockedFromCandidates = recentCandidates
    .filter((candidate) => Array.isArray(candidate.wouldHaveBeenBlockedBy) || Array.isArray(candidate.reasons) || Array.isArray(candidate.warnings))
    .map((candidate) => {
      const reason = firstText(candidate.wouldHaveBeenBlockedBy, candidate.reasons, candidate.warnings, candidate.blockerMode, candidate.status) || 'Blockerad';
      const score = toFiniteNumber(candidate.tradeScore ?? candidate.signalScore ?? candidate.priorityScore ?? candidate.score ?? candidate.confidenceScore ?? null);
      const meta = strategyMetadataOf(candidate);
      return {
        symbol: candidate.symbol || '–',
        strategy: candidate.resolvedStrategyName || candidate.strategyName || candidate.strategy_name || candidate.setupId || 'Okänd strategi',
        score,
        reason,
        requiredFix: firstText(candidate.blockerMode, candidate.exitProfile, candidate.discoveryMode, candidate.signal) || 'Kontrollera kandidatens regler',
        sourceStrategyId: meta.sourceStrategyId,
        resolvedStrategyId: meta.resolvedStrategyId,
        mappingSource: meta.mappingSource,
      };
    })
    .filter((row) => row.reason)
    .slice(0, 5);

  const blocked = blockedFromSignals.length > 0 ? blockedFromSignals : blockedFromCandidates;
  const lastScanAt = latestScanAt || currentSignals[0]?.createdAt || recentCandidates[0]?.created_at || recentCandidates[0]?.evaluated_at || null;
  const candidatesChecked = rows.length;
  const readyOrOpenCount = readySignals + openPaperTrades;
  const paperTradingEnabled = paperStatus.enabled === true;
  const generatedAt = nowIso();
  const freshnessWindow = {
    minutes: freshnessWindowMinutes,
    hours: freshnessWindowHours,
    label: '24h',
  };

  return {
    ok: true,
    generatedAt,
    freshnessWindow,
    latestScanAt,
    safety: {
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
    },
    status: {
      paperTradingEnabled,
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      lastScanAt,
      candidatesChecked,
      readySignals,
      blockedSignals,
      waitingSignals,
      openPaperTrades,
      closedPaperTrades,
      totalSignals: currentSignals.length,
      freshSignals: currentSignals.length,
      historySignals: history.length,
      readyOrOpenCount,
    },
    signals: currentSignals,
    history,
    blocked,
    openTrades,
    closedTrades: recentClosedTrades,
    emptyState: {
      lastScanAt,
      candidatesChecked,
      blockedSignals,
      waitingSignals,
      topBlockedCandidates: blocked.slice(0, 5),
      hasFreshSignals: currentSignals.length > 0,
      waitingFor: paperTradingEnabled
        ? (currentSignals.length > 0
          ? 'Systemet har färska paper trading-köpsignaler.'
          : 'Inga färska paper trading-köpsignaler just nu. Väntar på nästa scan eller nya kandidater inom 24h.')
        : 'Paper trading är avstängt. Slå på paper trading för att skapa öppna paper trades.',
    },
    ...SAFETY,
  };
}

function getRuntimeStrategies() {
  const runtime = strategyRuntimeConnector.getStrategyRuntimeSummary();
  return {
    ...runtime,
    strategies: (runtime.strategies || []).map((strategy) => ({
      ...strategy,
      config: strategyConfigFor(strategy.id || strategy.strategy_id, strategy),
    })),
    ...SAFETY,
  };
}

function getPaperStrategyDiagnostics() {
  const generatedAt = nowIso();
  const today = generatedAt.slice(0, 10);
  const catalog = daytradingCatalog.getCatalog();
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const runtimeRows = Array.isArray(runtimeSummary.strategies) ? runtimeSummary.strategies : [];
  const runtimeById = Object.fromEntries(runtimeRows.map((row) => [String(row.id || row.strategy_id || ''), row]));
  const runtimeIndex = buildStrategyIndex(runtimeRows);
  const catalogIndex = buildStrategyIndex(catalog.strategies || []);
  const paperSignals = getPaperSignals({ limit: 200 });
  const tradesData = paperTrading.getTrades();
  const allTrades = Array.isArray(tradesData.trades) ? tradesData.trades : [];
  const recentCandidates = candidateLog.loadRecent(100);
  const normalizedRecentCandidates = recentCandidates.map((candidate) => {
    const resolved = resolveStrategyRow(candidate, catalogIndex) || resolveStrategyRow(candidate, runtimeIndex) || null;
    const strategyId = resolved?.id || candidate.strategyId || candidate.strategy_id || candidate.setupId || null;
    const strategyName = resolved?.name || candidate.strategyName || candidate.strategy_name || strategyId || 'Okänd strategi';
    const blocked = Array.isArray(candidate.wouldHaveBeenBlockedBy) || Array.isArray(candidate.reasons) || Array.isArray(candidate.warnings)
      ? (candidate.paperTradeCreated !== true)
      : candidate.paperTradeCreated !== true && String(candidate.signal || candidate.blockerMode || '').trim() !== '';
    return {
      ts: candidate.ts || candidate.detected_at || candidate.evaluated_at || null,
      strategy_id: strategyId,
      strategy_name: strategyName,
      market_group: candidate.marketGroup || candidate.market_group || null,
      signal: candidate.signal || null,
      blockerMode: candidate.blockerMode || null,
      discoveryMode: candidate.discoveryMode || null,
      score: candidate.score ?? null,
      paperTradeCreated: candidate.paperTradeCreated === true,
      blocked,
      reasons: Array.isArray(candidate.reasons) ? candidate.reasons : [],
      warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
      wouldHaveBeenBlockedBy: Array.isArray(candidate.wouldHaveBeenBlockedBy) ? candidate.wouldHaveBeenBlockedBy : [],
      setupId: candidate.setupId || null,
      inferred_strategy_id: strategyId,
      inferred_strategy_name: strategyName,
    };
  });

  const strategyRows = (catalog.strategies || []).map((strategy) => {
    const runtime = runtimeById[strategy.id] || strategyRuntimeConnector.getRuntimeStatusForStrategy(strategy.id);
    const id = strategy.id;
    const normalizedId = String(id);
    const strategyTrades = allTrades
      .map((trade) => {
        const resolved = trade.strategy_id || trade.strategyId || resolveStrategyRow(trade, catalogIndex)?.id || resolveStrategyRow(trade, runtimeIndex)?.id || null;
        return resolved ? { ...trade, strategy_id: resolved } : trade;
      })
      .filter((trade) => String(trade.strategy_id || '') === normalizedId);
    const strategyCandidates = normalizedRecentCandidates.filter((candidate) => String(candidate.strategy_id || '') === normalizedId);
    const blockedCandidates = strategyCandidates.filter((candidate) => candidate.blocked === true);
    const todayTrades = strategyTrades.filter((trade) => String(trade.result || '').toUpperCase() === 'OPEN' || isoDateOnly(tradeTimestampOf(trade)) === today);
    const wins = strategyTrades.filter((trade) => String(trade.result || '').toUpperCase() === 'WIN').length;
    const losses = strategyTrades.filter((trade) => String(trade.result || '').toUpperCase() === 'LOSS').length;
    const timeouts = strategyTrades.filter((trade) => String(trade.result || '').toUpperCase() === 'TIMEOUT').length;
    const firstTradeAt = strategyTrades.map((trade) => tradeTimestampOf(trade)).filter(Boolean).sort()[0] || null;
    const lastTradeAt = strategyTrades.map((trade) => tradeTimestampOf(trade)).filter(Boolean).sort().slice(-1)[0] || null;
    const firstCandidateAt = strategyCandidates.map((candidate) => candidate.ts).filter(Boolean).sort()[0] || null;
    const lastCandidateAt = strategyCandidates.map((candidate) => candidate.ts).filter(Boolean).sort().slice(-1)[0] || null;
    const blockerCounts = countBy(blockedCandidates.flatMap((candidate) => [...candidate.wouldHaveBeenBlockedBy, ...candidate.reasons, ...candidate.warnings]), (reason) => String(reason || '').trim());
    const blockerTop = [...blockerCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3);
    return {
      id,
      name: strategyDiagnosticLabel(strategy),
      market_group: strategy.market_group || strategy.market || null,
      enabled_by_user: runtime?.enabled_by_user === true,
      active: strategy.active !== false,
      narrow_state_data_present: runtime?.narrow_state_data_present === true,
      runtime_status_before: runtime?.runtime_status_before || runtime?.runtime_status || 'not_connected',
      runtime_status_after: runtime?.runtime_status_after || runtime?.runtime_status || 'not_connected',
      runtime_status: runtime?.runtime_status || 'not_connected',
      runtime_label: runtime?.runtime_label || null,
      connected: runtime?.connected === true,
      entry_rule_implemented: strategyHasEntryRule(strategy, runtime),
      exit_rule_implemented: strategyHasExitRule(strategy),
      missing_market_group: !(strategy.market_group || strategy.market),
      missing_entry_rule: strategyHasEntryRule(strategy, runtime) !== true,
      missing_exit_rule: strategyHasExitRule(strategy) !== true,
      can_create_paper_trade: runtime?.can_create_paper_trade === true,
      paper_trades_total: strategyTrades.length,
      paper_trades_today: todayTrades.length,
      wins,
      losses,
      timeouts,
      first_trade_at: firstTradeAt,
      last_trade_at: lastTradeAt,
      first_candidate_at: firstCandidateAt,
      last_candidate_at: lastCandidateAt,
      signals_seen: strategyCandidates.length,
      blocked_candidates: blockedCandidates.length,
      blocker_reasons: blockerTop,
      raw_signals: Array.from(new Set([
        ...(runtime?.runtime_raw_signals || []),
        ...strategyCandidates.map((candidate) => candidate.signal).filter(Boolean),
      ])),
      ...SAFETY,
    };
  });

  const tradedStrategies = strategyRows
    .filter((row) => row.paper_trades_total > 0)
    .map((row) => ({
      id: row.id,
      name: row.name,
      paper_trades_today: row.paper_trades_today,
      paper_trades_total: row.paper_trades_total,
      wins: row.wins,
      losses: row.losses,
      timeouts: row.timeouts,
      first_trade_at: row.first_trade_at,
      last_trade_at: row.last_trade_at,
      runtime_status: row.runtime_status,
      enabled_by_user: row.enabled_by_user,
      can_create_paper_trade: row.can_create_paper_trade,
      ...SAFETY,
    }))
    .sort((a, b) => (b.paper_trades_total || 0) - (a.paper_trades_total || 0));

  const blockedStrategyMap = new Map();
  for (const candidate of normalizedRecentCandidates) {
    if (!candidate.blocked || !candidate.strategy_id) continue;
    const key = candidate.strategy_id;
    const existing = blockedStrategyMap.get(key) || {
      id: candidate.strategy_id,
      name: candidate.strategy_name,
      blocked_count: 0,
      first_blocked_at: null,
      last_blocked_at: null,
      top_reasons: new Map(),
      recent_candidates: [],
    };
    existing.blocked_count += 1;
    if (!existing.first_blocked_at || String(candidate.ts || '') < String(existing.first_blocked_at || '')) existing.first_blocked_at = candidate.ts || null;
    if (!existing.last_blocked_at || String(candidate.ts || '') > String(existing.last_blocked_at || '')) existing.last_blocked_at = candidate.ts || null;
    const reasons = [...candidate.wouldHaveBeenBlockedBy, ...candidate.reasons, ...candidate.warnings].map((reason) => String(reason || '').trim()).filter(Boolean);
    for (const reason of reasons) existing.top_reasons.set(reason, (existing.top_reasons.get(reason) || 0) + 1);
    existing.recent_candidates.push(candidate);
    blockedStrategyMap.set(key, existing);
  }

  const blockedStrategies = [...blockedStrategyMap.values()]
    .map((row) => attachStrategyFlowStopDetails({
      id: row.id,
      name: row.name,
      blocked_count: row.blocked_count,
      first_blocked_at: row.first_blocked_at,
      last_blocked_at: row.last_blocked_at,
      top_reasons: [...row.top_reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      ...SAFETY,
    }))
    .sort((a, b) => (b.blocked_count || 0) - (a.blocked_count || 0));

  const strategySignalSet = new Set([
    ...strategyRows.filter((row) => row.signals_seen > 0 || row.paper_trades_total > 0).map((row) => row.id),
  ]);
  const strategyTradeSet = new Set(tradedStrategies.map((row) => row.id));
  const strategyBlockedSet = new Set(blockedStrategies.map((row) => row.id));
  const enabledStrategies = strategyRows.filter((row) => row.enabled_by_user === true);
  const neverTriggeredStrategies = enabledStrategies
    .filter((row) => !strategySignalSet.has(row.id) && !strategyTradeSet.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      market_group: row.market_group,
      runtime_status: row.runtime_status,
      enabled_by_user: row.enabled_by_user,
      ...SAFETY,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const blockerReasonMap = new Map();
  for (const candidate of normalizedRecentCandidates) {
    const reasons = [...candidate.wouldHaveBeenBlockedBy, ...candidate.reasons, ...candidate.warnings]
      .map((reason) => String(reason || '').trim())
      .filter(Boolean);
    for (const reason of reasons) {
      const key = reason;
      const row = blockerReasonMap.get(key) || { reason, count: 0, strategies: new Set() };
      row.count += 1;
      if (candidate.strategy_id) row.strategies.add(candidate.strategy_id);
      blockerReasonMap.set(key, row);
    }
  }

  const blockerReasons = [...blockerReasonMap.values()]
    .map((row) => ({
      reason: row.reason,
      count: row.count,
      strategies: Array.from(row.strategies),
      ...SAFETY,
    }))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 20);

  const allStrategies = strategyRows.map((row) => ({
    id: row.id,
    name: row.name,
    market_group: row.market_group,
    active: row.active !== false,
    enabled_by_user: row.enabled_by_user === true,
    runtime_status: row.runtime_status,
    runtime_label: row.runtime_label,
    connected: row.connected === true,
    entry_rule_implemented: row.entry_rule_implemented === true,
    exit_rule_implemented: row.exit_rule_implemented === true,
    missing_market_group: row.missing_market_group === true,
    missing_entry_rule: row.missing_entry_rule === true,
    missing_exit_rule: row.missing_exit_rule === true,
    paper_trades_total: row.paper_trades_total,
    paper_trades_today: row.paper_trades_today,
    signals_seen: row.signals_seen,
    blocked_candidates: row.blocked_candidates,
    can_create_paper_trade: row.can_create_paper_trade === true,
    ...SAFETY,
  }));

  return {
    ok: true,
    generatedAt,
    safety: SAFETY,
    summary: {
      totalStrategies: allStrategies.length,
      enabledStrategies: enabledStrategies.length,
      strategiesWithPaperTrades: tradedStrategies.length,
      strategiesWithSignals: strategyRows.filter((row) => row.signals_seen > 0 || row.paper_trades_total > 0).length,
      strategiesBlocked: blockedStrategies.length,
      strategiesNeverTriggered: neverTriggeredStrategies.length,
    },
    strategies: allStrategies,
    tradedStrategies,
    blockedStrategies,
    neverTriggeredStrategies,
    blockerReasons,
    recentCandidates: normalizedRecentCandidates,
    paperSignals: {
      latestScanAt: paperSignals.latestScanAt || null,
      currentSignals: Array.isArray(paperSignals.signals) ? paperSignals.signals.length : 0,
      historySignals: Array.isArray(paperSignals.history) ? paperSignals.history.length : 0,
    },
    paperTradesToday: {
      today: today,
      total: (paperTrading.getTrades().trades || []).filter((trade) => isoDateOnly(tradeTimestampOf(trade)) === today).length,
    },
    ...SAFETY,
  };
}

const FLOW_ELIGIBILITY_EVENT_TYPES = new Set([
  'GATE_ALLOWED',
  'GATE_BLOCKED',
  'GATE_OBSERVE_ONLY',
  'TRADE_OPENED',
  'TRADE_SKIPPED',
]);

const TRADE_ENTRY_BLOCK_REASON_KEYS = Object.freeze([
  'signaltype_not_allowed',
  'market_closed',
  'unclear_direction',
  'wait_status',
  'gate_blocked',
  'other',
]);

function flowTimestampOf(row = {}) {
  return toIsoIfValid(
    row.timestamp ||
    row.ts ||
    row.detected_at ||
    row.evaluated_at ||
    row.created_at ||
    row.createdAt ||
    row.entryTime ||
    row.opened_at ||
    row.closed_at ||
    row.last_update_at ||
    null,
  );
}

function flowSignalTypeOf(row = {}) {
  return row.signalSubtype ||
    row.signal_subtype ||
    row.raw_strategy ||
    row.signalFamily ||
    row.signal_family ||
    row.signal ||
    row.eventType ||
    row.type ||
    null;
}

function flowScoreOf(row = {}) {
  return toFiniteNumber(
    row.score ??
    row.tradeScore ??
    row.signalScore ??
    row.priorityScore ??
    row.daytradeScore ??
    row.gateScore ??
    row.confidenceScore ??
    null,
  );
}

function flowConfidenceOf(row = {}) {
  return toFiniteNumber(row.confidenceScore ?? row.baseConfidenceScore ?? row.confidence ?? null);
}

function flowReasonOf(row = {}) {
  return firstText(
    row.reasonSv,
    row.reason,
    row.blockerMode,
    row.discoveryMode,
    row.observeOnlyReasonSv,
    row.skip_reason_sv,
    row.runtime_comment_sv,
    row.comment_sv,
  ) || null;
}

function flowEventTypeOf(row = {}) {
  return String(
    row.eventType ||
    row.type ||
    row.decision ||
    row.status ||
    row.raw?.type ||
    row.raw?.decision ||
    row.raw?.status ||
    '',
  ).toUpperCase();
}

function tradeEntryBlockReasonOf(row = {}, runtime = {}) {
  if (String(row.source || '').toLowerCase() !== 'paper_event') return null;

  const reason = String(flowReasonOf(row) || '').toLowerCase();
  const status = String(row.status || row.runtimeStatus || runtime.runtime_status || row.raw?.status || '').toLowerCase();
  const eventType = flowEventTypeOf(row);
  const nextMoveBias = String(row.raw?.nextMoveBias || row.nextMoveBias || '').toUpperCase();

  if (
    eventType === 'GATE_BLOCKED' ||
    reason.includes('gate blockerad') ||
    reason.includes('market gate blockerade')
  ) {
    return 'gate_blocked';
  }

  if (
    eventType === 'MARKET_CLOSED' ||
    reason.includes('marknaden är stängd') ||
    reason.includes('market closed') ||
    String(row.dataFreshness || row.raw?.dataFreshness || '').toUpperCase() === 'MARKET_CLOSED'
  ) {
    return 'market_closed';
  }

  if (
    reason.includes('riktningen var oklar') ||
    reason.includes('direction unclear') ||
    nextMoveBias === 'UNCERTAIN'
  ) {
    return 'unclear_direction';
  }

  if (
    status === 'wait' ||
    (reason.includes('status var') && reason.includes('vänta')) ||
    reason.includes('wait')
  ) {
    return 'wait_status';
  }

  if (
    reason.includes('signaltypen är inte godkänd') ||
    reason.includes('signalfamily=') ||
    reason.includes('subtype not allowed') ||
    reason.includes('saknar entry-regel') ||
    reason.includes('runtime-mapping kunde inte läsas') ||
    reason.includes('signalen är inte kopplad till katalogstrategi') ||
    reason.includes('strategin är avstängd av användaren') ||
    reason.includes('strategin är pausad i paper-runtime')
  ) {
    return 'signaltype_not_allowed';
  }

  if (
    eventType === 'TRADE_SKIPPED' ||
    eventType === 'MAX_TRADES_REACHED' ||
    eventType === 'MARKET_CLOSED' ||
    eventType === 'GATE_BLOCKED' ||
    /skippad|blocked|blockerad|market closed|wait|vänta|uncertain|oklar/.test(reason) ||
    /skip|block|wait|closed/.test(status)
  ) {
    return 'other';
  }

  return null;
}

function createTradeEntryReasonBreakdown() {
  return TRADE_ENTRY_BLOCK_REASON_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
}

function tradeEntryReasonBreakdownFromMap(counts = new Map()) {
  const breakdown = createTradeEntryReasonBreakdown();
  for (const [reason, count] of counts.entries()) {
    if (Object.prototype.hasOwnProperty.call(breakdown, reason)) breakdown[reason] += count;
    else breakdown.other += count;
  }
  return breakdown;
}

function isMissingStrategyIdNoise(row = {}) {
  const signalType = String(row.signalType || '').toUpperCase();
  const signalSubtype = String(row.signalSubtype || row.signal_subtype || '').toUpperCase();
  const reason = String(row.reason || '').toLowerCase();
  const source = String(row.source || '').toLowerCase();
  const hasResolvedExplicit = row.resolvedStrategyId != null && row.mappingSource === 'explicit';
  const isSystemWait =
    signalType === 'NO_TRADE' ||
    signalSubtype === 'NO_TRADE' ||
    signalType === 'NARROW_WAIT' ||
    signalSubtype === 'NARROW_WAIT';
  const isPaperEventWait =
    source === 'paper_event' &&
    String(row.status || '').toLowerCase() === 'wait' &&
    reason.includes('skippad') &&
    row.strategyId == null &&
    row.resolvedStrategyId == null;

  return hasResolvedExplicit || isSystemWait || isPaperEventWait;
}

function flowExamples(rows = [], limit = 3) {
  return rows
    .slice(0, limit)
    .map((row) => ({
      ts: row.ts || row.timestamp || null,
      source: row.source || null,
      symbol: row.symbol || null,
      signalType: row.signalType || null,
      score: row.score ?? null,
      confidence: row.confidence ?? null,
      status: row.status || null,
      reason: row.reason || null,
      strategyIdMissing: row.sourceStrategyId == null,
      sourceStrategyId: row.sourceStrategyId || null,
      resolvedStrategyId: row.resolvedStrategyId || null,
      resolvedStrategyName: row.resolvedStrategyName || null,
      mappingSource: row.mappingSource || 'unknown',
    }));
}

function categorizeFlowDropReason(rawReason, row = {}, runtime = {}) {
  const reason = String(rawReason || '').toLowerCase();
  const status = String(row.status || row.runtimeStatus || runtime.runtime_status || '').toLowerCase();

  if (!reason && !status) return 'other';
  if (/duplicate signalid|duplicate/i.test(reason) || /duplicate/i.test(status) || /cooldown/i.test(reason)) return 'duplicate/cooldown';
  if (/cooldown/i.test(reason) || /already open for symbol/i.test(reason)) return 'duplicate/cooldown';
  if (/market group|market closed|marketcontrol|market control|market.*disabled/.test(reason) || /market/.test(status) && /closed|disabled/.test(status)) return 'market group';
  if (/missing entry|saknar entry|entry.*saknas|no entry/.test(reason)) return 'missing entry';
  if (/missing stop|saknar stop|stop loss/.test(reason)) return 'missing stop loss';
  if (/missing take profit|saknar take profit|take profit/.test(reason)) return 'missing take profit';
  if (/score|min score/.test(reason)) return 'score';
  if (/confidence/.test(reason)) return 'confidence';
  if (/runtime|paused|disabled|no_entry_rule|partial|missing_data|not_connected/.test(reason) || /disabled|partial|paused|no_entry_rule/.test(status)) return 'runtime';
  if (/risk|safety/.test(reason) || /risk|safety/.test(status)) return 'risk/safety';
  if (/entry|waiting|wait|vänta/.test(reason) || /wait|vänta/.test(status)) return 'waiting';
  return 'other';
}

const STRATEGY_FLOW_STOP_DETAILS = Object.freeze({
  vwap_volume_breakout_long: Object.freeze({
    firstStopStage: 'test_rules',
    firstStopFunction: 'evaluateTestRules',
    firstStopCondition: 'score >= 35 failed',
    firstStopReason: 'Testregler stoppade strategin eftersom score inte nådde 35.',
    requiredFix: 'vänta på starkare signal eller justera test-threshold senare',
  }),
  vwap_failed_breakout_short: Object.freeze({
    firstStopStage: 'market_gate',
    firstStopFunction: 'marketGate',
    firstStopCondition: 'finalScore >= threshold failed',
    firstStopReason: 'Market gate stoppade short-strategin eftersom finalScore inte nådde tröskeln.',
    requiredFix: 'analysera marketGate threshold för short stocks separat',
  }),
  narrow_breakout: Object.freeze({
    firstStopStage: 'runtime_data',
    firstStopFunction: 'runtimeData',
    firstStopCondition: 'narrow_state_data missing',
    firstStopReason: 'Runtime-data saknar narrow_state_data, så strategin kan inte bedömas fullt.',
    requiredFix: 'koppla narrowState-data till runtime status',
  }),
  narrow_state_expansion_long: Object.freeze({
    firstStopStage: 'runtime_data',
    firstStopFunction: 'runtimeData',
    firstStopCondition: 'narrow_state_data missing',
    firstStopReason: 'Runtime-data saknar narrow_state_data, så strategin kan inte bedömas fullt.',
    requiredFix: 'koppla narrowState-data till runtime status',
  }),
});

const NARROW_DYNAMIC_STOP_STRATEGY_IDS = new Set([
  'narrow_breakout',
  'narrow_state_expansion_long',
  'narrow_state_fakeout_reversal',
]);

function strategyFlowStopDetails(strategyId) {
  return STRATEGY_FLOW_STOP_DETAILS[String(strategyId || '').trim()] || null;
}

function dynamicNarrowFlowStopDetails(row = {}) {
  const strategyId = String(row.strategyId || row.id || '').trim();
  if (!NARROW_DYNAMIC_STOP_STRATEGY_IDS.has(strategyId)) return null;

  const runtimeStatusAfter = row.runtimeStatusAfter || row.runtimeStatus || null;
  const narrowStateDataPresent = row.narrowStateDataPresent === true;

  if (runtimeStatusAfter !== 'active' || narrowStateDataPresent !== true) {
    return {
      firstStopStage: 'runtime_data',
      firstStopFunction: 'runtimeData',
      firstStopCondition: 'narrow_state_data missing',
      firstStopReason: 'Runtime-data saknar narrow_state_data, så strategin kan inte bedömas fullt.',
      requiredFix: 'koppla narrowState-data till runtime status',
    };
  }

  const candidateCount = Number(row.candidateCount || 0);
  const reachedPaperEligibility = Number(row.reachedPaperEligibility || 0);

  if (candidateCount === 0) {
    return {
      firstStopStage: 'signal_window',
      firstStopFunction: 'signalWindow',
      firstStopCondition: 'candidateCount === 0',
      firstStopReason: 'Ingen färsk narrow-kandidat i aktuellt fönster.',
      requiredFix: 'Vänta på ny narrow-signal eller bredda scannerfönstret.',
    };
  }

  if (reachedPaperEligibility === 0) {
    return {
      firstStopStage: 'paper_eligibility',
      firstStopFunction: 'paperEligibility',
      firstStopCondition: 'reachedPaperEligibility === 0',
      firstStopReason: 'Narrow-kandidat finns men når inte paper eligibility i aktuellt fönster.',
      requiredFix: 'Analysera gate/test-regler för narrow-signaler.',
    };
  }

  return null;
}

function attachStrategyFlowStopDetails(row = {}) {
  const details = strategyFlowStopDetails(row.strategyId || row.id);
  return details ? { ...row, ...details } : { ...row };
}

function normalizeFlowRow(row = {}, source = 'unknown', catalogIndex = null, runtimeIndex = null) {
  const metadata = strategyRuntimeConnector.resolveStrategyMetadata(row, { allowLegacyFallback: source !== 'paper_event' }) || {};
  const resolved = resolveStrategyRow(row, catalogIndex || {}, { allowInference: false }) || resolveStrategyRow(row, runtimeIndex || {}, { allowInference: false }) || null;
  const sourceStrategyId = metadata.sourceStrategyId || null;
  const sourceStrategyName = metadata.sourceStrategyName || row.strategyName || row.strategy_name || null;
  const strategyId = metadata.strategyId || metadata.resolvedStrategyId || row.strategyId || row.strategy_id || row.setupId || resolved?.id || null;
  const strategyName = metadata.resolvedStrategyName || sourceStrategyName || resolved?.name || strategyId || 'Okänd strategi';
  const signalType = flowSignalTypeOf(row);
  const ts = flowTimestampOf(row);
  const score = flowScoreOf(row);
  const confidence = flowConfidenceOf(row);
  const reason = flowReasonOf(row);
  const status = row.status || row.decision || row.blockerMode || row.discoveryMode || row.runtimeStatus || row.type || null;
  const eligible = source === 'paper_event' && FLOW_ELIGIBILITY_EVENT_TYPES.has(String(row.type || '').toUpperCase());
  const blocked = Boolean(
    row.blocked === true ||
    row.paperTradeCreated === false && Array.isArray(row.reasons) && row.reasons.length > 0 ||
    Array.isArray(row.wouldHaveBeenBlockedBy) && row.wouldHaveBeenBlockedBy.length > 0 ||
    String(status || '').toLowerCase().includes('skip') ||
    String(status || '').toLowerCase().includes('block'),
  );

  return {
    source,
    ts,
    symbol: row.symbol || null,
    marketType: row.marketType || row.market || row.marketGroup || row.market_group || null,
    signalType,
    score,
    confidence,
    status,
    reason,
    blocked,
    eligible,
    strategyId,
    strategyName,
    sourceStrategyId,
    sourceStrategyName,
    resolvedStrategyId: metadata.resolvedStrategyId || resolved?.id || null,
    resolvedStrategyName: metadata.resolvedStrategyName || resolved?.name || null,
    mappingSource: metadata.mappingSource || 'unknown',
    eventType: row.type || row.decision || row.status || null,
    raw: row,
  };
}

function buildStrategyFlowDiagnostics() {
  const generatedAt = nowIso();
  const catalog = daytradingCatalog.getCatalog();
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const runtimeRows = Array.isArray(runtimeSummary.strategies) ? runtimeSummary.strategies : [];
  const runtimeById = Object.fromEntries(runtimeRows.map((row) => [String(row.id || row.strategy_id || ''), row]));
  const runtimeIndex = buildStrategyIndex(runtimeRows);
  const catalogIndex = buildStrategyIndex(catalog.strategies || []);

  const candidateRows = candidateLog.loadRecent(100).map((row) => normalizeFlowRow(row, 'candidate_log', catalogIndex, runtimeIndex));
  const allPaperEvents = (paperTrading.getEvents().events || []).slice(0, 100).map((row) => normalizeFlowRow(row, 'paper_event', catalogIndex, runtimeIndex));
  const paperEvents = allPaperEvents.filter((row) => {
    const rawType = String(row.eventType || row.raw?.type || row.raw?.decision || row.raw?.status || '').toUpperCase();
    return !['MARKET_CLOSED', 'AGENT_STARTED'].includes(rawType);
  });
  const trades = (paperTrading.getTrades().trades || []).map((trade) => {
    const enriched = strategyRuntimeConnector.enrichPaperTradeWithStrategy(trade);
    return normalizeFlowRow({
      ...trade,
      strategyId: enriched.strategy_id || null,
      strategyName: enriched.strategy_name || null,
      signalSubtype: trade.signalSubtype || trade.signal_subtype || trade.raw_strategy || trade.strategy || null,
      signalFamily: trade.signalFamily || null,
      score: trade.tradeScore ?? trade.signalScore ?? trade.priorityScore ?? null,
      confidenceScore: trade.confidenceScore ?? trade.baseConfidenceScore ?? null,
      timestamp: tradeTimestampOf(trade),
      reasonSv: trade.reasonSv || trade.entryReasonSv || trade.exitReason || null,
      status: trade.result || trade.status || null,
    }, 'paper_trade', catalogIndex, runtimeIndex);
  });

  const candidateLikePaperEvents = paperEvents.filter((row) => {
    const rawType = String(row.raw?.type || row.raw?.decision || row.raw?.status || row.status || '').toUpperCase();
    return !['MARKET_CLOSED', 'AGENT_STARTED'].includes(rawType);
  });

  const recentFlowRows = [
    ...candidateRows,
    ...candidateLikePaperEvents,
  ];

  const perStrategy = new Map();
  const ensureRow = (strategyId, name, runtime) => {
    const key = String(strategyId);
    const existing = perStrategy.get(key) || {
      strategyId: key,
      name: name || key,
      enabled: runtime?.enabled_by_user === true,
      scanned: false,
      candidateCount: 0,
      reachedPaperEligibility: 0,
      reachedPaperEventStage: 0,
      tradeEntryEligible: 0,
      tradeEntryBlockedCount: 0,
      paperTradeCount: 0,
      explicitCount: 0,
      fallbackCount: 0,
      unknownCount: 0,
      lastCandidateAt: null,
      lastPaperTradeAt: null,
      mainDropReason: null,
      examples: [],
      _reasonCounts: new Map(),
      _tradeEntryReasonCounts: new Map(),
      _recentRows: [],
      _marketGroups: new Set(),
    };
    if (name && (!existing.name || existing.name === key)) existing.name = name;
    if (runtime) {
      existing.enabled = runtime.enabled_by_user === true;
      existing.runtimeStatusBefore = runtime.runtime_status_before || runtime.runtime_status || null;
      existing.runtimeStatusAfter = runtime.runtime_status_after || runtime.runtime_status || null;
      existing.runtimeStatus = runtime.runtime_status || null;
      existing.runtimeLabel = runtime.runtime_label || null;
      existing.narrowStateDataPresent = runtime.narrow_state_data_present === true;
      existing.connected = runtime.connected === true;
      existing.rawSignals = runtime.runtime_raw_signals || [];
    }
    perStrategy.set(key, existing);
    return existing;
  };

  for (const strategy of catalog.strategies || []) {
    ensureRow(strategy.id, strategy.name, runtimeById[strategy.id] || strategyRuntimeConnector.getRuntimeStatusForStrategy(strategy.id));
  }

  const addFlowRow = (row) => {
    const effectiveStrategyId = row.resolvedStrategyId || row.sourceStrategyId || row.strategyId || null;
    if (!effectiveStrategyId) return;
    const runtime = runtimeById[effectiveStrategyId] || strategyRuntimeConnector.getRuntimeStatusForStrategy(effectiveStrategyId);
    const existing = ensureRow(effectiveStrategyId, row.strategyName, runtime);
    existing.scanned = true;
    existing._recentRows.push(row);
    if (row.mappingSource === 'explicit') existing.explicitCount += 1;
    else if (row.mappingSource === 'runtime_inference' || row.mappingSource === 'legacy_fallback') existing.fallbackCount += 1;
    else existing.unknownCount += 1;
    if (row.source === 'candidate_log' || row.source === 'paper_event') {
      existing.candidateCount += 1;
      if (row.ts && (!existing.lastCandidateAt || String(row.ts) > String(existing.lastCandidateAt))) existing.lastCandidateAt = row.ts;
    }
    if (row.source === 'paper_event' && row.eligible) {
      existing.reachedPaperEligibility += 1;
      if (row.ts && (!existing.lastCandidateAt || String(row.ts) > String(existing.lastCandidateAt))) existing.lastCandidateAt = row.ts;
    }
    if (row.source === 'paper_trade') {
      existing.paperTradeCount += 1;
      if (row.ts && (!existing.lastPaperTradeAt || String(row.ts) > String(existing.lastPaperTradeAt))) existing.lastPaperTradeAt = row.ts;
    }
    if (row.marketType) existing._marketGroups.add(String(row.marketType).toLowerCase());
    const dropReason = categorizeFlowDropReason(row.reason, row, runtime);
    const reasonKey = row.source === 'paper_trade' ? null : dropReason;
    if (!reasonKey) return;
    existing._reasonCounts.set(reasonKey, (existing._reasonCounts.get(reasonKey) || 0) + 1);
  };

  for (const row of recentFlowRows) addFlowRow(row);
  for (const row of trades) addFlowRow(row);

  const addPaperEventStageRow = (row) => {
    if (String(row.source || '').toLowerCase() !== 'paper_event') return;
    const effectiveStrategyId = row.resolvedStrategyId || row.sourceStrategyId || row.strategyId || null;
    if (!effectiveStrategyId) return;
    const runtime = runtimeById[effectiveStrategyId] || strategyRuntimeConnector.getRuntimeStatusForStrategy(effectiveStrategyId);
    const existing = ensureRow(effectiveStrategyId, row.strategyName, runtime);
    existing.reachedPaperEventStage += 1;
    const tradeEntryReason = tradeEntryBlockReasonOf(row, runtime);
    if (tradeEntryReason) {
      existing.tradeEntryBlockedCount += 1;
      existing._tradeEntryReasonCounts.set(tradeEntryReason, (existing._tradeEntryReasonCounts.get(tradeEntryReason) || 0) + 1);
      return;
    }
    existing.tradeEntryEligible += 1;
  };

  for (const row of allPaperEvents) addPaperEventStageRow(row);

  const missingStrategyIdCandidates = recentFlowRows
    .filter((row) => row.sourceStrategyId == null)
    .filter((row) => !isMissingStrategyIdNoise(row))
    .map((row) => ({
      ts: row.ts,
      source: row.source,
      symbol: row.symbol,
      signalType: row.signalType,
      signalFamily: row.signalFamily || null,
      signalSubtype: row.signalSubtype || row.signal_subtype || null,
      score: row.score,
      confidence: row.confidence,
      status: row.status,
      reason: row.reason,
      sourceStrategyId: row.sourceStrategyId || null,
      resolvedStrategyId: row.resolvedStrategyId || null,
      resolvedStrategyName: row.resolvedStrategyName || null,
      mappingSource: row.mappingSource || 'unknown',
    }))
    .slice(0, 50);

  const fallbackMap = new Map();
  for (const row of recentFlowRows) {
    if (row.sourceStrategyId != null) continue;
    if (!row.resolvedStrategyId) continue;
    const key = `${row.signalType || 'UNKNOWN'}::${row.resolvedStrategyId}`;
    const existing = fallbackMap.get(key) || {
      signalType: row.signalType || 'UNKNOWN',
      inferredStrategyId: row.resolvedStrategyId,
      inferredStrategyName: row.resolvedStrategyName || row.resolvedStrategyId,
      mappingSource: row.mappingSource || 'unknown',
      count: 0,
      sources: new Set(),
      examples: [],
    };
    existing.count += 1;
    existing.sources.add(row.source);
    existing.examples.push({
      ts: row.ts,
      symbol: row.symbol,
      confidence: row.confidence,
      score: row.score,
      reason: row.reason,
      mappingSource: row.mappingSource || 'unknown',
    });
    fallbackMap.set(key, existing);
  }

  const blockerReasonMap = new Map();
  for (const row of [...candidateRows, ...paperEvents]) {
    const reason = row.reason || (row.blocked ? row.status : null);
    if (!reason) continue;
    const key = String(reason).trim();
    const item = blockerReasonMap.get(key) || { reason: key, count: 0, strategies: new Set() };
    item.count += 1;
    if (row.strategyId) item.strategies.add(row.strategyId);
    blockerReasonMap.set(key, item);
  }

  const byStrategy = [...perStrategy.values()]
    .map((row) => {
      const recentRows = row._recentRows
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
      const reasons = [...row._reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
      const stopDetails = dynamicNarrowFlowStopDetails(row) || strategyFlowStopDetails(row.strategyId);
      const mainDropReason = reasons[0]?.reason || (
        row.enabled === false
          ? 'disabled'
          : row.candidateCount === 0
            ? 'no recent candidate'
            : row.reachedPaperEligibility === 0 && row.paperTradeCount === 0
              ? 'did not reach paper eligibility'
              : null
      );
      return {
        strategyId: row.strategyId,
        name: row.name,
        enabled: row.enabled === true,
        scanned: row.scanned === true || (row.rawSignals || []).length > 0,
        candidateCount: row.candidateCount,
        reachedPaperEligibility: row.reachedPaperEligibility,
        reachedPaperEventStage: row.reachedPaperEventStage,
        tradeEntryEligible: row.tradeEntryEligible,
        tradeEntryBlockedCount: row.tradeEntryBlockedCount,
        tradeEntryBlockedReasons: tradeEntryReasonBreakdownFromMap(row._tradeEntryReasonCounts),
        paperTradeCount: row.paperTradeCount,
        explicitCount: row.explicitCount || 0,
        fallbackCount: row.fallbackCount || 0,
        unknownCount: row.unknownCount || 0,
        lastCandidateAt: row.lastCandidateAt || null,
        lastPaperTradeAt: row.lastPaperTradeAt || null,
        narrow_state_data_present: row.narrowStateDataPresent === true,
        runtime_status_before: row.runtimeStatusBefore || row.runtimeStatus || null,
        runtime_status_after: row.runtimeStatusAfter || row.runtimeStatus || null,
        runtime_status: row.runtimeStatus || null,
        mainDropReason: stopDetails?.firstStopReason || mainDropReason,
        examples: flowExamples(recentRows),
        ...stopDetails,
      };
    })
    .sort((a, b) => {
      if ((b.paperTradeCount || 0) !== (a.paperTradeCount || 0)) return (b.paperTradeCount || 0) - (a.paperTradeCount || 0);
      if ((b.candidateCount || 0) !== (a.candidateCount || 0)) return (b.candidateCount || 0) - (a.candidateCount || 0);
      return String(a.name).localeCompare(String(b.name));
    });

  const summary = {
    totalStrategies: byStrategy.length,
    enabledStrategies: byStrategy.filter((row) => row.enabled === true).length,
    strategiesScanned: byStrategy.filter((row) => row.scanned === true).length,
    strategiesWithCandidates: byStrategy.filter((row) => row.candidateCount > 0).length,
    strategiesReachedPaperEligibility: byStrategy.filter((row) => row.reachedPaperEligibility > 0).length,
    strategiesReachedPaperEventStage: byStrategy.filter((row) => row.reachedPaperEventStage > 0).length,
    strategiesTradeEntryEligible: byStrategy.filter((row) => row.tradeEntryEligible > 0).length,
    strategiesTradeEntryBlocked: byStrategy.filter((row) => row.tradeEntryBlockedCount > 0).length,
    strategiesWithPaperTrades: byStrategy.filter((row) => row.paperTradeCount > 0).length,
    strategiesDroppedBeforeCandidate: byStrategy.filter((row) => row.scanned === true && row.candidateCount === 0 && row.paperTradeCount === 0).length,
    strategiesDroppedBeforePaper: byStrategy.filter((row) => row.candidateCount > 0 && row.reachedPaperEligibility === 0 && row.paperTradeCount === 0).length,
    tradeEntryBlockedReasons: tradeEntryReasonBreakdownFromMap(
      byStrategy.reduce((acc, row) => {
        for (const [reason, count] of Object.entries(row.tradeEntryBlockedReasons || {})) {
          acc.set(reason, (acc.get(reason) || 0) + Number(count || 0));
        }
        return acc;
      }, new Map()),
    ),
  };

  const fallbackMappings = [...fallbackMap.values()]
    .map((row) => ({
      signalType: row.signalType,
      inferredStrategyId: row.inferredStrategyId,
      inferredStrategyName: row.inferredStrategyName,
      count: row.count,
      sources: [...row.sources],
      examples: row.examples.slice(0, 3),
      ...SAFETY,
    }))
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  const blockerReasons = [...blockerReasonMap.values()]
    .map((row) => ({
      reason: row.reason,
      count: row.count,
      strategies: [...row.strategies],
      ...SAFETY,
    }))
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  return {
    ok: true,
    generatedAt,
    safety: SAFETY,
    summary,
    byStrategy,
    missingStrategyIdCandidates,
    fallbackMappings,
    blockerReasons,
    recentCandidates: recentFlowRows.slice(0, 100),
    paperTrades: trades.slice(0, 100),
    ...SAFETY,
  };
}

function hasTradeHistory(strategy) {
  return Number(strategy?.trades || 0) > 0;
}

function getRecommendation() {
  const perf = strategyPerformance.compareStrategies();
  const rankedWithHistory = (perf.strategies || [])
    .filter(hasTradeHistory)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = (strategyPerformance.getTopStrategies(1).strategies || []).find(hasTradeHistory) || null;
  const winner = hasTradeHistory(top) ? top : rankedWithHistory[0] || null;
  const weak = (strategyPerformance.getWorstStrategies(3).strategies || []).find(hasTradeHistory) || null;
  const text = winner
    ? `Använd ${winner.strategy_name} i paper/test just nu. Öka inte risk eftersom systemet fortfarande kör i säkert testläge.`
    : 'Behöver mer data innan säker ranking. Kör historisk analys eller strategitest för att få en tydligare rekommendation. Öka inte risk i testläge.';
  return {
    ok: true,
    title: 'Systemets rekommendation just nu',
    recommendation_sv: text,
    best_strategy: winner,
    avoid_strategy: weak,
    safety_note_sv: 'Safety aktiv: riktiga ordrar är avstängda.',
    ...SAFETY,
  };
}

function getImpactSummary() {
  return readJson(IMPACT_FILE, latestImpactFallback());
}

module.exports = {
  SAFETY,
  getStatus,
  getMarkets,
  getMarketControls,
  updateMarketControl,
  setRiskMarketControls,
  setAllMarketControls,
  saveMarketControlSliders,
  getSymbols,
  getStrategies,
  updateStrategy,
  updateFilters,
  runScan,
  getPipeline,
  getLiveTrades,
  getPaperSignals,
  getPaperStrategyDiagnostics,
  getStrategyFlowDiagnostics: buildStrategyFlowDiagnostics,
  getRuntimeStrategies,
  setAllRuntimeStrategies,
  toggleRuntimeStrategy,
  getRecommendation,
  getImpactSummary,
};
