'use strict';

const crypto = require('crypto');

const redisService = require('../services/redisService');
const notificationService = require('./notificationService');
const { recordAlerts } = require('./alertEngine');
const { buildDaytradeSignal } = require('../scanner/daytradeSignalEngine');

const SOURCE = 'notification_engine_v2';
const RECENT_LIMIT = 100;

const KEYS = {
  config: 'notification:v2:config',
  status: 'notification:v2:status',
  recent: 'notification:v2:recent',
  dedupePrefix: 'notification:v2:dedupe:',
  ratePrefix: 'notification:v2:rate:',
};

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  fallback_logging: true,
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  quiet_hours_timezone: 'UTC',
  quiet_hours_allow_critical: true,
  max_alerts_per_minute: 8,
  strong_signal_min_score: 80,
  dedupe_ttl_seconds: {
    RISK_BLOCK: 30 * 60,
    RISK_PAUSE: 60 * 60,
    TRADE_OPENED: 15 * 60,
    TRADE_CLOSED: 15 * 60,
    EXIT_ENGINE_TAKE_PROFIT: 10 * 60,
    EXIT_ENGINE_TRAILING_STOP: 10 * 60,
    EXIT_ENGINE_MOMENTUM_FADE: 10 * 60,
    EXIT_ENGINE_TIMEOUT_SAVE: 10 * 60,
    STRONG_SIGNAL: 20 * 60,
    REPLAY_COMPLETED: 60 * 60,
    SYSTEM_HEALTH_ALERT: 30 * 60,
    TEST_ALERT: 5,
  },
});

let memoryConfig = { ...DEFAULT_CONFIG };
let recentMemory = [];
let dedupeMemory = new Map();
let rateMemory = new Map();
let latestStatus = null;
let dedupeLogThrottle = new Map();

function nowIso() {
  return new Date().toISOString();
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

function cleanKey(value) {
  return String(value || 'alert')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'alert';
}

function hashParts(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 14);
}

