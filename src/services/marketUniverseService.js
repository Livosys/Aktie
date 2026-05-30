'use strict';
const fs   = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  live_enabled: false,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  paper_only: true,
  agent_mode: 'config_only',
});

const DATA_FILE = path.resolve(__dirname, '../../data/config/market-universe.json');

const GROUP_SAFETY = Object.freeze({
  live_enabled: false,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const LIVE_ORDER_SAFETY = Object.freeze({
  live_enabled: false,
  live_trading_enabled: false,
  can_place_orders: false,
  actions_allowed: false,
});

function hasLiveOrderRequest(patch = {}) {
  return patch.live_enabled === true ||
    patch.live_trading_enabled === true ||
    patch.can_place_orders === true ||
    patch.actions_allowed === true ||
    patch.mode === 'live' ||
    patch.testMode === 'live';
}

function enforceNoLiveOrders(entry = {}) {
  const next = { ...entry, ...LIVE_ORDER_SAFETY };
  if (next.mode === 'live') next.mode = next.observeOnly || next.testMode === 'observe' ? 'observe' : 'paper';
  if (next.testMode === 'live') next.testMode = next.mode === 'observe' ? 'observe' : 'paper';
  return next;
}

function liveOrderBlockedResponse() {
  return {
    ok: false,
    error: 'Live/order-flaggor är avstängda i detta system. Endast test och analys är tillåtet.',
    ...SAFETY,
  };
}

const CERTIFICATE_GROUP_IDS = new Set([
  'avanza_certificates',
  'bull_certificates',
  'bear_certificates',
  'mini_futures',
  'commodities',
  'forex',
  'crypto_certificates',
]);

const DAYTRADING_MARKET_GROUP_IDS = Object.freeze([
  'stocks',
  'nasdaq100',
  'etf',
  'crypto',
  'leveraged_etf',
  'avanza_certificates',
  'mini_futures',
  'commodities',
  'forex',
  'crypto_certificates',
]);

const RISK_GROUP_IDS = new Set([
  'leveraged_etf',
  'avanza_certificates',
  'mini_futures',
  'commodities',
  'crypto_certificates',
]);

const RESTRICTED_REASONS = Object.freeze({
  stocks: 'Aktier kan paper-testas. Live/order är låst av safety.',
  nasdaq100: 'Nasdaq-rörelser kan vara snabba vid nyheter och makro. Endast paper/test.',
  etf: 'ETF:er kan påverkas av underliggande index och spread. Endast paper/test.',
  crypto: 'Krypto handlas dygnet runt med hög volatilitet. Endast paper/test.',
  leveraged_etf: 'Leveraged ETF har daglig hävstång och path dependency. Endast paper/test.',
  avanza_certificates: 'Certifikat/hävstångsprodukt. Endast paper/test.',
  mini_futures: 'Mini futures kan ha knock-out/stop-loss. Endast paper/test.',
  commodities: 'Råvaror påverkas av underliggande termin/makro. Endast paper/test.',
  forex: 'Valutor påverkas av makrodata, spreadar och likviditet. Endast paper/test.',
  crypto_certificates: 'Krypto-certifikat kombinerar krypto-, spread- och emittentrisk. Endast paper/test.',
});

const PRODUCT_TYPES = Object.freeze({
  stocks: 'equity',
  nasdaq100: 'nasdaq',
  etf: 'etf',
  crypto: 'crypto',
  leveraged_etf: 'leveraged_etf',
  avanza_certificates: 'certificate',
  mini_futures: 'mini_future',
  commodities: 'commodity',
  forex: 'forex',
  crypto_certificates: 'crypto_certificate',
});

const RISK_CLASS_BY_GROUP = Object.freeze({
  stocks: 'normal',
  nasdaq100: 'normal',
  etf: 'normal',
  crypto: 'high',
  leveraged_etf: 'high',
  avanza_certificates: 'extreme',
  mini_futures: 'extreme',
  commodities: 'high',
  forex: 'high',
  crypto_certificates: 'extreme',
});

function riskClassFromLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'very_high' || value === 'extreme') return 'extreme';
  if (value === 'high') return 'high';
  return 'normal';
}

function riskLevelFromClass(riskClass) {
  if (riskClass === 'extreme') return 'very_high';
  if (riskClass === 'high') return 'high';
  return 'medium';
}

