'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALERT_DIR = path.resolve(__dirname, '../../data/alerts');
const ALERT_PATH = path.join(ALERT_DIR, 'alerts.jsonl');
const MAX_RETURN = 500;
const RESOLVED_RECENT_MS = 24 * 60 * 60 * 1000;

function ensureDir() {
  if (!fs.existsSync(ALERT_DIR)) fs.mkdirSync(ALERT_DIR, { recursive: true });
}

function slug(value) {
  return String(value || 'alert')
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'alert';
}

function stableHash(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 14);
}

function normalizeSeverity(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'critisk') return 'critical';
  if (s === 'high' || s === 'warning' || s === 'warn' || s === 'watch') return 'warning';
  return 'info';
}

function severityRank(severity) {
  return { critical: 0, warning: 1, info: 2 }[normalizeSeverity(severity)] ?? 2;
}

function normalizeStatus(alert) {
  const s = String(alert?.status || '').toLowerCase();
  if (s === 'resolved') return 'resolved';
  if (s === 'acknowledged' || alert?.acknowledged === true) return 'acknowledged';
  return 'active';
}

function legacyKey(input) {
  const type = input.type || 'alert';
  const title = input.titleSv || '';
  const text = `${title} ${input.messageSv || ''}`;
  const symbol = input.symbol ? `${slug(input.symbol)}_` : '';

  if (/alpaca provider/i.test(title)) return 'alpaca_provider_broken';
  if (/binance provider/i.test(title)) return 'binance_provider_broken';
  if (/stock scanner/i.test(title)) return 'stock_scanner_broken';
  if (/crypto scanner/i.test(title)) return 'crypto_scanner_broken';
  if (/\/api\/scan\/stocks/i.test(title)) return 'api_scan_stocks_broken';
  if (/\/api\/scan\/crypto/i.test(title)) return 'api_scan_crypto_broken';
  if (/momentum intelligence/i.test(title)) return 'momentum_intelligence_missing';
  if (/real mtf/i.test(title)) return 'real_mtf_missing';
  if (/market state graph/i.test(title)) return 'market_state_graph_missing';
  if (/learning orchestrator/i.test(title)) return 'learning_orchestrator_missing';
  if (/confidence decay/i.test(title)) return 'confidence_decay_missing';
  if (/paper trading/i.test(text)) return `paper_trading_${slug(type)}`;

  return `${symbol}${slug(type)}_${slug(title)}`;
}

function makeKey(input) {
  if (input.key) return slug(input.key);
  if (input.source && input.type && input.symbol) return `${slug(input.source)}_${slug(input.type)}_${slug(input.symbol)}`;
  return legacyKey(input);
}

function makeAlert(input) {
  const createdAt = input.createdAt || new Date().toISOString();
  const key = makeKey(input);
  const now = input.lastSeenAt || input.updatedAt || createdAt;
  const severity = normalizeSeverity(input.severity);
  const status = normalizeStatus(input);
  const id = input.id || key || `${input.type}_${stableHash([input.type, input.symbol || '', input.titleSv])}`;
  return {
    id,
    key,
    type: input.type,
    severity,
    status,
    source: input.source || (String(input.type || '').startsWith('SYSTEM') ? 'systemHealth' : 'alertEngine'),
    symbol: input.symbol || null,
    titleSv: input.titleSv,
    messageSv: input.messageSv,
    suggestedActionSv: input.suggestedActionSv || null,
    createdAt,
    updatedAt: input.updatedAt || now,
    lastSeenAt: input.lastSeenAt || now,
    count: Number.isFinite(input.count) ? Math.max(1, input.count) : 1,
    acknowledged: status === 'acknowledged',
    acknowledgedAt: input.acknowledgedAt || null,
    resolvedAt: input.resolvedAt || null,
  };
}

