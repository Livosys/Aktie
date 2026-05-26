'use strict';

const { buildDaytradeSignal } = require('../scanner/daytradeSignalEngine');
const signalDeduper = require('./signalDeduper');
const telegramNotifier = require('./telegramNotifier');
const webhookNotifier = require('./webhookNotifier');
const whatsappNotifier = require('./whatsappNotifier');

// Areas in systemHealth that should never trigger Telegram — only UI display
const SILENT_HEALTH_AREAS = new Set(['Machine', 'Learning']);

// Components whose names indicate internal backtest metadata, not live operations
const SILENT_COMPONENT_PATTERNS = [
  /backtest/i,
  /last run/i,
  /momentum backtest/i,
  /backfill/i,
  /replay/i,
  /analyze outcomes/i,
  /update learning/i,
  /cache invalidation/i,
];

let lastSystemStatus = 'OK';

function enabled() {
  return String(process.env.NOTIFICATIONS_ENABLED || 'false').toLowerCase() === 'true';
}

function providerName() {
  return String(process.env.NOTIFICATION_PROVIDER || 'telegram').toLowerCase();
}

function minScore() {
  const n = parseInt(process.env.SIGNAL_NOTIFY_MIN_SCORE || '70', 10);
  return Number.isFinite(n) ? n : 70;
}

function cooldownMinutes() {
  const n = parseInt(process.env.SIGNAL_NOTIFY_COOLDOWN_MINUTES || '15', 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

function notifier() {
  const provider = providerName();
  if (provider === 'webhook') return webhookNotifier;
  if (provider === 'whatsapp') return whatsappNotifier;
  return telegramNotifier;
}

function isConfigured() {
  return enabled() && notifier().isConfigured();
}

function safeDisabledLog() {
  console.log('[Notifier] disabled or not configured');
}

function finite(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function ageMinutes(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 60000);
}

function isStale(result, feedStatus) {
  if (feedStatus?.stale) return true;
  if (result?.decayContext?.stale === true) return true;
  const age = ageMinutes(result?.lastUpdate);
  return age !== null && age > 10;
}

function isHighFakeout(result) {
  const fakeout = finite(result?.fakeoutProbability);
  return result?.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70);
}

function isReplayPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.replay_mode === true || payload.replayMode === true) return true;
  if (payload.result?.replay_mode === true || payload.result?.replayMode === true) return true;
  if (payload.signal?.replay_mode === true || payload.signal?.replayMode === true) return true;
  if (typeof payload.event === 'string' && payload.event.startsWith('replay')) return true;
  return false;
}

function replayBlocked() {
  console.warn('[notification] replay payload blocked');
  return { ok: false, skipped: true, reason: 'replay_mode_blocked' };
}

// Sharper signal filter: requires meaningful score+status combination
function shouldNotifySignal(signal, result, feedStatus) {
  if (isStale(result, feedStatus)) return false;
  if (signal.direction === 'neutral') return false;
  if (signal.status === 'Bevaka' || signal.status === 'Undvik') return false;

  const score = Number(signal.score);
  const threshold = minScore();
  if (!Number.isFinite(score) || score < threshold) return false;

  // High fakeout blocks all non-confirmed signals
  if (isHighFakeout(result) && signal.status !== 'Bekräftad') return false;

  // Quality gates: status+score combinations
  if (signal.status === 'Bekräftad' && score >= 70) return true;
  if (signal.status === 'Intressant' && score >= 75) return true;
  if (score >= 80) return true;

  return false;
}

function directionSv(direction) {
  if (direction === 'down') return 'Ner';
  if (direction === 'up') return 'Upp';
  return 'Neutral';
}

function pct(value) {
  if (value === null || value === undefined || value === '') return 'okänt';
  return `${value}%`;
}

function riskSv(risk) {
  if (risk === 'high') return 'Hög';
  if (risk === 'medium') return 'Medel';
  if (risk === 'low') return 'Låg';
  return 'Okänd';
}

function tradingViewUrl(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return 'https://www.tradingview.com/chart/';

  const cryptoNormalize = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT', SOLUSD: 'SOLUSDT' };
  const normalized = cryptoNormalize[raw] || raw;
  const isCrypto = normalized.endsWith('USDT');
  const exchange = isCrypto ? 'BINANCE' : 'NASDAQ';
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${exchange}:${normalized}`)}`;
}

function reasonsFor(result, signal) {
  const reasons = Array.isArray(signal.reasons) ? signal.reasons : [];
  const fallback = [
    result?.mtfExplanationSv,
    result?.momentumContinuationReasonSv,
    result?.confidenceExplanationSv,
  ].filter(Boolean);
  const unique = [...new Set([...reasons, ...fallback])].filter(Boolean);
  while (unique.length < 3) unique.push('Kontrollera setup manuellt innan beslut.');
  return unique.slice(0, 3);
}

