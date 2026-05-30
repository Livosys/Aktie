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
  const crypto = (getCryptoResults() || []).map((row) => ({ ...row, market_group: 'crypto', marketType: 'crypto' }));
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
      needs_more_data: trades < 10,
      ...SAFETY,
    };
  });
  return { ok: true, strategies: rows, count: rows.length, config: loadConfig(), ...SAFETY };
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

function getLiveTrades(options = {}) {
  const limit = normalizeTradeLimit(options.limit);
  const trades = paperTrading.getTrades().trades || [];
  const rows = trades.slice(0, limit).map((trade) => {
    const enriched = strategyRuntimeConnector.enrichPaperTradeWithStrategy(trade);
    const market = enriched.marketType || enriched.market || marketForSymbol(enriched.symbol);
    const status = trade.result === 'OPEN'
      ? 'Pågående'
      : trade.result === 'WIN'
        ? 'Stängd vinst'
        : trade.result === 'LOSS'
          ? 'Stängd förlust'
          : trade.result === 'TIMEOUT'
            ? 'Timeout'
            : 'Paper trade öppnad';
    return {
      time: enriched.opened_at || enriched.entryTime || enriched.timestamp || null,
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
      direction: enriched.direction || enriched.type || '–',
      entry: enriched.entryPrice ?? enriched.entry ?? null,
      exit: enriched.exitPrice ?? enriched.exit ?? null,
      current_price: enriched.currentPrice ?? enriched.exitPrice ?? null,
      stop_loss: enriched.stopPct ?? enriched.stop_loss ?? null,
      take_profit: enriched.targetPct ?? enriched.take_profit ?? null,
      pnl: enriched.pnlPct ?? enriched.unrealizedPct ?? null,
      result: enriched.result || null,
      status,
      confidence: enriched.confidenceScore ?? enriched.baseConfidenceScore ?? null,
      risk_reason: firstText(enriched.riskBlockReasons, enriched.riskWarnings, enriched.riskEvaluation?.block_reasons, enriched.riskEvaluation?.warnings),
      block_reason: firstText(enriched.safetyBlockReasons, enriched.executionSafety?.paper_block_reasons, enriched.executionSafety?.block_reasons, enriched.observeOnlyReasonSv),
      exit_reason: enriched.exitReason || enriched.exitReasonCode || null,
      duration: enriched.duration_label || null,
      reason: enriched.reasonSv || enriched.exitReason || enriched.signal || enriched.entryReasonSv || 'Paper/test',
      trade_id: enriched.tradeId || enriched.trade_id || enriched.id || '',
      ...SAFETY,
    };
  });
  const runtimeSummary = strategyRuntimeConnector.getStrategyRuntimeSummary();
  const paperSummary = getPaperTradeSummary48h();
  const summary = tradeSummary(rows);
  return {
    ok: true,
    limit,
    total_available: trades.length,
    trades: rows,
    count: rows.length,
    summary,
    summary_48h: { ...paperSummary, runtime: runtimeSummary.summary },
    runtime_summary: runtimeSummary.summary,
    runtime_strategies: runtimeSummary.strategies,
    stoppage_summary_48h: getPaperStoppageSummary48h(),
    source_of_truth: {
      strategy_control: 'Strategikontroll = katalog + teststatistik + historik',
      candidates_paper: 'Kandidater & paper trades = faktiska paper trades från scanner',
      safety: 'Safety = live trading är avstängt',
      ...SAFETY,
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
  getRuntimeStrategies,
  setAllRuntimeStrategies,
  toggleRuntimeStrategy,
  getRecommendation,
  getImpactSummary,
};
