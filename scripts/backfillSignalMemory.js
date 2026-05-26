'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const vectorMemoryService = require('../src/services/vectorMemoryService');
const { loadOutcomes } = require('../src/scanner/signalOutcomeAnalyzer');

const ROOT = path.resolve(__dirname, '..');
const PAPER_TRADES_FILE = path.join(ROOT, 'data/paper-trading/trades.jsonl');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function normalizeTradeOutcome(trade) {
  return {
    source: 'paper_trading_backfill',
    outcome_type: trade.result,
    move_after_15m_pct: trade.pnlPct,
    move_after_30m_pct: trade.pnlPct,
    max_favorable_excursion_pct: trade.maxFavorablePct ?? (trade.pnlPct > 0 ? trade.pnlPct : null),
    max_adverse_excursion_pct: trade.maxAdversePct ?? (trade.pnlPct < 0 ? Math.abs(trade.pnlPct) : null),
    resolvedAt: trade.exitTime || null,
    tradeId: trade.tradeId,
    signalId: trade.signalId,
  };
}

function tradeSignalContext(trade) {
  return {
    ...trade,
    timestamp: trade.entryTime,
    timeframe: '2m',
    direction: trade.direction || trade.nextMoveBias,
    state: trade.state || trade.narrowState,
    score: trade.score ?? trade.tradeScore ?? trade.priorityScore,
    confidence: trade.confidenceScore,
    volume: { state: trade.volumeState, relativeVolume: trade.relativeVolume ?? trade.rvol ?? null },
    marketPersonality: trade.marketPersonality || trade.marketRegime || null,
    source: 'paper_trading_backfill',
  };
}

function directionAdjustedMove(outcome, key) {
  const raw = Number(outcome?.[key]?.priceChangePct);
  if (!Number.isFinite(raw)) return null;
  return outcome.direction === 'DOWN' ? -raw : raw;
}

function directionalExcursions(outcome, horizon = 'outcome10') {
  const o = outcome?.[horizon] || {};
  const up = Number(o.maxMoveUp);
  const down = Number(o.maxMoveDown);
  if (outcome.direction === 'DOWN') {
    return {
      mfe: Number.isFinite(down) ? down : null,
      mae: Number.isFinite(up) ? up : null,
    };
  }
  return {
    mfe: Number.isFinite(up) ? up : null,
    mae: Number.isFinite(down) ? down : null,
  };
}

function normalizeHistoricalOutcome(outcome) {
  const ex = directionalExcursions(outcome);
  return {
    source: 'historical_outcome_backfill',
    outcome_type: outcome.success === true ? 'win' : outcome.success === false ? 'loss' : 'tie',
    move_after_5m_pct: directionAdjustedMove(outcome, 'outcome3'),
    move_after_15m_pct: directionAdjustedMove(outcome, 'outcome10') ?? directionAdjustedMove(outcome, 'outcome5'),
    move_after_30m_pct: directionAdjustedMove(outcome, 'outcome20'),
    max_favorable_excursion_pct: ex.mfe,
    max_adverse_excursion_pct: ex.mae,
    resolvedAt: outcome.timestamp || null,
    signalId: outcome.signalId,
  };
}

function historicalSignalContext(outcome) {
  return {
    ...outcome,
    timeframe: '2m',
    confidence: outcome.confidenceScore,
    volume: { state: outcome.volumeState, relativeVolume: outcome.rvol ?? outcome.relVol20 ?? null },
    emaAlignment: outcome.tf2m,
    marketPersonality: outcome.marketPersonality || outcome.marketRegime,
    gatePassed: ['active', 'watch', 'caution'].includes(String(outcome.status || '').toLowerCase()),
    source: 'historical_outcome_backfill',
  };
}

async function importPaperTrades() {
  const rows = readJsonl(PAPER_TRADES_FILE).filter((t) => t && t.result && t.result !== 'OPEN');
  let imported = 0;
  let skipped = 0;
  for (const trade of rows) {
    const result = await vectorMemoryService.saveSignalMemory(tradeSignalContext(trade), normalizeTradeOutcome(trade));
    if (result.inserted) imported++;
    else skipped++;
  }
  return { scanned: rows.length, imported, skipped };
}

async function importHistoricalOutcomes(start, end, symbol) {
  let rows = [];
  try {
    rows = loadOutcomes(start, end, symbol || null);
  } catch (err) {
    console.warn(`[memory-backfill] historical outcomes saknas eller kunde inte lasas: ${err.message}`);
    return { scanned: 0, imported: 0, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;
  for (const outcome of rows) {
    const result = await vectorMemoryService.saveSignalMemory(
      historicalSignalContext(outcome),
      normalizeHistoricalOutcome(outcome)
    );
    if (result.inserted) imported++;
    else skipped++;
  }
  return { scanned: rows.length, imported, skipped };
}

async function main() {
  const start = argValue('start', isoDateDaysAgo(60));
  const end = argValue('end', new Date().toISOString().slice(0, 10));
  const symbol = argValue('symbol', null);

  console.log(`[memory-backfill] start=${start} end=${end} symbol=${symbol || 'ALL'}`);
  const paper = await importPaperTrades();
  const historical = await importHistoricalOutcomes(start, end, symbol);
  const status = await vectorMemoryService.getMemoryStatus();

  console.log('[memory-backfill] paper trades:', paper);
  console.log('[memory-backfill] historical outcomes:', historical);
  console.log('[memory-backfill] memory status:', {
    storage_provider: status.storage_provider,
    pgvector: status.pgvector,
    count: status.count,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[memory-backfill] failed:', err);
    process.exit(1);
  });
