'use strict';

/**
 * Read-only live activity feed.
 *
 * Aggregates recent events from existing append-only logs and status files. It
 * never opens streams, starts jobs, schedules work or mutates trading state.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  autopilotHistory: path.join(ROOT, 'data/autopilot/narrow-autopilot-history.jsonl'),
  learningEvents: path.join(ROOT, 'data/learning-connector/events.jsonl'),
  aiEvents: path.join(ROOT, 'data/ai-analyst/analyst-events.jsonl'),
  batchFile: path.join(ROOT, 'data/strategy-batches/batches-v1.json'),
  batchResultsDir: path.join(ROOT, 'data/strategy-batches/results'),
  replayRunsDir: path.join(ROOT, 'data/replay/runs'),
  paperTradesFile: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  eventLog: path.join(ROOT, 'data/events/trading-events.jsonl'),
});

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Finished paper trades (Låtsastest) can be older than the constant stream of
// skip/market events, so a pure time sort buries them. Pin up to this many of
// the newest paper trades to the top of the feed so they stay visible.
const PAPER_PIN_MAX = 3;

function nowIso() { return new Date().toISOString(); }
function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}
function str(value, fallback = '') {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}
function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}
function safeMessage(err) {
  const msg = String(err?.message || err || 'unknown_error');
  if (/key|token|secret|password|credential|authorization/i.test(msg)) return 'Källa kunde inte läsas utan att visa hemligheter.';
  return msg.slice(0, 180);
}
function isIso(value) {
  const t = new Date(value || '').getTime();
  return Number.isFinite(t);
}
function toIso(value) {
  return isIso(value) ? new Date(value).toISOString() : null;
}
function displayTimeFor(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(d);
  } catch (_) {
    return iso;
  }
}

// Enkel svensk label-mappning för kända händelsetyper. Read-only, ingen action.
const SWED_EVENT_LABELS = Object.freeze({
  run_completed: 'Test klart',
  plan_validated: 'Plan kontrollerad',
  'signal detected': 'Signal hittad',
  signal_detected: 'Signal hittad',
  'strategy matched': 'Strategi matchad',
  strategy_matched: 'Strategi matchad',
  dry_run: 'Säker testkörning',
  'batch.completed': 'Batchtest klart',
  'replay.completed': 'Replaytest klart',
  'paper_trade.simulated': 'Låtsastest klart',
  'data.import.completed': 'Datahämtning klar',
  'ai.analysis.completed': 'AI-analys klar',
});
function svLabel(rawType) {
  const k = str(rawType, '').trim();
  if (!k) return null;
  return SWED_EVENT_LABELS[k] || SWED_EVENT_LABELS[k.toLowerCase()] || null;
}
function resultFor(raw = {}) {
  const finite = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const pnl = finite(firstPresent(raw.paper_pnl_percent, raw.result?.pnl_pct, raw.avg_pnl, raw.avgPnl, raw.avgResult, raw.pnlPercent));
  const win = finite(firstPresent(raw.win_rate, raw.winRate));
  const combos = finite(firstPresent(raw.combinationsTested, raw.combinations_tested, raw.progress?.completed));
  const parts = [];
  if (pnl !== null) parts.push(`P/L ${pnl > 0 ? '+' : ''}${pnl}%`);
  if (win !== null) parts.push(`Träff ${win}%`);
  if (combos !== null) parts.push(`${combos} komb.`);
  return parts.length ? parts.join(' · ') : null;
}
function limitFromQuery(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, Math.round(n)));
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const out = Array.isArray(fallback) ? [] : fallback;
    Object.defineProperty(out, '__readError', { value: safeMessage(err), enumerable: false });
    return out;
  }
}
function readJsonlTail(file, limit = 50) {
  try {
    if (!fs.existsSync(file)) return { status: 'empty', rows: [], source: file };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const rows = [];
    let broken = 0;
    for (const line of lines.slice(-Math.max(1, limit))) {
      try { rows.push(JSON.parse(line)); } catch (_) { broken += 1; }
    }
    return { status: broken ? 'degraded' : (rows.length ? 'ok' : 'empty'), rows, broken, totalLines: lines.length, source: file };
  } catch (err) {
    return { status: 'degraded', rows: [], error: safeMessage(err), source: file };
  }
}
function statusFromText(...parts) {
  const text = parts.map((p) => str(p)).join(' ').toLowerCase();
  if (/failed|error|misslyck|stopped/.test(text)) return 'failed';
  if (/blocked|blockerad|rejected/.test(text)) return 'blocked';
  if (/running|started|run_started|active/.test(text)) return 'running';
  if (/completed|klar|done|updated|run_completed|validated/.test(text)) return 'completed';
  if (/waiting|cooldown|planned|created|queued|pending/.test(text)) return 'waiting';
  return 'info';
}
function severityFromStatus(status) {
  if (status === 'failed') return 'error';
  if (status === 'blocked') return 'warning';
  if (status === 'waiting' || status === 'running' || status === 'info') return 'info';
  return 'ok';
}
function typeFromSource(source, raw = {}) {
  const text = `${source} ${raw.event || raw.type || raw.event_type || raw.source || raw.mode || ''}`.toLowerCase();
  if (/autopilot/.test(text)) return 'autopilot';
  if (source === 'learning' || /learning/.test(text)) return 'learning';
  if (/batch/.test(text)) return 'batch';
  if (/replay/.test(text)) return 'replay';
  if (/paper/.test(text)) return 'paper';
  if (/data|alpaca|backfill|import|candle|cache/.test(text)) return 'data_job';
  if (/ai|analyst/.test(text)) return 'ai';
  if (/risk|safety|block/.test(text)) return 'risk';
  return 'system';
}
function normalizeEvent(raw = {}, source = 'system') {
  if (!raw || typeof raw !== 'object') return null;
  const timestamp = toIso(firstPresent(raw.timestamp, raw.received_at, raw.updated_at, raw.completed_at, raw.batch_completed_at, raw.started_at, raw.batch_started_at, raw.created_at, raw.batch_created_at));
  if (!timestamp) return null;
  const rawType = firstPresent(raw.event, raw.event_type, raw.type, raw.status, source);
  const type = typeFromSource(source, raw);
  const status = statusFromText(rawType, raw.status, raw.message, raw.reason);
  const strategy = firstPresent(raw.strategy_id, raw.strategy, raw.strategyId, raw.extra?.strategy_id, raw.metadata?.strategy_id);
  const symbol = firstPresent(raw.symbol, raw.traded_symbol, raw.underlying_symbol, arr(raw.symbols)[0]);
  const timeframe = firstPresent(raw.timeframe, arr(raw.timeframes)[0], raw.config?.timeframe, arr(raw.config?.timeframes)[0]);
  const id = firstPresent(
    raw.id,
    raw.event_id,
    raw.planId,
    raw.job_id,
    raw.batch_id,
    raw.extra?.batch_id,
    raw.metadata?.batch_id,
    `${source}:${rawType}:${timestamp}:${symbol || strategy || ''}`,
  );
  const title = titleFor(type, rawType, raw);
  const message = messageFor(type, rawType, raw);
  return {
    id: String(id),
    timestamp,
    displayTime: displayTimeFor(timestamp),
    type,
    title,
    message,
    status,
    strategy: strategy || null,
    symbol: symbol || null,
    timeframe: timeframe || null,
    result: resultFor(raw),
    source,
    severity: severityFromStatus(status),
    paperOnly: raw.paper_only !== false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}
function titleFor(type, rawType, raw) {
  const sv = svLabel(rawType);
  if (sv) return sv;
  const label = str(rawType, type).replace(/[_.-]+/g, ' ');
  if (type === 'autopilot') return `Autopilot: ${label}`;
  if (type === 'batch') return `Batch: ${label}`;
  if (type === 'learning') return `Learning: ${raw.strategy_id || raw.strategy || label}`;
  if (type === 'ai') return `AI Analyst: ${raw.status || label}`;
  if (type === 'data_job') return `Datajobb: ${label}`;
  if (type === 'paper') return `Paper: ${label}`;
  if (type === 'replay') return `Replay: ${label}`;
  if (type === 'risk') return `Risk: ${label}`;
  return `System: ${label}`;
}
function messageFor(type, rawType, raw) {
  if (raw.message || raw.reason) return str(raw.message || raw.reason);
  if (type === 'autopilot') {
    const symbols = arr(raw.symbols).join(', ');
    return `${raw.strategy_id || 'Narrow Autopilot'} ${symbols ? `för ${symbols}` : ''}`.trim();
  }
  if (type === 'batch') {
    const cfg = raw.config || {};
    const symbols = arr(cfg.symbols || raw.symbols).slice(0, 4).join(', ');
    return `${raw.name || raw.id || raw.extra?.batch_id || 'Batchtest'}${symbols ? ` (${symbols})` : ''}`;
  }
  if (type === 'learning') {
    const pnl = firstPresent(raw.paper_pnl_percent, raw.result?.pnl_pct);
    return `${raw.strategy_id || 'Learning event'}${pnl !== null ? `, resultat ${pnl}%` : ''}`;
  }
  if (type === 'ai') return raw.outputSummary?.summaryPreview || raw.output?.summary || raw.status || 'AI Analyst-händelse';
  return str(rawType || type);
}
function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of events) {
    const key = `${event.id}|${event.timestamp}|${event.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}
function latestResultFiles(dir, limit = 5) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => /\.json$/i.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        return { file, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((row) => row.file);
  } catch (_) {
    return [];
  }
}
function sourceRead(name, readFn) {
  try {
    const events = readFn().map((row) => normalizeEvent(row, name)).filter(Boolean);
    return { name, status: events.length ? 'ok' : 'empty', events };
  } catch (err) {
    return { name, status: 'degraded', events: [], error: safeMessage(err) };
  }
}
function eventsFromJsonl(name, file, limit) {
  const read = readJsonlTail(file, limit);
  const events = read.rows.map((row) => normalizeEvent(row, name)).filter(Boolean);
  return { name, status: read.status === 'degraded' ? 'degraded' : (events.length ? 'ok' : 'empty'), events, error: read.error || null };
}
function eventsFromBatches(file, limit) {
  try {
    const rows = readJson(file, []);
    const events = arr(rows).slice(0, limit).map((row) => normalizeEvent(row, 'batch')).filter(Boolean);
    return { name: 'batch', status: rows.__readError ? 'degraded' : (events.length ? 'ok' : 'empty'), events, error: rows.__readError || null };
  } catch (err) {
    return { name: 'batch', status: 'degraded', events: [], error: safeMessage(err) };
  }
}
// Read the newest replay run summaries (data/replay/runs/<id>/summary.json) and
// turn each into one read-only "Replaytest klart" event. Never starts a replay.
function eventsFromReplayRuns(dir, limit) {
  return sourceRead('replay', () => {
    try {
      if (!fs.existsSync(dir)) return [];
      const runIds = fs.readdirSync(dir)
        .filter((d) => /^run_/.test(d))
        .sort()
        .reverse()
        .slice(0, Math.max(1, Math.min(limit, 30)));
      const rows = [];
      for (const runId of runIds) {
        const summary = readJson(path.join(dir, runId, 'summary.json'), null);
        if (!summary || typeof summary !== 'object') continue;
        const symbols = arr(summary.symbols);
        const best = arr(summary.bestSymbols)[0];
        const score = summary.avgTradeScore;
        const parts = [];
        if (Number.isFinite(Number(summary.totalEvents))) parts.push(`${Number(summary.totalEvents)} lägen`);
        if (Number.isFinite(Number(score))) parts.push(`snittbetyg ${Number(score)}`);
        if (best && best.symbol) parts.push(`bäst ${best.symbol}`);
        rows.push({
          event: 'replay.completed',
          type: 'replay.completed',
          source: 'replay',
          timestamp: summary.createdAt || null,
          id: summary.runId || runId,
          symbol: symbols[0] || null,
          symbols,
          timeframe: '2m',
          period_from: summary.start || null,
          period_to: summary.end || null,
          message: `Replay ${summary.start || '?'}–${summary.end || '?'}${parts.length ? `: ${parts.join(', ')}` : ''}`,
          paper_only: true,
        });
      }
      return rows;
    } catch (_) {
      return [];
    }
  });
}

// Read the newest finished paper trades (data/paper-trading/trades.jsonl) and
// turn each into one read-only "Låtsastest klart" event. Never starts a trade,
// never places an order. Pure read of an existing append-only log.
function eventsFromPaperTrades(file, limit) {
  return sourceRead('paper', () => {
    const read = readJsonlTail(file, Math.max(1, Math.min(limit, 40)));
    const rows = [];
    for (const row of read.rows) {
      if (!row || typeof row !== 'object') continue;
      const ts = firstPresent(row.exitTime, row.closed_at, row.entryTime, row.opened_at);
      if (!ts) continue;
      const result = str(row.result ?? row.outcome, '').toUpperCase();
      const label = row.strategyName || row.familyLabelSv || row.signalSubtype || row.signalFamily || 'Signal';
      const exit = row.exitReason || row.exit_reason || null;
      rows.push({
        event: 'paper_trade.simulated',
        type: 'paper_trade.simulated',
        source: 'paper',
        timestamp: ts,
        status: 'completed',
        id: row.tradeId || row.id || row.signalId || null,
        symbol: row.symbol || null,
        strategy: row.strategy_id || row.strategyId || row.strategy || null,
        timeframe: '2m',
        paper_pnl_percent: Number.isFinite(Number(row.pnlPct)) ? Math.round(Number(row.pnlPct) * 100) / 100 : null,
        message: `${row.symbol || 'Signal'} · ${label}${result ? ` · ${result}` : ''}${exit ? ` (${exit})` : ''}`,
        paper_only: true,
      });
    }
    return rows;
  });
}

function eventsFromBatchResults(dir, limit) {
  return sourceRead('batch_results', () => {
    const rows = [];
    for (const file of latestResultFiles(dir, 5)) {
      const result = readJson(file, []);
      for (const row of arr(result).slice(0, Math.max(1, Math.ceil(limit / 5)))) rows.push({ ...row, type: 'batch.result', source: 'batch_results' });
    }
    return rows;
  });
}

// Pin the newest finished paper trades to the very top of the feed. Finished
// paper trades are older than the constant stream of skip/market events, so a
// pure time sort buries them — pinning surfaces the latest låtsastester first,
// each flagged `pinned: true`, with the rest of the feed following newest-first.
// Pure read-only re-ordering — no events are created, mutated or executed.
function pinPaperTrades(sortedDesc, limit) {
  const isPaper = (e) => !!(e && e.source === 'paper');
  const paper = sortedDesc.filter(isPaper);
  // Cap pins so they never dominate a small feed (at most half of it).
  const pinCount = Math.min(PAPER_PIN_MAX, paper.length, Math.max(1, Math.floor(limit / 2)));
  if (pinCount < 1 || !paper.length) return sortedDesc.slice(0, limit);
  const pinned = paper.slice(0, pinCount).map((e) => ({ ...e, pinned: true }));
  const pinnedKeys = new Set(pinned.map((e) => `${e.id}|${e.timestamp}`));
  const rest = sortedDesc.filter((e) => !pinnedKeys.has(`${e.id}|${e.timestamp}`));
  return [...pinned, ...rest].slice(0, limit);
}

function buildLiveActivity(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const limit = limitFromQuery(options.limit);
  const sourceLimit = Math.max(limit, 50);
  const sources = [
    eventsFromJsonl('autopilot', files.autopilotHistory, sourceLimit),
    eventsFromJsonl('learning', files.learningEvents, sourceLimit),
    eventsFromJsonl('ai', files.aiEvents, sourceLimit),
    eventsFromBatches(files.batchFile, sourceLimit),
    eventsFromBatchResults(files.batchResultsDir, sourceLimit),
    eventsFromReplayRuns(files.replayRunsDir, sourceLimit),
    eventsFromPaperTrades(files.paperTradesFile, sourceLimit),
    eventsFromJsonl('system_events', files.eventLog, sourceLimit),
  ];
  const warnings = sources.filter((s) => s.status === 'degraded').map((s) => ({ source: s.name, error: s.error || 'source_degraded' }));
  const sorted = dedupeEvents(sources.flatMap((s) => s.events))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const events = pinPaperTrades(sorted, limit);
  const status = warnings.length ? 'degraded' : (events.length ? 'ok' : 'empty');
  return {
    ok: true,
    status,
    count: events.length,
    events,
    sources: sources.map((s) => ({ name: s.name, status: s.status, count: s.events.length })),
    warnings,
    updatedAt: nowIso(),
    ...SAFETY,
  };
}

function buildSupervisorLiveActivitySummary() {
  const full = buildLiveActivity({ limit: 10 });
  return {
    status: full.status,
    count: full.count,
    latestEvents: full.events.slice(0, 5),
    sourceCount: full.sources.length,
    degradedSources: full.sources.filter((s) => s.status === 'degraded').map((s) => s.name),
    updatedAt: full.updatedAt,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  buildLiveActivity,
  buildSupervisorLiveActivitySummary,
  _internal: {
    readJsonlTail,
    normalizeEvent,
    limitFromQuery,
    dedupeEvents,
    svLabel,
    displayTimeFor,
    resultFor,
    pinPaperTrades,
  },
};
