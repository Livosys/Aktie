'use strict';

const model = require('./pineResearchModelService');

const MAX_CSV_BYTES = 2 * 1024 * 1024;

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[%()]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) throw new Error('csv_file_too_large');
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  if (!headers.length) throw new Error('csv_headers_missing');
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = cells[idx] ?? '';
    });
    return row;
  });
}

function numberFrom(value) {
  const clean = String(value ?? '')
    .replace(/\s/g, '')
    .replace(/[$%]/g, '')
    .replace(/\(([^)]+)\)/, '-$1')
    .replace(/,/g, '');
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function dateFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return raw;
  return d.toISOString();
}

function pick(row, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== '') return row[key];
  }
  return '';
}

function normalizeTrade(row, idx) {
  const directionRaw = String(pick(row, ['type', 'direction', 'side', 'entry direction', 'signal']) || '').toLowerCase();
  const profit = numberFrom(pick(row, ['profit', 'net profit', 'p&l', 'pnl', 'pl']));
  const commission = numberFrom(pick(row, ['commission', 'fees']));
  return {
    tradeId: `tv_trade_${idx + 1}`,
    entryTime: dateFrom(pick(row, ['entry time', 'entry date/time', 'entry date', 'date/time'])),
    exitTime: dateFrom(pick(row, ['exit time', 'exit date/time', 'exit date'])),
    direction: directionRaw.includes('short') || directionRaw === 'sell' ? 'short' : 'long',
    entryPrice: numberFrom(pick(row, ['entry price', 'entry'])),
    exitPrice: numberFrom(pick(row, ['exit price', 'exit'])),
    quantity: numberFrom(pick(row, ['contracts', 'qty', 'quantity', 'size'])) ?? 1,
    pnl: profit ?? 0,
    commission: commission ?? 0,
    drawdown: numberFrom(pick(row, ['drawdown', 'max drawdown'])),
    runup: numberFrom(pick(row, ['run-up', 'runup', 'max run-up'])),
  };
}

function metricsFromTrades(trades) {
  const profits = trades.map((trade) => Number(trade.pnl) || 0);
  const wins = profits.filter((value) => value > 0);
  const losses = profits.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const netPnl = profits.reduce((sum, value) => sum + value, 0);
  const tradeCount = profits.length;
  const winRate = tradeCount ? (wins.length / tradeCount) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
  const maxDrawdown = Math.max(0, ...trades.map((trade) => Math.abs(Number(trade.drawdown) || 0)));
  return {
    tradeCount,
    netPnl,
    winRate,
    profitFactor,
    averageTrade: tradeCount ? netPnl / tradeCount : 0,
    maxDrawdown,
    commission: trades.reduce((sum, trade) => sum + (Number(trade.commission) || 0), 0),
  };
}

function parsePerformanceCsv(raw) {
  const rows = parseCsv(raw);
  const metrics = {};
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;
    const label = normalizeHeader(row[keys[0]] || keys[0]);
    const value = numberFrom(row[keys[1]]);
    if (label && value !== null) metrics[label] = value;
  }
  return metrics;
}

function normalizeTradingViewImport(input = {}) {
  model.assertSafeIntent({
    pineVersionId: input.pineVersionId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    importSource: input.importSource || 'tradingview_csv',
  });
  const tradesCsv = String(input.tradesCsv || '');
  const performanceCsv = String(input.performanceCsv || '');
  if (!tradesCsv.trim() && !performanceCsv.trim()) throw new Error('csv_content_required');
  const trades = tradesCsv.trim() ? parseCsv(tradesCsv).map(normalizeTrade) : [];
  const tradeMetrics = metricsFromTrades(trades);
  const performanceMetrics = performanceCsv.trim() ? parsePerformanceCsv(performanceCsv) : {};
  return {
    trades,
    tradingViewMetrics: {
      ...tradeMetrics,
      performanceSummary: performanceMetrics,
    },
  };
}

function importTradingViewCsv(options = {}) {
  const store = options.store;
  if (!store) throw new Error('store_is_required');
  const version = store.findById('versions', options.pineVersionId);
  if (!version) throw new Error('pine_version_not_found');
  const normalized = normalizeTradingViewImport(options);
  const contentHash = model.shortHash({
    pineVersionId: version.pineVersionId,
    tradesCsv: options.tradesCsv || '',
    performanceCsv: options.performanceCsv || '',
    symbol: options.symbol || '',
    timeframe: options.timeframe || '',
  }, 16);
  const existing = store.list('validations', { pineVersionId: version.pineVersionId }).find((item) => item.importHash === contentHash);
  if (existing) return model.withSafety({ ok: true, status: 'duplicate', validation: existing });

  const tradesArtifact = options.tradesCsv
    ? store.writeArtifact('imports', `tradingview-trades-${version.pineVersionId}-${contentHash}`, options.tradesCsv, 'csv').artifact
    : null;
  const performanceArtifact = options.performanceCsv
    ? store.writeArtifact('imports', `tradingview-performance-${version.pineVersionId}-${contentHash}`, options.performanceCsv, 'csv').artifact
    : null;

  const validation = model.normalizeValidation({
    candidateId: version.candidateId,
    pineVersionId: version.pineVersionId,
    internalTestRunId: options.internalTestRunId || null,
    importSource: 'tradingview_csv',
    symbol: String(options.symbol || '').toUpperCase(),
    timeframe: String(options.timeframe || ''),
    tradesCsvArtifact: tradesArtifact,
    performanceCsvArtifact: performanceArtifact,
    tradingViewMetrics: normalized.tradingViewMetrics,
    validationStatus: 'imported',
    warnings: normalized.trades.length ? [] : ['no_trade_rows_imported'],
  });
  validation.importHash = contentHash;
  validation.tradesPreview = normalized.trades.slice(0, 25);
  store.saveValidation(validation);
  return model.withSafety({ ok: true, status: 'imported', validation });
}

module.exports = {
  MAX_CSV_BYTES,
  normalizeHeader,
  parseCsv,
  normalizeTrade,
  metricsFromTrades,
  normalizeTradingViewImport,
  importTradingViewCsv,
};