const DEFAULT_GROUPS = {
  crypto:        { label: 'Krypto',             label_sv: 'Krypto',             enabled: true,  maxSymbols: 20, max_symbols: 20, priority: 1, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#f7931a' },
  stocks:        { label: 'Aktier',             label_sv: 'Aktier',             enabled: true,  maxSymbols: 50, max_symbols: 50, priority: 2, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#3b82f6' },
  index:         { label: 'Index',              label_sv: 'Index',              enabled: true,  maxSymbols: 10, max_symbols: 10, priority: 3, paperEnabled: false, paper_enabled: false, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true,  mode: 'observe', risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#8b5cf6' },
  etf:           { label: 'ETF',                label_sv: 'ETF',                enabled: true,  maxSymbols: 20, max_symbols: 20, priority: 4, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#06b6d4' },
  omxs30:        { label: 'OMXS30',             label_sv: 'OMXS30',             enabled: true,  maxSymbols: 30, max_symbols: 30, priority: 4, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'manual_watchlist', description_sv: 'Svenska storbolag och indexnära test.', warning_sv: 'Endast paper/test tills datakvalitet är verifierad.', color: '#0ea5e9' },
  swedish_stocks:{ label: 'Svenska aktier',     label_sv: 'Svenska aktier',     enabled: true,  maxSymbols: 50, max_symbols: 50, priority: 5, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'manual_watchlist', description_sv: 'Svenska aktier för paper-test och analys.', warning_sv: 'Endast paper/test tills datakälla och symbolformat är verifierade.', color: '#14b8a6' },
  leveraged_etf: { label: 'Leveraged ETF',      label_sv: 'Leveraged ETF',      enabled: false, maxSymbols: 5,  max_symbols: 5,  priority: 8, paperEnabled: false, paper_enabled: false, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true,  mode: 'observe', risk_level: 'high',   test_only: false, section: 'scanner', data_status: 'active', color: '#f59e0b' },
  nasdaq100:     { label: 'Nasdaq 100',         label_sv: 'Nasdaq 100',         enabled: true,  maxSymbols: 10, max_symbols: 10, priority: 3, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#3b82f6' },
  sp500:         { label: 'S&P 500',            label_sv: 'S&P 500',            enabled: true,  maxSymbols: 10, max_symbols: 10, priority: 3, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#22c55e' },
  mag7:          { label: 'Magnificent 7',      label_sv: 'Magnificent 7',      enabled: true,  maxSymbols: 7,  max_symbols: 7,  priority: 2, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'active', color: '#a855f7' },
  custom:        { label: 'Custom Watchlist',   label_sv: 'Custom Watchlist',   enabled: false, maxSymbols: 20, max_symbols: 20, priority: 9, paperEnabled: true,  paper_enabled: true,  batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: false, mode: 'paper',   risk_level: 'medium', test_only: false, section: 'scanner', data_status: 'manual_watchlist', color: '#64748b' },
  avanza_certificates: { label: 'Avanza certifikat', label_sv: 'Avanza certifikat', enabled: true, maxSymbols: 30, max_symbols: 30, priority: 10, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Bull, Bear och andra certifikat som testas mot underliggande marknader.', warning_sv: 'Certifikat kan ha hävstång och hög risk. Endast testläge.', provider_hint_sv: 'Kräver Avanza/NGM/Nordic data-källa', color: '#f97316', ...GROUP_SAFETY },
  bull_certificates: { label: 'Bull-certifikat', label_sv: 'Bull-certifikat', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 11, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Produkter som stiger när underliggande marknad går upp.', warning_sv: 'Bull-certifikat kan röra sig snabbt. Endast testläge.', provider_hint_sv: 'Kräver Avanza/NGM/Nordic data-källa', color: '#dc2626', ...GROUP_SAFETY },
  bear_certificates: { label: 'Bear-certifikat', label_sv: 'Bear-certifikat', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 12, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Produkter som stiger när underliggande marknad går ner.', warning_sv: 'Bear-certifikat kan röra sig snabbt. Endast testläge.', provider_hint_sv: 'Kräver Avanza/NGM/Nordic data-källa', color: '#7f1d1d', ...GROUP_SAFETY },
  mini_futures: { label: 'Mini futures', label_sv: 'Mini futures', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 13, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'very_high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Mini futures med hävstång och stop loss-nivå.', warning_sv: 'Mini futures är avancerade produkter. Endast testläge.', provider_hint_sv: 'Kräver Avanza/NGM/Nordic data-källa', color: '#ef4444', ...GROUP_SAFETY },
  commodities: { label: 'Råvaror', label_sv: 'Råvaror', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 14, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Till exempel olja, guld och silver via underliggande data eller certifikat.', warning_sv: 'Råvaror kan röra sig kraftigt. Endast testläge.', provider_hint_sv: 'Kräver råvaru- eller certifikatdata', color: '#ca8a04', ...GROUP_SAFETY },
  forex: { label: 'Valutor', label_sv: 'Valutor', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 15, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Valutapar eller certifikat kopplade till valutor.', warning_sv: 'Valutor påverkas av makrodata och spreadar. Endast testläge.', provider_hint_sv: 'Kräver valutadata eller certifikatdata', color: '#0284c7', ...GROUP_SAFETY },
  crypto_certificates: { label: 'Krypto-certifikat', label_sv: 'Krypto-certifikat', enabled: true, maxSymbols: 20, max_symbols: 20, priority: 16, mode: 'observe', paperEnabled: true, paper_enabled: true, batch_enabled: true, replay_enabled: true, live_enabled: false, observeOnly: true, risk_level: 'very_high', test_only: true, section: 'test', data_status: 'needs_provider', description_sv: 'Certifikat kopplade till kryptovalutor.', warning_sv: 'Krypto-certifikat kan ha mycket hög risk. Endast testläge.', provider_hint_sv: 'Kräver Avanza/NGM/Nordic data-källa', color: '#9333ea', ...GROUP_SAFETY },
};

const DEFAULT_SYMBOLS = [
  { symbol: 'BTCUSDT', marketGroup: 'crypto',        enabled: true,  paused: false, priority: 1, testMode: 'paper',   maxDailyCandidates: 50, maxDailyPaperTrades: 5 },
  { symbol: 'ETHUSDT', marketGroup: 'crypto',        enabled: true,  paused: false, priority: 2, testMode: 'paper',   maxDailyCandidates: 40, maxDailyPaperTrades: 5 },
  { symbol: 'SOLUSDT', marketGroup: 'crypto',        enabled: true,  paused: false, priority: 3, testMode: 'paper',   maxDailyCandidates: 30, maxDailyPaperTrades: 3 },
  { symbol: 'NVDA',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 1, testMode: 'paper',   maxDailyCandidates: 30, maxDailyPaperTrades: 3 },
  { symbol: 'AMD',     marketGroup: 'stocks',        enabled: true,  paused: false, priority: 2, testMode: 'paper',   maxDailyCandidates: 30, maxDailyPaperTrades: 3 },
  { symbol: 'TSLA',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 3, testMode: 'paper',   maxDailyCandidates: 30, maxDailyPaperTrades: 3 },
  { symbol: 'AAPL',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 4, testMode: 'paper',   maxDailyCandidates: 20, maxDailyPaperTrades: 2 },
  { symbol: 'MSFT',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 5, testMode: 'paper',   maxDailyCandidates: 20, maxDailyPaperTrades: 2 },
  { symbol: 'AMZN',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 6, testMode: 'paper',   maxDailyCandidates: 20, maxDailyPaperTrades: 2 },
  { symbol: 'META',    marketGroup: 'stocks',        enabled: true,  paused: false, priority: 7, testMode: 'paper',   maxDailyCandidates: 20, maxDailyPaperTrades: 2 },
  { symbol: 'QQQ',     marketGroup: 'nasdaq100',     enabled: true,  paused: false, priority: 1, testMode: 'observe', maxDailyCandidates: 10, maxDailyPaperTrades: 0 },
  { symbol: 'SPY',     marketGroup: 'etf',           enabled: true,  paused: false, priority: 2, testMode: 'observe', maxDailyCandidates: 10, maxDailyPaperTrades: 0 },
  { symbol: 'IWM',     marketGroup: 'etf',           enabled: false, paused: false, priority: 5, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'DIA',     marketGroup: 'etf',           enabled: false, paused: false, priority: 6, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'TQQQ',    marketGroup: 'leveraged_etf', enabled: false, paused: false, priority: 1, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'SQQQ',    marketGroup: 'leveraged_etf', enabled: false, paused: false, priority: 2, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'SOXL',    marketGroup: 'leveraged_etf', enabled: false, paused: false, priority: 3, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'SOXS',    marketGroup: 'leveraged_etf', enabled: false, paused: false, priority: 4, testMode: 'observe', maxDailyCandidates: 5,  maxDailyPaperTrades: 0 },
  { symbol: 'GOOGL',   marketGroup: 'mag7',          enabled: false, paused: false, priority: 1, testMode: 'paper',   maxDailyCandidates: 15, maxDailyPaperTrades: 1 },
  { symbol: 'BULL OMX X10 AVA', marketGroup: 'avanza_certificates', group: 'avanza_certificates', enabled: false, paused: false, priority: 1, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'OMXS30', direction: 'bull', leverage: 10, issuer: 'Avanza Markets / Morgan Stanley', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BEAR OMX X10 AVA', marketGroup: 'avanza_certificates', group: 'avanza_certificates', enabled: false, paused: false, priority: 2, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'OMXS30', direction: 'bear', leverage: 10, issuer: 'Avanza Markets / Morgan Stanley', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BULL DAX X10 AVA', marketGroup: 'avanza_certificates', group: 'avanza_certificates', enabled: false, paused: false, priority: 3, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'DAX', direction: 'bull', leverage: 10, issuer: 'Avanza Markets / Morgan Stanley', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BEAR DAX X10 AVA', marketGroup: 'avanza_certificates', group: 'avanza_certificates', enabled: false, paused: false, priority: 4, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'DAX', direction: 'bear', leverage: 10, issuer: 'Avanza Markets / Morgan Stanley', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'MINI LONG DAX AVA', marketGroup: 'mini_futures', group: 'mini_futures', enabled: false, paused: false, priority: 1, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'DAX', direction: 'long', product_type: 'mini_future', currency: 'SEK', risk_level: 'very_high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'MINI SHORT DAX AVA', marketGroup: 'mini_futures', group: 'mini_futures', enabled: false, paused: false, priority: 2, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'DAX', direction: 'short', product_type: 'mini_future', currency: 'SEK', risk_level: 'very_high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'MINI LONG NASDAQ AVA', marketGroup: 'mini_futures', group: 'mini_futures', enabled: false, paused: false, priority: 3, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'NASDAQ', direction: 'long', product_type: 'mini_future', currency: 'SEK', risk_level: 'very_high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'MINI SHORT NASDAQ AVA', marketGroup: 'mini_futures', group: 'mini_futures', enabled: false, paused: false, priority: 4, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'NASDAQ', direction: 'short', product_type: 'mini_future', currency: 'SEK', risk_level: 'very_high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BULL GULD AVA', marketGroup: 'commodities', group: 'commodities', enabled: false, paused: false, priority: 1, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'Guld', direction: 'bull', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BEAR GULD AVA', marketGroup: 'commodities', group: 'commodities', enabled: false, paused: false, priority: 2, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'Guld', direction: 'bear', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BULL OLJA AVA', marketGroup: 'commodities', group: 'commodities', enabled: false, paused: false, priority: 3, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'Olja', direction: 'bull', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
  { symbol: 'BEAR OLJA AVA', marketGroup: 'commodities', group: 'commodities', enabled: false, paused: false, priority: 4, testMode: 'observe', mode: 'observe', paper_enabled: true, live_enabled: false, underlying: 'Olja', direction: 'bear', product_type: 'certificate', currency: 'SEK', risk_level: 'high', test_only: true, placeholder: true, verification_status: 'unverified', data_status: 'needs_provider', status_label_sv: 'Symbol ej verifierad', ...GROUP_SAFETY },
];

function isRestrictedGroup(groupId) {
  return CERTIFICATE_GROUP_IDS.has(groupId);
}

function normalizeGroup(key, group = {}) {
  const base = DEFAULT_GROUPS[key] || {};
  const normalized = { ...base, ...group };
  normalized.label = normalized.label || normalized.label_sv || key;
  normalized.label_sv = normalized.label_sv || normalized.label;
  normalized.maxSymbols = Number(normalized.maxSymbols ?? normalized.max_symbols ?? 20) || 20;
  normalized.max_symbols = normalized.maxSymbols;
  normalized.priority = Number(normalized.priority) || 99;
  normalized.enabled_for_paper = Boolean(normalized.enabled_for_paper ?? normalized.paperEnabled ?? normalized.paper_enabled);
  normalized.paperEnabled = normalized.enabled_for_paper;
  normalized.paper_enabled = normalized.enabled_for_paper;
  normalized.enabled_for_scanner = normalized.enabled_for_scanner ?? normalized.enabled !== false;
  normalized.enabled = normalized.enabled_for_scanner !== false;
  normalized.enabled_for_batch = normalized.enabled_for_batch ?? normalized.batch_enabled !== false;
  normalized.batch_enabled = normalized.enabled_for_batch !== false;
  normalized.enabled_for_replay = normalized.enabled_for_replay ?? normalized.replay_enabled !== false;
  normalized.replay_enabled = normalized.enabled_for_replay !== false;
  normalized.live_enabled = false;
  normalized.live_trading_enabled = false;
  normalized.can_place_orders = false;
  normalized.actions_allowed = false;
  normalized.risk_class = RISK_CLASS_BY_GROUP[key] || normalized.risk_class || riskClassFromLevel(normalized.risk_level);
  normalized.risk_level = normalized.risk_level || riskLevelFromClass(normalized.risk_class);
  normalized.product_type = normalized.product_type || PRODUCT_TYPES[key] || 'market';
  normalized.restricted = normalized.restricted ?? (isRestrictedGroup(key) || normalized.risk_class !== 'normal');
  normalized.restricted_reason = normalized.restricted_reason || RESTRICTED_REASONS[key] || normalized.warning_sv || 'Endast paper/test. Live/order är låst.';
  normalized.user_note = normalized.user_note || '';
  normalized.mode = normalized.mode === 'live' ? (normalized.observeOnly ? 'observe' : 'paper') : (normalized.mode || (normalized.observeOnly ? 'observe' : 'paper'));
  normalized.observeOnly = normalized.observeOnly ?? normalized.mode === 'observe';
  normalized.section = normalized.section || (normalized.test_only ? 'test' : 'scanner');
  normalized.data_status = normalized.data_status || normalized.dataStatus || 'unknown';
  normalized.dataStatus = normalized.data_status;
  if (isRestrictedGroup(key)) {
    normalized.mode = 'observe';
    normalized.observeOnly = true;
    normalized.test_only = true;
    normalized.section = 'test';
    normalized.risk_level = normalized.risk_level || 'high';
    normalized.risk_class = normalized.risk_class || riskClassFromLevel(normalized.risk_level);
    normalized.restricted = true;
    normalized.live_enabled = false;
    normalized.live_trading_enabled = false;
    normalized.can_place_orders = false;
    normalized.actions_allowed = false;
  }
  return enforceNoLiveOrders(normalized);
}

function normalizeSymbol(symbol = {}) {
  const groupId = symbol.marketGroup || symbol.group || 'custom';
  const restricted = isRestrictedGroup(groupId);
  const normalized = {
    paused: false,
    enabled: true,
    priority: 99,
    testMode: restricted ? 'observe' : 'paper',
    maxDailyCandidates: 10,
    maxDailyPaperTrades: 1,
    ...symbol,
    marketGroup: groupId,
    group: groupId,
  };
  if (restricted || symbol.test_only) {
    const unverified = normalized.placeholder === true ||
      normalized.verification_status === 'unverified' ||
      normalized.verification_status === 'invalid' ||
      normalized.data_status === 'needs_provider';
    normalized.mode = 'observe';
    normalized.testMode = 'observe';
    normalized.paper_enabled = true;
    normalized.enabled_for_paper = normalized.enabled_for_paper ?? true;
    normalized.live_enabled = false;
    normalized.live_trading_enabled = false;
    normalized.can_place_orders = false;
    normalized.actions_allowed = false;
    normalized.test_only = true;
    normalized.placeholder = normalized.placeholder !== false;
    normalized.verification_status = normalized.verification_status || 'unverified';
    normalized.data_status = normalized.data_status || 'needs_provider';
    normalized.status_label_sv = normalized.status_label_sv || 'Symbol ej verifierad';
    normalized.maxDailyCandidates = unverified ? 0 : Number(normalized.maxDailyCandidates ?? 10);
    normalized.maxDailyPaperTrades = unverified ? 0 : Number(normalized.maxDailyPaperTrades ?? 1);
  }
  if (normalized.symbol === 'STOCKHOLM') {
    normalized.marketGroup = 'swedish_stocks';
    normalized.group = 'swedish_stocks';
    normalized.enabled = false;
    normalized.testMode = 'observe';
    normalized.mode = 'observe';
    normalized.verification_status = 'invalid';
    normalized.status_label_sv = 'Ogiltig symbol';
    normalized.data_status = 'symbol_unverified';
    normalized.maxDailyCandidates = 0;
    normalized.maxDailyPaperTrades = 0;
  }
  return enforceNoLiveOrders(normalized);
}

function groupIdForMarketProfile(profileGroup) {
  const key = String(profileGroup || '').toUpperCase();
  if (key === 'US_STOCKS') return 'stocks';
  if (key === 'INDEX_ETFS') return 'etf';
  if (key === 'LEVERAGED_ETFS') return 'leveraged_etf';
  if (key === 'CRYPTO_MAJOR' || key === 'CRYPTO_SECONDARY') return 'crypto';
  return String(profileGroup || '').toLowerCase();
}

function getGroupForSymbol(symbol, fallbackGroup) {
  const data = load();
  const sym = String(symbol || '').toUpperCase();
  if (sym === 'QQQ') return 'nasdaq100';
  if (['SPY', 'IWM', 'DIA'].includes(sym)) return 'etf';
  const known = data.symbols.find((row) => String(row.symbol || '').toUpperCase() === sym);
  return known?.marketGroup || known?.group || groupIdForMarketProfile(fallbackGroup) || null;
}

function groupEnabledFor(groupId, scope) {
  if (!groupId) return true;
  const group = getGroup(groupId) || getGroup(groupIdForMarketProfile(groupId));
  if (!group) return true;
  if (scope === 'paper') return group.enabled_for_paper !== false && group.paper_enabled !== false;
  if (scope === 'scanner') return group.enabled_for_scanner !== false && group.enabled !== false;
  if (scope === 'replay') return group.enabled_for_replay !== false && group.replay_enabled !== false;
  if (scope === 'batch') return group.enabled_for_batch !== false && group.batch_enabled !== false;
  return true;
}

function symbolEnabledFor(symbol, scope, fallbackGroup) {
  const groupId = getGroupForSymbol(symbol, fallbackGroup);
  return groupEnabledFor(groupId, scope);
}

function controlFromGroup(groupId, group, symbols) {
  const rows = symbols.filter((sym) => (sym.marketGroup || sym.group) === groupId);
  const verified = rows.filter((sym) => sym.verification_status !== 'unverified' && sym.verification_status !== 'invalid' && sym.data_status !== 'needs_provider');
  const riskClass = RISK_CLASS_BY_GROUP[groupId] || group.risk_class || riskClassFromLevel(group.risk_level);
  const displayName = groupId === 'nasdaq100'
    ? 'Nasdaq'
    : groupId === 'avanza_certificates'
      ? 'Certifikat'
      : (group.label_sv || group.label || groupId);
  return {
    group_id: groupId,
    group_name: displayName,
    connected: true,
    enabled_for_paper: group.enabled_for_paper ?? group.paper_enabled !== false,
    enabled_for_scanner: group.enabled_for_scanner ?? group.enabled !== false,
    enabled_for_replay: group.enabled_for_replay ?? group.replay_enabled !== false,
    enabled_for_batch: group.enabled_for_batch ?? group.batch_enabled !== false,
    live_enabled: false,
    can_place_orders: false,
    actions_allowed: false,
    live_trading_enabled: false,
    risk_class: riskClass,
    product_type: group.product_type || PRODUCT_TYPES[groupId] || 'market',
    restricted: group.restricted ?? (riskClass !== 'normal' || isRestrictedGroup(groupId)),
    restricted_reason: group.restricted_reason || RESTRICTED_REASONS[groupId] || group.warning_sv || 'Endast paper/test. Live/order är låst.',
    user_note: group.user_note || '',
    symbol_count: rows.length,
    verified_symbol_count: verified.length,
    unverified_symbol_count: Math.max(0, rows.length - verified.length),
    color: group.color || null,
    data_status: group.data_status || null,
    provider_hint_sv: group.provider_hint_sv || null,
    warning_sv: group.warning_sv || null,
  };
}

function getMarketControls() {
  const data = load();
  const controls = DAYTRADING_MARKET_GROUP_IDS
    .map((groupId) => [groupId, data.groups[groupId] || DEFAULT_GROUPS[groupId]])
    .filter(([, group]) => group)
    .map(([groupId, group]) => controlFromGroup(groupId, normalizeGroup(groupId, group), data.symbols));
  return {
    ok: true,
    controls,
    summary: {
      total: controls.length,
      paper_enabled: controls.filter((row) => row.enabled_for_paper).length,
      scanner_enabled: controls.filter((row) => row.enabled_for_scanner).length,
      risk_enabled_for_paper: controls.filter((row) => RISK_GROUP_IDS.has(row.group_id) && row.enabled_for_paper).length,
      risk_enabled_for_scanner: controls.filter((row) => RISK_GROUP_IDS.has(row.group_id) && row.enabled_for_scanner).length,
    },
    risk_group_ids: [...RISK_GROUP_IDS],
    ...SAFETY,
  };
}

function patchMarketControl(groupId, patch = {}) {
  if (!DAYTRADING_MARKET_GROUP_IDS.includes(groupId)) {
    return { ok: false, error: 'Okänd marknadsgrupp.', ...SAFETY };
  }
  if (hasLiveOrderRequest(patch)) return liveOrderBlockedResponse();
  const allowed = ['enabled_for_paper', 'enabled_for_scanner', 'enabled_for_replay', 'enabled_for_batch', 'user_note'];
  const nextPatch = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    nextPatch[key] = key === 'user_note' ? String(patch[key] || '') : patch[key] === true;
  }
  const data = load();
  const current = normalizeGroup(groupId, data.groups[groupId] || DEFAULT_GROUPS[groupId] || {});
  const next = normalizeGroup(groupId, {
    ...current,
    ...nextPatch,
    paperEnabled: nextPatch.enabled_for_paper ?? current.enabled_for_paper,
    paper_enabled: nextPatch.enabled_for_paper ?? current.enabled_for_paper,
    enabled: nextPatch.enabled_for_scanner ?? current.enabled_for_scanner,
    batch_enabled: nextPatch.enabled_for_batch ?? current.enabled_for_batch,
    replay_enabled: nextPatch.enabled_for_replay ?? current.enabled_for_replay,
  });
  data.groups[groupId] = next;
  save(data);
  return { ok: true, control: controlFromGroup(groupId, next, data.symbols), ...getMarketControls(), ...SAFETY };
}

function setRiskControls(enabled) {
  const data = load();
  for (const groupId of RISK_GROUP_IDS) {
    const current = normalizeGroup(groupId, data.groups[groupId] || DEFAULT_GROUPS[groupId] || {});
    data.groups[groupId] = normalizeGroup(groupId, {
      ...current,
      enabled_for_paper: enabled === true,
      enabled_for_scanner: enabled === true,
      enabled_for_replay: current.enabled_for_replay !== false,
      enabled_for_batch: current.enabled_for_batch !== false,
      paperEnabled: enabled === true,
      paper_enabled: enabled === true,
      enabled: enabled === true,
      live_enabled: false,
      can_place_orders: false,
      actions_allowed: false,
      live_trading_enabled: false,
    });
  }
  save(data);
  return { ok: true, message_sv: enabled ? 'Riskinstrument aktiverade för paper/scanner.' : 'Riskinstrument pausade för paper/scanner.', ...getMarketControls(), ...SAFETY };
}

function setAllMarketControls(enabled) {
  const data = load();
  for (const groupId of DAYTRADING_MARKET_GROUP_IDS) {
    const current = normalizeGroup(groupId, data.groups[groupId] || DEFAULT_GROUPS[groupId] || {});
    data.groups[groupId] = normalizeGroup(groupId, {
      ...current,
      enabled_for_paper: enabled === true,
      enabled_for_scanner: enabled === true,
      paperEnabled: enabled === true,
      paper_enabled: enabled === true,
      enabled: enabled === true,
      live_enabled: false,
      can_place_orders: false,
      actions_allowed: false,
      live_trading_enabled: false,
    });
  }
  save(data);
  return { ok: true, message_sv: enabled ? 'Alla marknader aktiverade för paper/scanner.' : 'Alla marknader pausade för paper/scanner.', ...getMarketControls(), ...SAFETY };
}

function normalizeUniverse(data = {}) {
  const groups = {};
  for (const [key, group] of Object.entries({ ...DEFAULT_GROUPS, ...(data.groups || {}) })) {
    groups[key] = normalizeGroup(key, group);
  }
  const seen = new Set();
  const symbols = [...(data.symbols || []), ...DEFAULT_SYMBOLS]
    .map(normalizeSymbol)
    .filter((sym) => {
      if (!sym.symbol || seen.has(sym.symbol)) return false;
      seen.add(sym.symbol);
      return true;
    });
  return { groups, symbols, updatedAt: data.updatedAt || null };
}

function hasBlockedLiveRequestForGroup(key, patch = {}) {
  return hasLiveOrderRequest(patch);
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return normalizeUniverse(JSON.parse(raw));
  } catch (_) {
    return normalizeUniverse({ groups: { ...DEFAULT_GROUPS }, symbols: [...DEFAULT_SYMBOLS], updatedAt: null });
  }
}

function save(data) {
  data.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getUniverse() {
  const data = load();
  return { groups: data.groups, symbols: data.symbols, updatedAt: data.updatedAt, ...SAFETY };
}

function updateGroups(newGroups) {
  const data = load();
  for (const [key, patch] of Object.entries(newGroups || {})) {
    if (hasBlockedLiveRequestForGroup(key, patch)) {
      return liveOrderBlockedResponse();
    }
  }
  data.groups = Object.fromEntries(
    Object.entries(Object.assign({}, data.groups, newGroups)).map(([key, group]) => [key, normalizeGroup(key, group)])
  );
  save(data);
  return { ok: true, groups: data.groups, ...SAFETY };
}

function getSymbols() {
  const data = load();
  return { symbols: data.symbols, ...SAFETY };
}

function addSymbol(sym) {
  if (!sym || !sym.symbol) return { ok: false, error: 'symbol field required', ...SAFETY };
  if (hasLiveOrderRequest(sym)) return liveOrderBlockedResponse();
  const data = load();
  if (data.symbols.find(s => s.symbol === sym.symbol)) {
    return { ok: false, error: `${sym.symbol} already exists`, ...SAFETY };
  }
  const entry = normalizeSymbol(sym);
  data.symbols.push(entry);
  save(data);
  return { ok: true, symbols: data.symbols, ...SAFETY };
}

function removeSymbol(symbolStr) {
  const data = load();
  data.symbols = data.symbols.filter(s => s.symbol !== symbolStr);
  save(data);
  return { ok: true, symbols: data.symbols, ...SAFETY };
}

function patchSymbol(symbolStr, patch) {
  const data = load();
  const idx = data.symbols.findIndex(s => s.symbol === symbolStr);
  if (idx === -1) return { ok: false, error: `${symbolStr} not found`, ...SAFETY };
  if (hasLiveOrderRequest(patch)) return liveOrderBlockedResponse();
  data.symbols[idx] = normalizeSymbol(Object.assign({}, data.symbols[idx], patch));
  save(data);
  return { ok: true, symbol: data.symbols[idx], ...SAFETY };
}

function updateSymbols(newSymbols) {
  if ((newSymbols || []).some(hasLiveOrderRequest)) return liveOrderBlockedResponse();
  const data = load();
  data.symbols = (newSymbols || []).map(normalizeSymbol);
  save(data);
  return { ok: true, symbols: data.symbols, ...SAFETY };
}

function getGroup(groupId) {
  const data = load();
  return data.groups[groupId] || null;
}

module.exports = {
  SAFETY,
  DEFAULT_GROUPS,
  DEFAULT_SYMBOLS,
  CERTIFICATE_GROUP_IDS,
  DAYTRADING_MARKET_GROUP_IDS,
  RISK_GROUP_IDS,
  isRestrictedGroup,
  groupIdForMarketProfile,
  getGroupForSymbol,
  groupEnabledFor,
  symbolEnabledFor,
  getMarketControls,
  patchMarketControl,
  setRiskControls,
  setAllMarketControls,
  getGroup,
  getUniverse,
  updateGroups,
  getSymbols,
  addSymbol,
  removeSymbol,
  patchSymbol,
  updateSymbols,
};
