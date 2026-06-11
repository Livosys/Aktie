'use strict';

// Read-only debugging history for TradingView dry-run previews.
//
// SAFETY: This service ONLY appends/reads a JSONL history file used for
// debugging and Supervisor read-only status. It NEVER creates a trade, paper
// queue item, replay queue item or broker order. It must never crash the
// Supervisor overview — every fs operation is wrapped and degrades to empty.

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_HISTORY_FILE = path.resolve(__dirname, '../../data/tradingview/preview-history.jsonl');
const DEFAULT_MAX_ENTRIES = 200;
// Preview history is small, but cap the bytes we parse so a runaway file can
// never block the event loop when Supervisor reads the tail.
const READ_TAIL_BYTES = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeBoolean(value) {
  return value === true;
}

function buildSafetyBlock(safety) {
  // Always normalise to the frozen paper_only block regardless of input.
  if (safety && typeof safety === 'object' && !Array.isArray(safety)) {
    return {
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    };
  }
  return { ...SAFETY };
}

// Build a sanitised, side-effect-free log row from a preview result. Only the
// debugging fields are persisted — never any order/trade/queue payload.
function buildLogRow(previewResult = {}, options = {}) {
  const candidate = (previewResult && typeof previewResult.candidate === 'object' && previewResult.candidate) || {};
  return {
    timestamp: safeString(options.timestamp) || nowIso(),
    symbol: safeString(candidate.symbol) || null,
    timeframe: safeString(candidate.timeframe) || null,
    strategyId: safeString(candidate.strategyId || candidate.strategy_id) || null,
    accepted: safeBoolean(previewResult.accepted),
    blockedReason: previewResult.blockedReason != null ? safeString(previewResult.blockedReason) || null : null,
    dryRun: previewResult.dryRun === false ? false : true,
    wouldCreatePaperTest: safeBoolean(previewResult.wouldCreatePaperTest),
    wouldCreateReplayTest: safeBoolean(previewResult.wouldCreateReplayTest),
    dedupKey: previewResult.dedupKey != null ? safeString(previewResult.dedupKey) || null : null,
    safety: buildSafetyBlock(previewResult.safety),
  };
}

function createTradingViewPreviewLogService(options = {}) {
  const historyFile = options.historyFile || DEFAULT_HISTORY_FILE;
  const maxEntries = Number.isFinite(Number(options.maxEntries)) && Number(options.maxEntries) > 0
    ? Math.floor(Number(options.maxEntries))
    : DEFAULT_MAX_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function ensureDir() {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  }

  // Append one preview result to the JSONL history. Never throws; returns a
  // safe descriptor so the endpoint can report logWritten without ever failing
  // the preview response.
  function appendPreview(previewResult = {}) {
    try {
      const row = buildLogRow(previewResult, { timestamp: now().toISOString() });
      ensureDir();
      fs.appendFileSync(historyFile, `${JSON.stringify(row)}\n`, 'utf8');
      return { ok: true, logWritten: true, row, error: null, ...SAFETY };
    } catch (err) {
      return {
        ok: false,
        logWritten: false,
        row: null,
        error: err && err.message ? err.message : String(err),
        ...SAFETY,
      };
    }
  }

  // Read the most recent N preview rows. Tolerates a missing file (empty) and
  // broken/partial JSON lines (skipped). Returns chronological order
  // (oldest-first). Never throws.
  function readRecentPreviews(limit = maxEntries) {
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : maxEntries;
    try {
      if (!fs.existsSync(historyFile)) return [];
      const stat = fs.statSync(historyFile);
      let content;
      if (Number.isFinite(stat.size) && stat.size > READ_TAIL_BYTES) {
        const fd = fs.openSync(historyFile, 'r');
        try {
          const start = stat.size - READ_TAIL_BYTES;
          const buf = Buffer.alloc(READ_TAIL_BYTES);
          fs.readSync(fd, buf, 0, READ_TAIL_BYTES, start);
          content = buf.toString('utf8');
          // Drop the first (possibly partial) line after slicing mid-file.
          const firstNewline = content.indexOf('\n');
          content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
        } finally {
          fs.closeSync(fd);
        }
      } else {
        content = fs.readFileSync(historyFile, 'utf8');
      }

      const rows = [];
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            rows.push(parsed);
          }
        } catch (_) {
          // Tolerate broken/partial rows — skip silently.
        }
      }
      return rows.slice(-cap);
    } catch (_) {
      return [];
    }
  }

  // Read-only summary for Supervisor. Never throws; degrades to a safe empty
  // shape so it can never crash the overview build.
  function getPreviewHistorySummary(limit = maxEntries) {
    try {
      const rows = readRecentPreviews(limit);
      const previewCount = rows.length;
      const latest = previewCount > 0 ? rows[previewCount - 1] : null;
      return {
        ok: true,
        source: 'tradingViewPreviewLogService',
        historyFile,
        previewCount,
        latestPreview: latest,
        latestBlockedReason: latest && latest.blockedReason != null ? latest.blockedReason : null,
        entries: rows,
        safety: { ...SAFETY },
        ...SAFETY,
      };
    } catch (err) {
      return {
        ok: false,
        source: 'tradingViewPreviewLogService',
        historyFile,
        previewCount: 0,
        latestPreview: null,
        latestBlockedReason: null,
        entries: [],
        error: err && err.message ? err.message : String(err),
        safety: { ...SAFETY },
        ...SAFETY,
      };
    }
  }

  return {
    SAFETY,
    historyFile,
    maxEntries,
    buildLogRow,
    appendPreview,
    readRecentPreviews,
    getPreviewHistorySummary,
  };
}

const defaultTradingViewPreviewLogService = createTradingViewPreviewLogService();

module.exports = {
  SAFETY,
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_ENTRIES,
  buildLogRow,
  createTradingViewPreviewLogService,
  defaultTradingViewPreviewLogService,
  appendPreview: (...args) => defaultTradingViewPreviewLogService.appendPreview(...args),
  readRecentPreviews: (...args) => defaultTradingViewPreviewLogService.readRecentPreviews(...args),
  getPreviewHistorySummary: (...args) => defaultTradingViewPreviewLogService.getPreviewHistorySummary(...args),
};