function normalizeSignal(result) {
  const daytrade = buildDaytradeSignal(result);
  return {
    symbol: result?.symbol,
    direction: daytrade.daytradeDirection,
    status: daytrade.daytradeStatus,
    score: daytrade.daytradeScore,
    risk: daytrade.daytradeRisk,
    reasons: daytrade.daytradeReasons,
    warnings: daytrade.daytradeWarnings,
    currentMovePct: daytrade.targetMove?.currentMovePct,
    remainingToTargetPct: daytrade.targetMove?.remainingToTargetPct,
  };
}

function formatSignalMessage(result, signal) {
  const reasons = reasonsFor(result, signal);
  const tvUrl = tradingViewUrl(signal.symbol);
  return [
    '📈 Daytrade-signal',
    `Symbol: ${signal.symbol}`,
    `Riktning: ${directionSv(signal.direction)}`,
    `Status: ${signal.status}`,
    `Poäng: ${signal.score}/100`,
    `Risk: ${riskSv(signal.risk)}`,
    `TradingView: ${tvUrl}`,
    '',
    'Målzon: 1–2 %',
    `Nuvarande rörelse: ${pct(signal.currentMovePct)}`,
    `Kvar till första mål: ${pct(signal.remainingToTargetPct)}`,
    '',
    'Varför:',
    `• ${reasons[0]}`,
    `• ${reasons[1]}`,
    `• ${reasons[2]}`,
  ].join('\n');
}

async function sendMessage(message, payload = {}) {
  if (isReplayPayload(payload)) return replayBlocked();

  if (!isConfigured()) {
    safeDisabledLog();
    return { ok: false, skipped: true, reason: 'disabled_or_not_configured' };
  }

  try {
    return await notifier().send(message, payload);
  } catch (err) {
    console.warn('[Notifier] send failed:', err.message);
    return { ok: false, error: 'send_failed' };
  }
}

async function processScanResults(results, options = {}) {
  if (isReplayPayload(options) || (results || []).some((result) => isReplayPayload(result))) {
    return replayBlocked();
  }

  if (!enabled()) return { ok: true, sent: 0, skipped: 'disabled' };
  if (!notifier().isConfigured()) {
    safeDisabledLog();
    return { ok: true, sent: 0, skipped: 'not_configured' };
  }

  let sent = 0;
  for (const result of results || []) {
    const signal = normalizeSignal(result);
    if (!shouldNotifySignal(signal, result, options.feedStatus)) continue;

    const dedupe = signalDeduper.shouldSend(signal, Date.now(), cooldownMinutes());
    if (!dedupe.ok) continue;

    const message = formatSignalMessage(result, signal);
    const response = await sendMessage(message, { event: 'daytrade_signal', group: options.group || null, signal, result });
    if (response.ok) {
      signalDeduper.markSent(signal);
      sent++;
    }
  }

  return { ok: true, sent };
}

function systemStatus(health) {
  const status = String(health?.overallStatus || health?.systemstatus || 'OK').toUpperCase();
  if (status === 'CRITICAL' || status === 'KRITISK') return 'Kritisk';
  if (status === 'WARNING' || status === 'VARNING') return 'Varning';
  return 'OK';
}

// Returns true if this component represents a real operational problem worth paging
function isOperationalComponent(component) {
  if (SILENT_HEALTH_AREAS.has(component.area)) return false;
  const name = String(component.name || '');
  return !SILENT_COMPONENT_PATTERNS.some((re) => re.test(name));
}

function formatSystemMessage(health, status, component) {
  return [
    '⚠️ Systemstatus',
    `Status: ${status}`,
    component?.name ? `Komponent: ${component.name}` : null,
    component?.messageSv ? `Detalj: ${component.messageSv}` : null,
  ].filter((line) => line !== null).join('\n');
}

async function processSystemHealth(health) {
  const status = systemStatus(health);
  const becameImportant = (status === 'Varning' || status === 'Kritisk') && status !== lastSystemStatus;
  lastSystemStatus = status;

  if (!becameImportant) return { ok: true, sent: 0, skipped: 'no_status_change' };

  // Only consider components from operational areas — skip Machine/Learning metadata
  const operationalIssue = (health?.components || []).find(
    (c) =>
      isOperationalComponent(c) &&
      (c.severity === 'critical' || c.severity === 'warning' || c.status === 'BROKEN' || c.status === 'STALE'),
  );

  // If status changed but only due to non-operational components, suppress Telegram
  if (!operationalIssue) {
    return { ok: true, sent: 0, skipped: 'non_operational_only' };
  }

  return sendMessage(formatSystemMessage(health, status, operationalIssue), { event: 'system_status', status });
}

async function sendTestMessage() {
  if (!enabled()) {
    safeDisabledLog();
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  return sendMessage([
    '🧪 Testmeddelande — Notification Engine',
    '',
    'Detta är ett testmeddelande, inte en riktig signal.',
    '',
    'Symbol: TEST',
    'Status: Test',
    'Poäng: 100/100',
    '',
    'Notifications är aktiverat och kanalen är konfigurerad.',
  ].join('\n'), { event: 'notification_test' });
}

module.exports = {
  enabled,
  isConfigured,
  isReplayPayload,
  sendMessage,
  processScanResults,
  processSystemHealth,
  sendTestMessage,
};