function minuteBucket(date = new Date()) {
  return date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

function parseMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function currentUtcMinutes() {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function normalizeSeverity(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'critisk') return 'critical';
  if (s === 'warning' || s === 'warn' || s === 'high') return 'warning';
  return 'info';
}

function normalizeConfig(input = {}) {
  const inObj = input && typeof input === 'object' ? input : {};
  const next = { ...DEFAULT_CONFIG, ...inObj };
  next.enabled = boolValue(next.enabled, true);
  next.fallback_logging = boolValue(next.fallback_logging, true);
  next.quiet_hours_enabled = boolValue(next.quiet_hours_enabled, false);
  next.quiet_hours_allow_critical = boolValue(next.quiet_hours_allow_critical, true);
  next.max_alerts_per_minute = Math.max(1, Math.min(60, Math.round(numberOr(next.max_alerts_per_minute, 8))));
  next.strong_signal_min_score = Math.max(0, Math.min(100, Math.round(numberOr(next.strong_signal_min_score, 80))));
  next.dedupe_ttl_seconds = { ...DEFAULT_CONFIG.dedupe_ttl_seconds, ...(inObj.dedupe_ttl_seconds || {}) };
  return next;
}

async function getConfig() {
  const cached = await redisService.getJson(KEYS.config, null);
  if (cached && typeof cached === 'object') {
    memoryConfig = normalizeConfig(cached);
    return memoryConfig;
  }
  await redisService.setJson(KEYS.config, memoryConfig, 0);
  return memoryConfig;
}

function validateConfigPatch(input = {}) {
  const accepted = {};
  const rejected = {};
  const obj = input && typeof input === 'object' ? input : {};
  const boolFields = ['enabled', 'fallback_logging', 'quiet_hours_enabled', 'quiet_hours_allow_critical'];
  for (const field of boolFields) {
    if (!(field in obj)) continue;
    if (typeof obj[field] !== 'boolean') rejected[field] = 'must_be_boolean';
    else accepted[field] = obj[field];
  }

  for (const field of ['quiet_hours_start', 'quiet_hours_end']) {
    if (!(field in obj)) continue;
    if (parseMinutes(obj[field]) == null) rejected[field] = 'must_be_HH:mm';
    else accepted[field] = obj[field];
  }

  if ('quiet_hours_timezone' in obj) {
    const tz = String(obj.quiet_hours_timezone || '').toUpperCase();
    if (tz !== 'UTC') rejected.quiet_hours_timezone = 'only_UTC_supported';
    else accepted.quiet_hours_timezone = 'UTC';
  }

  if ('max_alerts_per_minute' in obj) {
    const n = numberOr(obj.max_alerts_per_minute, null);
    if (n == null || n < 1 || n > 60) rejected.max_alerts_per_minute = 'must_be_1_to_60';
    else accepted.max_alerts_per_minute = Math.round(n);
  }

  if ('strong_signal_min_score' in obj) {
    const n = numberOr(obj.strong_signal_min_score, null);
    if (n == null || n < 0 || n > 100) rejected.strong_signal_min_score = 'must_be_0_to_100';
    else accepted.strong_signal_min_score = Math.round(n);
  }

  if ('dedupe_ttl_seconds' in obj) {
    const ttl = obj.dedupe_ttl_seconds;
    if (!ttl || typeof ttl !== 'object' || Array.isArray(ttl)) {
      rejected.dedupe_ttl_seconds = 'must_be_object';
    } else {
      const nextTtl = {};
      for (const [type, value] of Object.entries(ttl)) {
        if (!DEFAULT_CONFIG.dedupe_ttl_seconds[type]) {
          rejected[`dedupe_ttl_seconds.${type}`] = 'unknown_type';
          continue;
        }
        const n = numberOr(value, null);
        if (n == null || n < 5 || n > 86400) rejected[`dedupe_ttl_seconds.${type}`] = 'must_be_5_to_86400';
        else nextTtl[type] = Math.round(n);
      }
      if (Object.keys(nextTtl).length) accepted.dedupe_ttl_seconds = nextTtl;
    }
  }

  for (const key of Object.keys(obj)) {
    if (![...boolFields, 'quiet_hours_start', 'quiet_hours_end', 'quiet_hours_timezone', 'max_alerts_per_minute', 'strong_signal_min_score', 'dedupe_ttl_seconds'].includes(key)) {
      rejected[key] = 'field_not_allowed';
    }
  }

  return { accepted, rejected };
}

async function updateConfig(partial = {}) {
  const { accepted, rejected } = validateConfigPatch(partial);
  if (Object.keys(rejected).length) {
    console.warn(`[notification-v2] invalid config attempt: ${Object.keys(rejected).join(',')}`);
    return { ok: false, error: 'invalid_config', accepted, rejected, config: await getConfig() };
  }
  const current = await getConfig();
  const next = normalizeConfig({
    ...current,
    ...accepted,
    dedupe_ttl_seconds: {
      ...current.dedupe_ttl_seconds,
      ...(accepted.dedupe_ttl_seconds || {}),
    },
  });
  memoryConfig = next;
  await redisService.setJson(KEYS.config, next, 0);
  await updateStatus({ config_updated_at: nowIso() });
  console.log(`[notification-v2] config update: ${Object.keys(accepted).join(',') || 'no_changes'}`);
  return { ok: true, config: next, updated: accepted, rejected: {} };
}

function inQuietHours(config) {
  if (!config.quiet_hours_enabled) return false;
  if (String(config.quiet_hours_timezone || 'UTC').toUpperCase() !== 'UTC') return false;
  const start = parseMinutes(config.quiet_hours_start);
  const end = parseMinutes(config.quiet_hours_end);
  if (start == null || end == null || start === end) return false;
  const now = currentUtcMinutes();
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function pruneMemory() {
  const now = Date.now();
  for (const [key, expiresAt] of dedupeMemory.entries()) {
    if (expiresAt <= now) dedupeMemory.delete(key);
  }
  for (const [key, row] of rateMemory.entries()) {
    if (row.expiresAt <= now) rateMemory.delete(key);
  }
  const tenMinAgo = now - 10 * 60 * 1000;
  for (const [key, ts] of dedupeLogThrottle.entries()) {
    if (ts < tenMinAgo) dedupeLogThrottle.delete(key);
  }
}

function dedupeTtl(config, type) {
  const ttl = numberOr(config.dedupe_ttl_seconds?.[type], DEFAULT_CONFIG.dedupe_ttl_seconds[type]);
  return Math.max(1, Math.round(ttl || 60));
}

async function dedupeHit(key) {
  pruneMemory();
  if (dedupeMemory.get(key) > Date.now()) return true;
  return !!await redisService.getJson(`${KEYS.dedupePrefix}${key}`, null);
}

async function markDedupe(key, ttlSeconds) {
  dedupeMemory.set(key, Date.now() + ttlSeconds * 1000);
  await redisService.setJson(`${KEYS.dedupePrefix}${key}`, { at: nowIso() }, ttlSeconds);
}

async function rateAllowed(config) {
  pruneMemory();
  const bucket = minuteBucket();
  const key = `${KEYS.ratePrefix}${bucket}`;
  const count = await redisService.incrWithExpire(key, 70);
  rateMemory.set(bucket, { count, expiresAt: Date.now() + 70_000 });
  if (count > config.max_alerts_per_minute) return { ok: false, count };
  return { ok: true, count };
}

function alertTitle(type, data) {
  if (data.titleSv) return data.titleSv;
  if (type === 'RISK_BLOCK') return `${data.symbol || 'UNKNOWN'}: risk block`;
  if (type === 'RISK_PAUSE') return 'Systempaus aktiverad';
  if (type === 'TRADE_OPENED') return `${data.symbol || 'UNKNOWN'}: paper trade öppnad`;
  if (type === 'TRADE_CLOSED') return `${data.symbol || 'UNKNOWN'}: paper trade stängd`;
  if (type === 'EXIT_ENGINE_TAKE_PROFIT') return `${data.symbol || 'UNKNOWN'}: Exitmotor tog vinst`;
  if (type === 'EXIT_ENGINE_TRAILING_STOP') return `${data.symbol || 'UNKNOWN'}: trailing stop`;
  if (type === 'EXIT_ENGINE_MOMENTUM_FADE') return `${data.symbol || 'UNKNOWN'}: momentum fade`;
  if (type === 'EXIT_ENGINE_TIMEOUT_SAVE') return `${data.symbol || 'UNKNOWN'}: timeout räddad`;
  if (type === 'STRONG_SIGNAL') return `${data.symbol || 'UNKNOWN'}: stark signal`;
  if (type === 'REPLAY_COMPLETED') return 'Replay klar';
  if (type === 'SYSTEM_HEALTH_ALERT') return 'Systemhälsa kräver åtgärd';
  return 'Notification test';
}

function alertMessage(type, data) {
  if (data.messageSv) return data.messageSv;
  if (type === 'RISK_BLOCK') return `Riskmotorn blockerade ${data.symbol || 'UNKNOWN'}: ${(data.reasons || []).join(', ') || 'risk_block'}.`;
  if (type === 'RISK_PAUSE') return `Riskmotorn pausade nya entries: ${(data.reasons || []).join(', ') || 'riskgräns nådd'}.`;
  if (type === 'TRADE_OPENED') return `Paper entry öppnad för ${data.symbol || 'UNKNOWN'} med positionsstorlek ${data.position_size_sek ?? 'okänd'} SEK.`;
  if (type === 'TRADE_CLOSED') return `Paper trade stängd för ${data.symbol || 'UNKNOWN'}: ${data.result || data.reasonSv || 'okänt resultat'}.`;
  if (type === 'EXIT_ENGINE_TAKE_PROFIT') return `Exit Engine v1 tog vinst i ${data.symbol || 'UNKNOWN'} vid ${data.pnl_pct ?? 'okänd'}% PnL.`;
  if (type === 'EXIT_ENGINE_TRAILING_STOP') return `Exit Engine v1 stängde ${data.symbol || 'UNKNOWN'} via trailing stop vid ${data.pnl_pct ?? 'okänd'}% PnL.`;
  if (type === 'EXIT_ENGINE_MOMENTUM_FADE') return `Exit Engine v1 stängde ${data.symbol || 'UNKNOWN'} när momentum fadeade.`;
  if (type === 'EXIT_ENGINE_TIMEOUT_SAVE') return `Exit Engine v1 stängde ${data.symbol || 'UNKNOWN'} före timeout.`;
  if (type === 'STRONG_SIGNAL') return `Stark signal i ${data.group || 'live'}: score ${data.score ?? '–'}/100.`;
  if (type === 'REPLAY_COMPLETED') return `Replay ${data.session_id || ''} klar: ${data.total_trades ?? 0} trades, win rate ${data.win_rate ?? 0}%.`;
  if (type === 'SYSTEM_HEALTH_ALERT') return data.component_message || 'System Health rapporterar varning.';
  return 'Notification Engine v2 test.';
}

function suggestedAction(type) {
  if (type === 'RISK_BLOCK') return 'Kontrollera riskpanelen. Ingen trade skapades.';
  if (type === 'RISK_PAUSE') return 'Låt systempausen ligga tills riskgränsen är återställd.';
  if (type === 'TRADE_OPENED') return 'Följ paper-positionen. Detta är inte en riktig order.';
  if (type === 'REPLAY_COMPLETED') return 'Öppna Replay Intelligence och jämför riskutfall.';
  if (String(type || '').startsWith('EXIT_ENGINE_')) return 'Granska senaste exitbeslut i Exitmotor-panelen.';
  if (type === 'SYSTEM_HEALTH_ALERT') return 'Öppna System Health och kontrollera detaljerna.';
  return 'Ingen åtgärd krävs.';
}

function formatMessage(alert) {
  return [
    `[${alert.type}] ${alert.titleSv}`,
    alert.symbol ? `Symbol: ${alert.symbol}` : null,
    `Severity: ${alert.severity}`,
    alert.messageSv,
    alert.suggestedActionSv ? `Åtgärd: ${alert.suggestedActionSv}` : null,
  ].filter(Boolean).join('\n');
}

function buildAlert(input = {}) {
  const type = String(input.type || 'TEST_ALERT').toUpperCase();
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  const severity = normalizeSeverity(input.severity || data.severity);
  const symbol = data.symbol ? String(data.symbol).toUpperCase() : null;
  const dedupeKey = cleanKey(input.dedupeKey || [
    type,
    symbol,
    data.session_id,
    Array.isArray(data.reasons) ? data.reasons.join('_') : null,
    data.status,
  ].filter(Boolean).join('_') || `${type}_${hashParts([JSON.stringify(data)])}`);
  const now = nowIso();
  return {
    id: `${type.toLowerCase()}_${hashParts([dedupeKey, now])}`,
    key: `notification_v2_${dedupeKey}`,
    type,
    severity,
    status: 'active',
    source: SOURCE,
    symbol,
    titleSv: alertTitle(type, data),
    messageSv: alertMessage(type, data),
    suggestedActionSv: input.suggestedActionSv || suggestedAction(type),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    dedupeKey,
    data,
  };
}

async function storeRecent(row) {
  const current = await redisService.getJson(KEYS.recent, recentMemory);
  const next = [row, ...(Array.isArray(current) ? current : recentMemory)].slice(0, RECENT_LIMIT);
  recentMemory = next;
  await redisService.setJson(KEYS.recent, next, 24 * 60 * 60);
}

async function updateStatus(patch) {
  latestStatus = {
    ok: true,
    source: SOURCE,
    ...latestStatus,
    ...patch,
    updatedAt: nowIso(),
    redis: redisService.status(),
  };
  await redisService.setJson(KEYS.status, latestStatus, 0);
}

async function sendAlert(input = {}, opts = {}) {
  const config = await getConfig();
  const alert = buildAlert(input);
  const isDryRun = opts.dry_run === true;
  const ttl = dedupeTtl(config, alert.type);

  if (notificationService.isReplayPayload(input) || notificationService.isReplayPayload(input.data)) {
    const delivery = { ok: false, skipped: true, reason: 'replay_mode_blocked', dry_run: isDryRun };
    if (!isDryRun) {
      const row = { ...alert, delivery };
      await storeRecent(row);
      await updateStatus({ last_alert: row, last_skip_reason: 'replay_mode_blocked' });
    }
    console.warn('[notification] replay payload blocked');
    return delivery;
  }

  if (!config.enabled) {
    const delivery = { ok: false, skipped: true, reason: 'notification_v2_disabled', dry_run: isDryRun };
    if (!isDryRun) {
      const row = { ...alert, delivery };
      await storeRecent(row);
      await updateStatus({ last_alert: row, last_skip_reason: 'notification_v2_disabled' });
    }
    return delivery;
  }

  if (await dedupeHit(alert.dedupeKey)) {
    const delivery = { ok: false, skipped: true, reason: 'duplicate_alert_blocked', dry_run: isDryRun };
    if (!isDryRun) {
      const row = { ...alert, delivery };
      await storeRecent(row);
      await updateStatus({ last_alert: row, duplicate_blocked_at: nowIso(), last_skip_reason: 'duplicate_alert_blocked' });
      const now = Date.now();
      const lastLogged = dedupeLogThrottle.get(alert.dedupeKey) || 0;
      if (now - lastLogged > 5 * 60 * 1000) {
        console.log(`[notification-v2] duplicate suppressed: ${alert.dedupeKey}`);
        dedupeLogThrottle.set(alert.dedupeKey, now);
      }
    }
    return delivery;
  }

  if (inQuietHours(config) && !(alert.severity === 'critical' && config.quiet_hours_allow_critical)) {
    const delivery = { ok: false, skipped: true, reason: 'quiet_hours', dry_run: isDryRun };
    if (!isDryRun) {
      const row = { ...alert, delivery };
      recordAlerts([alert]);
      await storeRecent(row);
      await updateStatus({ last_alert: row, last_skip_reason: 'quiet_hours' });
      console.log(`[notification-v2] quiet hours suppressed ${alert.type}`);
    }
    return delivery;
  }

  if (!isDryRun) {
    const rate = await rateAllowed(config);
    if (!rate.ok) {
      const delivery = { ok: false, skipped: true, reason: 'rate_limited' };
      const row = { ...alert, delivery };
      recordAlerts([alert]);
      await storeRecent(row);
      await updateStatus({ last_alert: row, last_skip_reason: 'rate_limited' });
      console.warn(`[notification-v2] rate limited ${alert.type}`);
      return delivery;
    }
  }

  if (isDryRun) {
    const wouldProvider = notificationService.isConfigured()
      ? (process.env.NOTIFICATION_PROVIDER || 'telegram')
      : 'fallback_log';
    return { ok: true, dry_run: true, would_send: true, provider: wouldProvider };
  }

  let delivery;
  if (notificationService.isConfigured()) {
    delivery = await notificationService.sendMessage(formatMessage(alert), {
      event: 'notification_v2',
      alert_type: alert.type,
      severity: alert.severity,
      symbol: alert.symbol,
      notification_v2: true,
    });
  } else {
    delivery = { ok: true, provider: 'fallback_log', fallback: true };
    if (config.fallback_logging) console.log(`[notification-v2] ${formatMessage(alert).replace(/\n/g, ' | ')}`);
  }

  await markDedupe(alert.dedupeKey, ttl);
  const row = { ...alert, delivery };
  recordAlerts([alert]);
  await storeRecent(row);
  await updateStatus({ last_alert: row, last_delivery: delivery, last_skip_reason: null });
  return delivery;
}

async function processRiskEvaluation(evaluation = {}) {
  if (!evaluation || evaluation.evaluation_source === 'replay' || evaluation.mode === 'replay') return { ok: true, skipped: true, reason: 'replay_ignored' };
  if (evaluation.evaluation_source !== 'paper_pipeline') return { ok: true, skipped: true, reason: 'not_live_pipeline' };
  const tasks = [];
  if (evaluation.allowed === false || (evaluation.block_reasons || []).length) {
    tasks.push(sendAlert({
      type: 'RISK_BLOCK',
      severity: evaluation.pause_trading ? 'critical' : 'warning',
      dedupeKey: `risk_block_${evaluation.symbol}_${(evaluation.block_reasons || []).join('_')}`,
      data: {
        symbol: evaluation.symbol,
        reasons: evaluation.block_reasons || [],
        position_size_sek: evaluation.position_size_sek,
        source: evaluation.evaluation_source,
      },
    }));
  }
  if (evaluation.pause_trading) {
    tasks.push(sendAlert({
      type: 'RISK_PAUSE',
      severity: 'critical',
      dedupeKey: `risk_pause_${(evaluation.pause_reasons || []).join('_') || evaluation.symbol || 'global'}`,
      data: {
        symbol: evaluation.symbol,
        reasons: evaluation.pause_reasons || evaluation.block_reasons || [],
        source: evaluation.evaluation_source,
      },
    }));
  }
  return Promise.all(tasks);
}

async function processPaperEvent(event = {}) {
  if (!event || event.mode !== 'paper') return { ok: true, skipped: true, reason: 'not_paper_event' };
  if (event.type === 'TRADE_OPENED') {
    return sendAlert({
      type: 'TRADE_OPENED',
      severity: 'info',
      dedupeKey: `trade_opened_${event.symbol}_${event.signalFamily}_${event.signalSubtype}`,
      data: {
        symbol: event.symbol,
        position_size_sek: event.riskPositionSizeSek,
        confidence: event.confidenceScore,
      },
    });
  }
  if (event.type === 'TRADE_CLOSED') {
    return sendAlert({
      type: 'TRADE_CLOSED',
      severity: /loss|stop/i.test(event.status || event.reasonSv || '') ? 'warning' : 'info',
      dedupeKey: `trade_closed_${event.symbol}_${event.status || event.reasonSv || ''}`,
      data: {
        symbol: event.symbol,
        result: event.status,
        reasonSv: event.reasonSv,
      },
    });
  }
  return { ok: true, skipped: true, reason: 'event_type_not_notifiable' };
}

async function processExitEngineDecision(decision = {}, options = {}) {
  if (!decision || decision.source !== 'exit_engine_v1') return { ok: true, skipped: true, reason: 'not_exit_engine_decision' };
  if (decision.replay_mode === true || options.replay_mode === true || decision.mode === 'replay') {
    return { ok: true, skipped: true, reason: 'replay_ignored' };
  }
  if (!['EXIT', 'TAKE_PROFIT'].includes(decision.action)) return { ok: true, skipped: true, reason: 'not_closing_exit_action' };

  let type = null;
  if (decision.exit_reason_code === 'near_target_profit') type = 'EXIT_ENGINE_TAKE_PROFIT';
  if (decision.exit_reason_code === 'trailing_stop') type = 'EXIT_ENGINE_TRAILING_STOP';
  if (decision.exit_reason_code === 'momentum_fade') type = 'EXIT_ENGINE_MOMENTUM_FADE';
  if (decision.exit_reason_code === 'timeout_intelligence') type = 'EXIT_ENGINE_TIMEOUT_SAVE';
  if (!type) return { ok: true, skipped: true, reason: 'reason_not_notifiable' };

  return sendAlert({
    type,
    severity: decision.exit_reason_code === 'trailing_stop' ? 'warning' : 'info',
    dedupeKey: `${type}_${decision.symbol}_${decision.trade_id}_${decision.exit_reason_code}`,
    data: {
      symbol: decision.symbol,
      trade_id: decision.trade_id,
      pnl_pct: decision.current_pnl_pct,
      exit_reason_code: decision.exit_reason_code,
      reason: decision.reason,
      source: decision.source,
    },
  });
}

async function processStrongSignals(results = [], options = {}) {
  if (notificationService.isReplayPayload(options)) return notificationService.sendMessage('blocked', { replay_mode: true });
  const config = await getConfig();
  let sent = 0;
  for (const result of results || []) {
    if (notificationService.isReplayPayload(result)) continue;
    let daytrade = {};
    try { daytrade = buildDaytradeSignal({ ...result, daytradeIgnoreStale: true }); } catch (_) {}
    const score = numberOr(result.daytradeScore ?? result.tradeScore ?? result.confidenceScore ?? daytrade.daytradeScore, 0);
    if (score < config.strong_signal_min_score) continue;
    const symbol = result.symbol;
    const delivery = await sendAlert({
      type: 'STRONG_SIGNAL',
      severity: score >= 90 ? 'warning' : 'info',
      dedupeKey: `strong_signal_${options.group || 'live'}_${symbol}`,
      data: {
        symbol,
        group: options.group || 'live',
        score,
        direction: daytrade.daytradeDirection || result.nextMoveBias || result.direction,
      },
    });
    if (delivery.ok) sent++;
  }
  return { ok: true, sent };
}

async function processReplaySummary(summary = {}) {
  if (!summary || !summary.session_id) return { ok: true, skipped: true, reason: 'missing_summary' };
  return sendAlert({
    type: 'REPLAY_COMPLETED',
    severity: 'info',
    dedupeKey: `replay_completed_${summary.session_id}`,
    data: {
      session_id: summary.session_id,
      status: summary.status,
      total_trades: summary.total_trades,
      win_rate: summary.win_rate,
      total_pl_pct: summary.total_pl_pct,
      risk_blocks: summary.risk_engine?.risk_blocks,
    },
  });
}

async function processSystemHealth(health = {}) {
  const status = String(health.overallStatus || health.systemstatus || 'OK').toUpperCase();
  if (!['WARNING', 'VARNING', 'CRITICAL', 'KRITISK'].includes(status)) {
    return { ok: true, skipped: true, reason: 'system_ok' };
  }
  const component = (health.components || []).find((c) => c.severity === 'critical' || c.severity === 'warning' || c.status === 'BROKEN' || c.status === 'STALE');
  return sendAlert({
    type: 'SYSTEM_HEALTH_ALERT',
    severity: status === 'CRITICAL' || status === 'KRITISK' ? 'critical' : 'warning',
    dedupeKey: `system_health_${status}_${component?.name || 'overall'}`,
    data: {
      status,
      component: component?.name || null,
      component_message: component?.messageSv || health.summarySv || 'System Health varnar.',
    },
  });
}

async function getRecentAlerts(limit = 50) {
  const recent = await redisService.getJson(KEYS.recent, recentMemory);
  return (Array.isArray(recent) ? recent : recentMemory).slice(0, Math.min(Number(limit) || 50, RECENT_LIMIT));
}

async function getStatus() {
  const config = await getConfig();
  const redisStatus = await redisService.getJson(KEYS.status, latestStatus);
  return {
    ok: true,
    source: SOURCE,
    enabled: config.enabled,
    configured: notificationService.isConfigured(),
    provider: process.env.NOTIFICATION_PROVIDER || 'telegram',
    fallback_logging: config.fallback_logging,
    quiet_hours_active: inQuietHours(config),
    config,
    recent_count: (await getRecentAlerts(RECENT_LIMIT)).length,
    status: redisStatus || latestStatus,
    redis: redisService.status(),
    keys: KEYS,
    timestamp: nowIso(),
  };
}

async function runTestAlert(type = 'TEST_ALERT', opts = {}) {
  const normalized = String(type || 'TEST_ALERT').toUpperCase();
  const id = Date.now().toString(36);

  if (opts.dry_run) {
    return sendAlert({
      type: normalized,
      severity: 'info',
      dedupeKey: `test_dryrun_${normalized.toLowerCase()}_${id}`,
      data: { titleSv: `[dry-run] ${normalized}` },
    }, opts);
  }

  if (normalized === 'RISK_BLOCK') {
    return sendAlert({ type: 'RISK_BLOCK', severity: 'warning', dedupeKey: `test_risk_block_${id}`, data: { symbol: 'TEST', reasons: ['low_confidence'] } });
  }
  if (normalized === 'RISK_PAUSE') {
    return sendAlert({ type: 'RISK_PAUSE', severity: 'critical', dedupeKey: `test_risk_pause_${id}`, data: { symbol: 'TEST', reasons: ['daily_loss_limit'] } });
  }
  if (normalized === 'STRONG_SIGNAL') {
    return processStrongSignals([{ symbol: 'TEST', tradeScore: 95, confidenceScore: 95, nextMoveBias: 'UP', price: 100 }], { group: 'test' });
  }
  if (normalized === 'REPLAY_COMPLETED') {
    return processReplaySummary({ session_id: `test_${id}`, status: 'completed', total_trades: 3, win_rate: 66.7, total_pl_pct: 0.8, risk_engine: { risk_blocks: 1 } });
  }
  if (normalized === 'SYSTEM_HEALTH_ALERT') {
    return processSystemHealth({ overallStatus: 'WARNING', summarySv: 'Testvarning', components: [{ name: 'Notification test', status: 'STALE', severity: 'warning', messageSv: 'Testvarning från Notification Engine v2.' }] });
  }
  return sendAlert({ type: 'TEST_ALERT', severity: 'info', dedupeKey: `test_alert_${id}`, data: { titleSv: 'Notification Engine v2 test', messageSv: 'Testalert skickad.' } });
}

module.exports = {
  SOURCE,
  KEYS,
  DEFAULT_CONFIG,
  getStatus,
  getConfig,
  updateConfig,
  getRecentAlerts,
  sendAlert,
  processRiskEvaluation,
  processPaperEvent,
  processExitEngineDecision,
  processStrongSignals,
  processReplaySummary,
  processSystemHealth,
  runTestAlert,
};
