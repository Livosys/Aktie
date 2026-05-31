'use strict';

const fs = require('fs');
const path = require('path');

const daytradingLearning = require('./daytradingLearningEngineService');
const daytradingControl = require('./daytradingControlService');
const strategyBatchTest = require('./strategyBatchTestService');
const paperTrading = require('../paperTrading/paperTradingAgent');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
});

const WINDOW_HOURS = Object.freeze({
  '1h': 1,
  '1d': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
});

const WINDOW_LABELS = Object.freeze({
  '1h': 'Senaste timmen',
  '1d': 'Idag',
  '7d': 'Senaste 7 dagarna',
  '30d': 'Senaste 30 dagarna',
});

const PAPER_TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const PAPER_EVENTS_FILE = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function parseWindow(input) {
  const raw = String(input || '1d').trim().toLowerCase();
  if (WINDOW_HOURS[raw]) return raw;
  if (raw === 'hour' || raw === 'hourly') return '1h';
  if (raw === 'day' || raw === 'today') return '1d';
  if (raw === 'week' || raw === 'weekly') return '7d';
  if (raw === 'month' || raw === 'monthly') return '30d';
  return '1d';
}

function windowHours(windowKey) {
  return WINDOW_HOURS[parseWindow(windowKey)];
}

function windowSinceIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function withinWindow(row, sinceMs) {
  if (!sinceMs) return true;
  const ts = row.timestamp || row.exitTime || row.closed_at || row.entryTime || row.opened_at || row.created_at;
  if (!ts) return true;
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time)) return true;
  return time >= sinceMs;
}