function readAlerts() {
  try {
    if (!fs.existsSync(ALERT_PATH)) return [];
    return fs.readFileSync(ALERT_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeAlerts(alerts) {
  ensureDir();
  fs.writeFileSync(ALERT_PATH, alerts.map((a) => JSON.stringify(a)).join('\n') + (alerts.length ? '\n' : ''), 'utf8');
}

function normalizeAlert(alert) {
  return makeAlert({
    ...alert,
    key: alert.key || legacyKey(alert),
    status: normalizeStatus(alert),
    severity: normalizeSeverity(alert.severity),
    source: alert.source || (String(alert.type || '').startsWith('SYSTEM') || /är BROKEN|: STALE|: DISABLED/i.test(alert.titleSv || '') ? 'systemHealth' : 'live'),
    updatedAt: alert.updatedAt || alert.lastSeenAt || alert.createdAt,
    lastSeenAt: alert.lastSeenAt || alert.updatedAt || alert.createdAt,
    count: Number.isFinite(alert.count) ? alert.count : 1,
  });
}

function isNewer(a, b) {
  return new Date(a.lastSeenAt || a.updatedAt || a.createdAt).getTime() >= new Date(b.lastSeenAt || b.updatedAt || b.createdAt).getTime();
}

function mergeAlerts(existing, incoming) {
  const keepIncomingText = isNewer(incoming, existing);
  const activeWins = existing.status === 'active' || incoming.status === 'active';
  const latestStatus = keepIncomingText ? incoming.status : existing.status;
  return {
    ...existing,
    ...(keepIncomingText ? {
      type: incoming.type,
      source: incoming.source,
      titleSv: incoming.titleSv,
      messageSv: incoming.messageSv,
      suggestedActionSv: incoming.suggestedActionSv,
      symbol: incoming.symbol,
    } : {}),
    id: existing.id || incoming.id,
    key: existing.key || incoming.key,
    severity: severityRank(incoming.severity) < severityRank(existing.severity) ? incoming.severity : existing.severity,
    status: activeWins ? 'active' : latestStatus,
    acknowledged: activeWins ? false : latestStatus === 'acknowledged',
    createdAt: new Date(existing.createdAt) <= new Date(incoming.createdAt) ? existing.createdAt : incoming.createdAt,
    updatedAt: isNewer(incoming, existing) ? incoming.updatedAt : existing.updatedAt,
    lastSeenAt: isNewer(incoming, existing) ? incoming.lastSeenAt : existing.lastSeenAt,
    count: (Number(existing.count) || 1) + (Number(incoming.count) || 1),
    acknowledgedAt: incoming.acknowledgedAt || existing.acknowledgedAt || null,
    resolvedAt: incoming.resolvedAt || existing.resolvedAt || null,
  };
}

function compactAlerts(rows) {
  const byKey = new Map();
  for (const raw of rows || []) {
    if (!raw?.type || !raw?.titleSv || !raw?.messageSv) continue;
    const alert = normalizeAlert(raw);
    const existing = byKey.get(alert.key);
    byKey.set(alert.key, existing ? mergeAlerts(existing, alert) : alert);
  }
  return Array.from(byKey.values()).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function recordAlerts(inputs) {
  const alerts = compactAlerts(readAlerts());
  const byKey = new Map(alerts.map((a) => [a.key, a]));
  const now = new Date().toISOString();
  let changed = alerts.length !== readAlerts().length;
  const touched = [];

  for (const input of inputs || []) {
    if (!input?.type || !input?.titleSv || !input?.messageSv) continue;
    const incoming = makeAlert({ ...input, status: 'active', updatedAt: now, lastSeenAt: now });
    const existing = byKey.get(incoming.key);
    if (existing) {
      existing.type = incoming.type;
      existing.source = incoming.source;
      existing.severity = incoming.severity;
      existing.symbol = incoming.symbol;
      existing.titleSv = incoming.titleSv;
      existing.messageSv = incoming.messageSv;
      existing.suggestedActionSv = incoming.suggestedActionSv;
      existing.updatedAt = now;
      existing.lastSeenAt = now;
      existing.count = (Number(existing.count) || 1) + 1;
      existing.resolvedAt = null;
      if (existing.status === 'resolved') existing.status = 'active';
      existing.acknowledged = existing.status === 'acknowledged';
      touched.push(existing);
      changed = true;
      continue;
    }

    alerts.push(incoming);
    byKey.set(incoming.key, incoming);
    touched.push(incoming);
    changed = true;
  }

  if (changed) writeAlerts(alerts);
  return touched;
}

function resolveMissingSystemAlerts(activeKeys, source = 'systemHealth') {
  const keys = new Set(activeKeys || []);
  const alerts = compactAlerts(readAlerts());
  const now = new Date().toISOString();
  let resolved = 0;

  for (const alert of alerts) {
    if (alert.source !== source) continue;
    if (alert.status !== 'active' && alert.status !== 'acknowledged') continue;
    if (keys.has(alert.key)) continue;
    alert.status = 'resolved';
    alert.acknowledged = false;
    alert.updatedAt = now;
    alert.resolvedAt = alert.resolvedAt || now;
    resolved++;
  }

  if (resolved) writeAlerts(alerts);
  return { resolved };
}

function acknowledgeAlerts(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids].filter(Boolean));
  if (set.size === 0) return { acknowledged: 0 };
  const alerts = compactAlerts(readAlerts());
  let count = 0;
  const next = alerts.map((a) => {
    if ((set.has(a.id) || set.has(a.key)) && a.status === 'active') {
      count++;
      const now = new Date().toISOString();
      return { ...a, status: 'acknowledged', acknowledged: true, acknowledgedAt: now, updatedAt: now };
    }
    return a;
  });
  if (count) writeAlerts(next);
  return { acknowledged: count };
}

function severityFromHealth(severity) {
  return normalizeSeverity(severity);
}

function componentKey(c) {
  const title = `${c?.name || ''} ${c?.area || ''}`;
  if (/alpaca provider/i.test(title)) return 'alpaca_provider_broken';
  if (/binance provider/i.test(title)) return 'binance_provider_broken';
  if (/stock scanner/i.test(title)) return 'stock_scanner_broken';
  if (/crypto scanner/i.test(title)) return 'crypto_scanner_broken';
  if (/\/api\/scan\/stocks/i.test(title)) return 'api_scan_stocks_broken';
  if (/\/api\/scan\/crypto/i.test(title)) return 'api_scan_crypto_broken';
  if (/momentum intelligence/i.test(title)) return 'momentum_intelligence_missing';
  if (/real mtf/i.test(title)) return 'real_mtf_missing';
  if (/market state graph/i.test(title)) return 'market_state_graph_missing';
  if (/learning orchestrator/i.test(title)) return 'learning_orchestrator_missing';
  if (/confidence decay/i.test(title)) return 'confidence_decay_missing';
  return `${slug(c?.area || 'system')}_${slug(c?.name || 'component')}`;
}

function isStockComponent(c) {
  return /stock scanner|alpaca provider|\/api\/scan\/stocks/i.test(`${c?.name || ''} ${c?.messageSv || ''}`);
}

function isMarketClosed(health) {
  return health?.stockFeed?.status === 'MARKET_CLOSED' || health?.feeds?.stocks?.status === 'MARKET_CLOSED';
}

function alertsFromSystemHealth(health) {
  const out = [];
  const marketClosed = isMarketClosed(health);

  if (marketClosed) {
    out.push({
      key: 'stock_market_closed',
      source: 'systemHealth',
      type: 'SYSTEM_INFO',
      severity: 'info',
      titleSv: 'Marknaden är stängd',
      messageSv: 'Marknaden är stängd — senaste handelspass används.',
      suggestedActionSv: null,
    });
  }

  for (const c of health?.components || []) {
    const key = componentKey(c);
    if (marketClosed && isStockComponent(c)) continue;

    if (c.status === 'BROKEN' || c.severity === 'critical') {
      out.push({
        key,
        source: 'systemHealth',
        type: c.severity === 'critical' ? 'SYSTEM_CRITICAL' : 'SYSTEM_HEALTH_WARNING',
        severity: severityFromHealth(c.severity),
        titleSv: `${c.name} är BROKEN`,
        messageSv: c.messageSv,
        suggestedActionSv: c.suggestedActionSv || 'Kontrollera PM2 och serverloggar.',
      });
    } else if (c.status === 'STALE' || c.status === 'DISABLED' || c.severity === 'warning') {
      const type = /learning|rule|profile|calibration/i.test(`${c.name} ${c.area}`) ? 'LEARNING_STALE'
        : /machine|backfill|replay|outcomes|cache/i.test(`${c.name} ${c.area}`) ? 'MACHINE_STALE'
        : 'SYSTEM_HEALTH_WARNING';
      out.push({
        key,
        source: 'systemHealth',
        type,
        severity: severityFromHealth(c.severity),
        titleSv: `${c.name}: ${c.status}`,
        messageSv: c.messageSv,
        suggestedActionSv: c.suggestedActionSv || 'Öppna System Health och kontrollera detaljerna.',
      });
    }
  }
  return out;
}

function alertsFromScannerResults(results, source = 'live') {
  const out = [];
  for (const r of results || []) {
    const symbol = r.symbol || null;
    if (!symbol) continue;

    if (r.watchMode || r.momentumWatchMode || r.liquiditySweepWatchMode) {
      out.push({
        key: `${source}_watch_mode_triggered_${symbol}`,
        source,
        type: 'WATCH_MODE_TRIGGERED',
        severity: 'info',
        symbol,
        titleSv: `${symbol}: WATCH_MODE`,
        messageSv: r.watchModeReasonSv || 'Systemet markerar bevakningsläge utan köp/sälj-automation.',
        suggestedActionSv: 'Bevaka manuellt. Ingen order skapas automatiskt.',
      });
    }

    if ((r.momentumBacktestApplied && (r.momentumBacktestAdjustment || 0) > 0) ||
        ((r.momentumContinuationScore || 0) >= 71 && ['confirmed', 'aligned'].includes(r.mtfAlignment) && r.fakeoutRiskLevel !== 'high')) {
      out.push({
        key: `${source}_momentum_confirmed_${symbol}`,
        source,
        type: 'MOMENTUM_CONFIRMED',
        severity: 'info',
        symbol,
        titleSv: `${symbol}: momentum bekräftat`,
        messageSv: `Momentum ${r.momentumContinuationScore ?? '–'}/100 med MTF ${r.mtfAlignment || '–'}.`,
        suggestedActionSv: 'Kontrollera setup manuellt. Ingen order skapas automatiskt.',
      });
    }

    if (r.fakeoutRiskLevel === 'high' || (r.fakeoutProbability || 0) >= 70) {
      out.push({
        key: `${source}_fakeout_risk_high_${symbol}`,
        source,
        type: 'FAKEOUT_RISK_HIGH',
        severity: 'warning',
        symbol,
        titleSv: `${symbol}: hög fakeout-risk`,
        messageSv: r.fakeoutExplanationSv || `FakeoutProbability ${r.fakeoutProbability}/100.`,
        suggestedActionSv: 'Var försiktig. Vänta på bättre bekräftelse.',
      });
    }

    if (['conflicting', 'full_conflict'].includes(r.mtfAlignment)) {
      out.push({
        key: `${source}_mtf_conflict_${symbol}`,
        source,
        type: 'MTF_CONFLICT',
        severity: 'warning',
        symbol,
        titleSv: `${symbol}: MTF-konflikt`,
        messageSv: r.mtfExplanationSv || 'Högre tidsramar går emot signalen.',
        suggestedActionSv: 'Undvik att jaga signalen tills tidsramarna är tydligare.',
      });
    }
  }
  return out;
}

function getAlerts({ includeAcknowledged = false, includeResolved = false, statuses = null, recentMs = null, limit = MAX_RETURN } = {}) {
  const statusSet = Array.isArray(statuses) ? new Set(statuses) : null;
  const since = recentMs ? Date.now() - recentMs : null;
  const compacted = compactAlerts(readAlerts());
  const rows = compacted
    .filter((a) => includeAcknowledged || a.status !== 'acknowledged')
    .filter((a) => includeResolved || a.status !== 'resolved')
    .filter((a) => !statusSet || statusSet.has(a.status))
    .filter((a) => since === null || new Date(a.updatedAt || a.lastSeenAt || a.createdAt).getTime() >= since)
    .sort((a, b) => new Date(b.updatedAt || b.lastSeenAt || b.createdAt) - new Date(a.updatedAt || a.lastSeenAt || a.createdAt));
  if (compacted.length !== readAlerts().length) writeAlerts(compacted);
  return rows.slice(0, Math.min(limit, MAX_RETURN));
}

module.exports = {
  ALERT_PATH,
  RESOLVED_RECENT_MS,
  alertsFromScannerResults,
  alertsFromSystemHealth,
  acknowledgeAlerts,
  getAlerts,
  recordAlerts,
  resolveMissingSystemAlerts,
};