function text(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return value ? 'ja' : 'nej';
  return fallback;
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function titleCase(label) {
  return String(label || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function isCryptoSymbol(symbol = '') {
  return String(symbol || '').toUpperCase().endsWith('USDT');
}

function isCryptoRow(row = {}) {
  const market = text(row.market_group || row.marketGroup || row.marketType || row.market, '').toLowerCase();
  return market === 'crypto' || isCryptoSymbol(row.symbol) || market.includes('crypto');
}

function isVwapRow(row = {}) {
  const raw = text(row.signalSubtype || row.signal_subtype || row.raw_signal || row.signalFamily || row.signal || row.decisionCode, '').toUpperCase();
  return raw.includes('VWAP_RECLAIM_UP') || raw.includes('VWAP_REJECTION_DOWN') || raw.includes('VWAP');
}

function rawSignal(row = {}) {
  return text(row.signalSubtype || row.signal_subtype || row.raw_signal || row.signalFamily || row.signal || row.strategy || row.decisionCode, 'okänd');
}

function countBy(rows, mapper) {
  const counts = new Map();
  for (const row of rows) {
    const key = text(mapper(row), '');
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sv'));
}

function windowText(hours) {
  if (hours === 1) return 'senaste timmen';
  if (hours === 24) return 'idag';
  if (hours === 168) return 'senaste 7 dagarna';
  if (hours === 720) return 'senaste 30 dagarna';
  return `${hours} timmar`;
}

function mapSkipReason(key) {
  const labels = {
    low_confidence: 'För svag signal',
    cooldown: 'Cooldown',
    market_closed: 'Marknaden är stängd',
    disabled_by_user: 'Avstängd av användaren',
    no_entry_rule: 'Saknar entry-regel',
    paused: 'Pausad strategi',
    missing_data: 'Saknar data',
    risk_block: 'Riskmotorn blockerade',
    spread_too_high: 'Spreaden är för hög',
    max_trades_limit: 'Max antal trades nåddes',
    wait: 'Vänteläge',
    do_not_chase: 'Jaga inte',
    unknown: 'Okänt stopp',
  };
  return labels[key] || titleCase(key);
}

function formatStrategyRow(row = {}) {
  return {
    key: row.key || row.strategy_id || row.strategyId || row.id || row.symbol || 'unknown',
    name: text(row.label || row.strategy_name || row.strategyName || row.name || row.strategy_id || row.strategyId, 'Okänd strategi'),
    market: text(row.market_group || row.marketGroup || row.market || row.market_label || row.marketLabel, 'saknas'),
    status: text(row.status, 'saknas'),
    runtime_status: text(row.runtime_status || row.runtimeStatus, 'saknas'),
    runtime_label: text(row.runtime_label || row.runtimeLabel, 'saknas'),
    can_create_paper_trade: row.can_create_paper_trade === true || row.can_create_paper_trade === 'partial',
    enabled_by_user: row.enabled_by_user === true,
    closed: number(row.closed || row.trades || row.paper_trades_48h, 0),
    win_rate: row.win_rate != null ? number(row.win_rate, 0) : null,
    avg_pl: row.avg_pl != null ? number(row.avg_pl, 0) : null,
    top_skip_reason: text(row.top_skip_reason, ''),
    reason: text(row.runtime_comment_sv || row.reason_sv || row.reason || row.comment_sv, ''),
  };
}

function buildStrategies(workSummary, runtimeSummary) {
  const working = (workSummary.by_strategy || [])
    .filter((row) => row.closed > 0 && row.avg_pl > 0)
    .slice(0, 4)
    .map((row) => ({
      name: text(row.label || row.key, 'Okänd strategi'),
      key: text(row.key, 'unknown'),
      win_rate: number(row.win_rate, 0),
      avg_pl: number(row.avg_pl, 0),
      closed: number(row.closed, 0),
      tone: 'green',
      note: row.status === 'strong'
        ? 'Fungerar bra historiskt'
        : row.status === 'promising'
          ? 'Lovande'
          : 'Fungerar',
    }));

  const runtimeRows = Array.isArray(runtimeSummary.strategies) ? runtimeSummary.strategies.map(formatStrategyRow) : [];
  const blocked = runtimeRows
    .filter((row) => ['paused', 'no_entry_rule', 'not_connected', 'disabled'].includes(row.runtime_status) || row.can_create_paper_trade === false)
    .slice(0, 4)
    .map((row) => ({
      name: row.name,
      key: row.key,
      status: row.runtime_label,
      tone: 'red',
      note: row.reason || row.top_skip_reason || 'Blockerad',
    }));

  const partial = runtimeRows
    .filter((row) => row.runtime_status === 'partial')
    .slice(0, 4)
    .map((row) => ({
      name: row.name,
      key: row.key,
      status: row.runtime_label,
      tone: 'yellow',
      note: row.reason || 'Delvis kopplad',
    }));

  return { working, blocked, partial, runtimeRows };
}

function buildBlockers(skipReasons, gateReasons) {
  const byLabel = new Map();
  for (const item of skipReasons || []) {
    const label = mapSkipReason(item.key || item.label || 'unknown');
    byLabel.set(label, (byLabel.get(label) || 0) + number(item.count, 0));
  }
  for (const item of gateReasons || []) {
    const label = text(item.label || item.reason || item.key || 'Gate blockerat', 'Gate blockerat');
    byLabel.set(label, (byLabel.get(label) || 0) + number(item.count, 0));
  }
  return [...byLabel.entries()]
    .map(([label, count]) => ({
      label,
      count,
      tone: count > 3 ? 'red' : 'yellow',
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sv'))
    .slice(0, 5);
}

function buildCryptoStatus(windowRows, runtimeRows, trades = []) {
  const cryptoRows = windowRows.filter(isCryptoRow);
  const vwapRows = windowRows.filter(isVwapRow);
  const blockedRows = cryptoRows.filter((row) => row.allowed === false || row.mode === 'block');
  const observeRows = cryptoRows.filter((row) => row.mode === 'observe_only');
  const runtimeCrypto = runtimeRows.filter((row) => row.market === 'crypto');
  const runtimeActive = runtimeCrypto.filter((row) => row.runtime_status === 'active').length;
  const runtimePartial = runtimeCrypto.filter((row) => row.runtime_status === 'partial').length;
  const vwapTrades = trades.filter((row) => isVwapRow(row));
  const vwapSignals = vwapRows.length;
  const vwapRoutingWorking = vwapSignals > 0 && (vwapTrades.length > 0 || runtimeActive > 0);
  const vwapRoutingStatus = vwapTrades.length > 0
    ? 'fungerar'
    : observeRows.length > 0
      ? 'observe-only'
      : blockedRows.length > 0
        ? 'stoppad'
        : 'samlar data';

  return {
    crypto_signals: cryptoRows.length,
    runtime_active: runtimeActive,
    runtime_partial: runtimePartial,
    gate_blocked: blockedRows.length,
    observe_only: observeRows.length,
    vwap_signal_count: vwapSignals,
    vwap_paper_trades: vwapTrades.length,
    vwap_gate_blocked: windowRows.filter((row) => isVwapRow(row) && (row.allowed === false || row.mode === 'block')).length,
    vwap_routing_status: vwapRoutingStatus,
    vwap_routing_fungerar: vwapRoutingWorking,
    gate_mode: blockedRows.length > 0 ? 'block' : observeRows.length > 0 ? 'observe_only' : 'allow',
  };
}

function buildConclusions(windowKey, payload) {
  const windowLabel = WINDOW_LABELS[windowKey] || windowText(payload.hours);
  const seen = payload.window_metrics.signals_seen;
  const paperTrades = payload.window_metrics.paper_trades_created;
  const blocked = payload.window_metrics.gate_blocked + payload.window_metrics.learning_skipped;
  const best = payload.strategy_highlights.working[0];
  const blockedStrategy = payload.strategy_highlights.blocked[0] || payload.strategy_highlights.partial[0];
  const crypto = payload.crypto_status;

  let conclusion = `${windowLabel}: `;
  if (seen === 0 && paperTrades === 0) {
    conclusion += 'ingen tydlig aktivitet ännu. Vänta eller samla mer data.';
  } else if (paperTrades === 0 && blocked > 0) {
    conclusion += 'systemet hittar signaler men gate och learning stoppar dem innan paper trades skapas.';
  } else if (best && best.closed >= 5 && best.win_rate >= 55) {
    conclusion += `${text(best.name, 'En strategi')} fungerar bäst och bör bevakas först.`;
  } else if (paperTrades > 0) {
    conclusion += 'det finns paper-aktivitet, men resultaten är fortfarande blandade.';
  } else {
    conclusion += 'det finns aktivitet, men dataunderlaget är fortfarande tunt.';
  }

  const short = crypto.vwap_routing_fungerar
    ? `Crypto ser levande ut: ${crypto.crypto_signals} signaler, ${crypto.runtime_active} runtime-active, ${crypto.gate_blocked} gate-blockade och VWAP-routing ${crypto.vwap_routing_status}.`
    : `Crypto samlar data: ${crypto.crypto_signals} signaler, ${crypto.runtime_active} runtime-active och VWAP-routing är ${crypto.vwap_routing_status}.`;

  const nextAction = payload.recommendation.next_action_text
    || payload.recommendations[0]?.text
    || 'Vänta och samla data.';

  return {
    conclusion_sv: conclusion,
    short_sv: short,
    next_action_sv: nextAction,
    top_blocker_sv: payload.blockers[0] ? `${payload.blockers[0].label} (${payload.blockers[0].count})` : 'Inga tydliga blockerare',
    top_strategy_sv: best ? `${best.name} (${best.win_rate}% WR, ${best.closed} trades)` : 'Ingen tydlig vinnare ännu',
    blocked_strategy_sv: blockedStrategy ? `${blockedStrategy.name} - ${blockedStrategy.status}` : 'Ingen tydlig blockerad strategi',
    signals_seen: seen,
    paper_trades_created: paperTrades,
    gate_blocked: payload.window_metrics.gate_blocked,
    learning_skipped: payload.window_metrics.learning_skipped,
    blocked_total: blocked,
  };
}

function buildRecommendations(payload) {
  const recs = [];
  const { window_metrics: metrics, strategy_highlights: highlights, crypto_status: crypto } = payload;
  const hasStrongStrategy = highlights.working[0] && highlights.working[0].closed >= 5 && highlights.working[0].win_rate >= 55;
  const hasEnoughData = metrics.learning_trades >= 10 || metrics.paper_trades_created >= 3 || metrics.signals_seen >= 10;
  const mostlyBlocked = metrics.gate_blocked + metrics.learning_skipped >= Math.max(3, metrics.paper_trades_created * 2);

  if (!hasEnoughData) {
    recs.push({
      action: 'wait',
      tone: 'blue',
      label: 'Vänta och samla data',
      text: 'Det finns för lite data i detta fönster för att dra säkra slutsatser.',
    });
  }

  if (!hasStrongStrategy && hasEnoughData) {
    recs.push({
      action: 'run_batch',
      tone: 'blue',
      label: 'Kör batch',
      text: 'Kör ett batchtest för att jämföra fler kombinationer och få bättre underlag.',
    });
  }

  if (hasStrongStrategy) {
    recs.push({
      action: 'test_strategy',
      tone: 'green',
      label: 'Testa strategi',
      text: `Testa ${highlights.working[0].name} vidare i paper/replay och följ win rate.`,
    });
  }

  if (mostlyBlocked || crypto.gate_blocked > crypto.runtime_active) {
    recs.push({
      action: 'follow_gate',
      tone: 'yellow',
      label: 'Följ upp gate/conservative mode',
      text: 'Gate och conservative mode stoppar mycket. Kontrollera om det är avsiktligt.',
    });
  }

  if (highlights.blocked.length > 0 || highlights.partial.length > 0) {
    recs.push({
      action: 'keep_blocked',
      tone: 'red',
      label: 'Lämna blockerad strategi blockerad',
      text: 'Strategier som saknar entry-regel eller är pausade bör ligga kvar blockerade tills de är färdiga.',
    });
  }

  if (!recs.length) {
    recs.push({
      action: 'wait',
      tone: 'blue',
      label: 'Vänta och följ upp',
      text: 'Läget är blandat. Vänta in mer data och följ hur gate och runtime utvecklas.',
    });
  }

  return recs.slice(0, 5);
}

function buildFindings(payload) {
  const { window_metrics: metrics, crypto_status: crypto, strategy_highlights: highlights, blockers } = payload;
  return [
    {
      tone: 'blue',
      label: 'Vad systemet såg',
      text: `${metrics.signals_seen} signaler i fönstret, ${metrics.paper_trades_created} paper trades och ${metrics.learning_skipped} skippade signaler.`,
    },
    {
      tone: metrics.gate_blocked > 0 || metrics.learning_skipped > metrics.paper_trades_created ? 'red' : 'yellow',
      label: 'Vad stoppades',
      text: blockers.length > 0
        ? `${blockers[0].label}${blockers[0].count ? ` (${blockers[0].count})` : ''}.`
        : 'Inga tydliga stopp i detta fönster.',
    },
    {
      tone: 'green',
      label: 'Strategier som fungerar',
      text: highlights.working.length
        ? `${highlights.working[0].name} är starkast just nu.`
        : 'Ingen strategi har tillräckligt med positiv historik ännu.',
    },
    {
      tone: highlights.blocked.length > 0 || highlights.partial.length > 0 ? 'yellow' : 'green',
      label: 'Strategier som stoppas',
      text: highlights.blocked.length > 0
        ? `${highlights.blocked[0].name} är blockerad eller avstängd.`
        : highlights.partial.length > 0
          ? `${highlights.partial[0].name} är delvis kopplad.`
          : 'Inga strategier är tydligt blockerade.',
    },
    {
      tone: crypto.vwap_routing_fungerar ? 'green' : crypto.vwap_routing_status === 'observe-only' ? 'yellow' : 'blue',
      label: 'Crypto-status',
      text: `Crypto-signaler ${crypto.crypto_signals}, runtime-active ${crypto.runtime_active}, gate-blockade ${crypto.gate_blocked}, VWAP-routing ${crypto.vwap_routing_status}.`,
    },
    {
      tone: payload.recommendations[0]?.tone || 'blue',
      label: 'Rekommenderad nästa åtgärd',
      text: payload.recommendation.next_action_text || payload.recommendations[0]?.text || 'Vänta och samla data.',
    },
  ];
}

function buildWindowAdvisor(windowKey = '1d') {
  const normalizedWindow = parseWindow(windowKey);
  const hours = windowHours(normalizedWindow);
  const sinceIso = windowSinceIso(hours);
  const sinceMs = new Date(sinceIso).getTime();

  const learning = daytradingLearning.getLearningSummary({ hours, limit: 100 });
  const runtime = daytradingControl.getRuntimeStrategies();
  const recommendation = daytradingControl.getRecommendation();
  const paperStatus = paperTrading.getStatus();
  const paperPerformance = paperTrading.getPerformance();
  const gateHistory = paperTrading.getGateDecisionsHistory({ since: sinceIso, limit: 2000 });

  const trades = readJsonl(PAPER_TRADES_FILE).filter((row) => withinWindow(row, sinceMs));
  const events = readJsonl(PAPER_EVENTS_FILE).filter((row) => withinWindow(row, sinceMs));
  const gateDecisions = Array.isArray(gateHistory.decisions) ? gateHistory.decisions : [];
  const runtimeRows = Array.isArray(runtime.strategies) ? runtime.strategies.map(formatStrategyRow) : [];
  const runtimeCryptoRows = runtimeRows.filter((row) => row.market === 'crypto');

  const learningTop = learning.summary || {};
  const windowMetrics = {
    signals_seen: gateDecisions.length,
    paper_trades_created: trades.length,
    gate_blocked: gateDecisions.filter((row) => row.allowed === false || row.mode === 'block').length,
    observe_only: gateDecisions.filter((row) => row.mode === 'observe_only').length,
    learning_trades: number(learningTop.trades_total, 0),
    learning_closed: number(learningTop.closed_trades, 0),
    learning_skipped: number(learningTop.skipped_total, 0),
    risk_blocks: number(learningTop.risk_blocks_total, 0),
    open_trades: number(paperStatus.openCount || paperStatus.open_count, 0),
    events_seen: events.length,
  };

  const cryptoGateRows = gateDecisions.filter(isCryptoRow);
  const skipReasons = Array.isArray(learning.skip_reasons) ? learning.skip_reasons : [];
  const gateReasons = countBy(cryptoGateRows.filter((row) => row.allowed === false || row.mode === 'block' || row.mode === 'observe_only'),
    (row) => row.reasonSv || row.observeOnlyReasonSv || row.decisionCode || 'Gate blockerat');

  const cryptoStatus = buildCryptoStatus(cryptoGateRows, runtimeCryptoRows, trades);
  const strategies = buildStrategies(learning, runtime);
  const blockers = buildBlockers(skipReasons, gateReasons);
  const recommendations = buildRecommendations({
    window: normalizedWindow,
    hours,
    window_metrics: windowMetrics,
    strategy_highlights: strategies,
    crypto_status: cryptoStatus,
    recommendation,
    blockers,
  });

  const payload = {
    ok: true,
    window: normalizedWindow,
    hours,
    window_label_sv: WINDOW_LABELS[normalizedWindow],
    generated_at: nowIso(),
    window_range: {
      since: sinceIso,
      hours,
    },
    paper_status: {
      enabled: paperStatus.enabled === true,
      open_count: paperStatus.openCount ?? paperStatus.open_count ?? 0,
      performance: {
        win_rate: paperPerformance?.win_rate ?? null,
        timeout_rate: paperPerformance?.timeout_rate ?? null,
        avg_pnl: paperPerformance?.avg_pnl ?? null,
        total: paperPerformance?.total ?? paperPerformance?.trades ?? null,
      },
    },
    window_metrics: windowMetrics,
    summary: {},
    findings: [],
    blockers,
    strategy_highlights: {
      working: strategies.working,
      blocked: strategies.blocked,
      partial: strategies.partial,
      runtime_snapshot: runtime.summary || {},
    },
    crypto_status: cryptoStatus,
    recommendation: {},
    recommendations,
    safety: SAFETY,
    sources: {
      learning_summary: '/api/daytrading/learning-summary',
      runtime_strategies: '/api/daytrading/runtime-strategies',
      recommendation: '/api/daytrading/recommendation',
      paper_gate_history: '/api/paper-trading/gate-decisions-history',
    },
  };

  payload.summary = buildConclusions(normalizedWindow, payload);
  payload.recommendation = {
    next_action_key: recommendations[0]?.action || 'wait',
    next_action_text: recommendations[0]?.text || 'Vänta och samla data.',
    title_sv: recommendation?.title || 'Systemets rekommendation just nu',
    best_strategy: recommendation?.best_strategy || null,
    avoid_strategy: recommendation?.avoid_strategy || null,
    paper_only: true,
  };
  payload.findings = buildFindings(payload);
  payload.strategy_highlights.best = payload.strategy_highlights.working[0] || null;
  payload.strategy_highlights.top_blocked = payload.strategy_highlights.blocked[0] || null;
  payload.strategy_highlights.top_partial = payload.strategy_highlights.partial[0] || null;

  return payload;
}

function getOperationsAdvisor(windowKey = '1d') {
  try {
    return buildWindowAdvisor(windowKey);
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      window: parseWindow(windowKey),
      hours: windowHours(windowKey),
      window_label_sv: WINDOW_LABELS[parseWindow(windowKey)] || 'Idag',
      generated_at: nowIso(),
      window_metrics: {
        signals_seen: 0,
        paper_trades_created: 0,
        gate_blocked: 0,
        observe_only: 0,
        learning_trades: 0,
        learning_closed: 0,
        learning_skipped: 0,
        risk_blocks: 0,
        open_trades: 0,
        events_seen: 0,
      },
      summary: {
        conclusion_sv: 'Advisorn kunde inte läsa data i detta fönster.',
        short_sv: 'Data saknas.',
        next_action_sv: 'Vänta och försök igen.',
      },
      findings: [],
      blockers: [],
      strategy_highlights: {
        working: [],
        blocked: [],
        partial: [],
        runtime_snapshot: {},
      },
      crypto_status: {
        crypto_signals: 0,
        runtime_active: 0,
        runtime_partial: 0,
        gate_blocked: 0,
        observe_only: 0,
        vwap_signal_count: 0,
        vwap_paper_trades: 0,
        vwap_gate_blocked: 0,
        vwap_routing_status: 'samlar data',
        vwap_routing_fungerar: false,
        gate_mode: 'allow',
      },
      recommendation: {
        next_action_key: 'wait',
        next_action_text: 'Vänta och samla data.',
        title_sv: 'Systemets rekommendation just nu',
        best_strategy: null,
        avoid_strategy: null,
        paper_only: true,
      },
      recommendations: [
        {
          action: 'wait',
          tone: 'blue',
          label: 'Vänta och samla data',
          text: 'Advisorn kunde inte läsa historiken i detta fönster.',
        },
      ],
      safety: SAFETY,
      sources: {},
    };
  }
}

module.exports = {
  SAFETY,
  getOperationsAdvisor,
};
