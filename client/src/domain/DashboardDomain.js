// Trading Dashboard: startsidan. Den ska besvara "hur går det idag" på under tio
// sekunder — dagens resultat, vad som är öppet, och om kedjan (marknad → scanner →
// broker → quotes) faktiskt lever.
//
// Allt härleds ur data sidan redan har: trade journal-raderna (samma rader som
// Trades och Analytics räknar på), position desk-raderna och runtime-snapshotens
// scanner-, marknads- och quote-fält. Modulen är ren och hämtar ingenting själv,
// så dashboarden kan inte visa en annan sanning än flikarna den sammanfattar.

import {
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function msOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

export function dayStartMs(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// En trade hör till dagen om den öppnades eller stängdes idag. Annars skulle en
// position som bärs över midnatt försvinna ur dagens räkning på båda sidor.
function isToday(trade, startOfDay, now) {
  const stamps = [trade?.entryMs, trade?.exitMs].filter((value) => value != null);
  return stamps.some((value) => value >= startOfDay && value <= now);
}

function closedTodayTrades(trades, startOfDay, now) {
  return toArray(trades).filter((trade) => (
    trade?.exitMs != null
    && trade.exitMs >= startOfDay
    && trade.exitMs <= now
    && numberOrNull(trade?.netPnl) != null
  ));
}

function sumOrNull(rows, pick) {
  const values = rows.map(pick).map(numberOrNull).filter((value) => value != null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

// Dagens siffror. Net, gross och commission hör ihop aritmetiskt (net = gross −
// commission) och räknas därför bara på stängda trades. Det som fortfarande står
// ute redovisas separat som orealiserat — de två blandas aldrig ihop i ett tal.
export function summarizeToday({
  trades = [],
  positionRows = [],
  now = Date.now(),
} = {}) {
  const startOfDay = dayStartMs(now);
  const list = toArray(trades);
  const todays = list.filter((trade) => isToday(trade, startOfDay, now));
  const closed = closedTodayTrades(list, startOfDay, now);

  const wins = closed.filter((trade) => numberOrNull(trade.netPnl) > 0).length;
  const losses = closed.filter((trade) => numberOrNull(trade.netPnl) < 0).length;
  const decided = wins + losses;

  const openRows = toArray(positionRows);
  const unrealizedPnl = sumOrNull(openRows, (row) => row.pnl);
  const netPnl = sumOrNull(closed, (trade) => trade.netPnl);

  return {
    tradesToday: todays.length,
    openedToday: todays.filter((trade) => trade.entryMs != null && trade.entryMs >= startOfDay).length,
    closedToday: closed.length,
    openTrades: list.filter((trade) => trade?.status === 'open').length,
    openPositions: openRows.length,
    unprotectedPositions: openRows.filter((row) => row.status === 'unprotected').length,

    netPnl,
    grossPnl: sumOrNull(closed, (trade) => trade.grossPnl),
    commission: sumOrNull(closed, (trade) => trade.commission),
    unrealizedPnl,
    // Dagens totala läge: hemtaget plus det som står ute.
    netToday: netPnl == null && unrealizedPnl == null ? null : (netPnl || 0) + (unrealizedPnl || 0),

    wins,
    losses,
    winRate: decided ? (wins / decided) * 100 : null,
    startOfDay,
  };
}

// Equity idag = kumulativ realiserad PnL från dagens start. Kontots absoluta
// nivå finns på IBKR Paper-konto; här är det rörelsen som betyder något, och den
// är den enda serien vi kan bygga utan att hitta på mellanliggande punkter.
export function buildEquitySeries({ trades = [], now = Date.now() } = {}) {
  const startOfDay = dayStartMs(now);
  const closed = closedTodayTrades(trades, startOfDay, now)
    .slice()
    .sort((a, b) => a.exitMs - b.exitMs);

  if (!closed.length) return [];

  let running = 0;
  const points = [{ value: 0, at: startOfDay, label: 'Dagens start' }];
  for (const trade of closed) {
    running += numberOrNull(trade.netPnl);
    points.push({
      value: Number(running.toFixed(2)),
      at: trade.exitMs,
      label: trade.symbol || '',
      key: trade.key,
    });
  }
  return points;
}

// PnL idag = en stapel per stängd trade, i den ordning de stängdes.
export function buildPnlBars({ trades = [], now = Date.now(), limit = 12 } = {}) {
  const startOfDay = dayStartMs(now);
  return closedTodayTrades(trades, startOfDay, now)
    .slice()
    .sort((a, b) => a.exitMs - b.exitMs)
    .slice(-limit)
    .map((trade) => ({
      key: trade.key,
      label: trade.symbol || '',
      strategyName: trade.strategyName || null,
      value: numberOrNull(trade.netPnl),
      at: trade.exitMs,
      tone: numberOrNull(trade.netPnl) < 0 ? 'danger' : 'good',
    }));
}

function ageMs(at, now) {
  const ms = msOrNull(at);
  return ms == null ? null : Math.max(0, now - ms);
}

// Kedjan marknad → scanner → broker → quotes. Varje indikator säger vad som är
// sant just nu; det som inte finns i snapshoten blir "okänt", aldrig "OK".
export function buildMarketStatus({
  market = {},
  scanner = {},
  quotes = [],
  scanHistory = [],
  executionConnected = null,
  marketDataConnected = null,
  now = Date.now(),
} = {}) {
  const marketOpen = market.isMarketOpen ?? market.isOpen ?? null;
  const sessionLabel = market.sessionLabel || market.session || null;

  const latestScanAt = scanner.lastScanAt
    || toArray(scanHistory).map((row) => row?.startedAt).find((value) => hasValue(value))
    || null;
  const scanAge = ageMs(latestScanAt, now);

  const quoteList = toArray(quotes);
  const staleQuotes = quoteList.filter((quote) => (
    quote?.stale === true || quote?.fallback === true || quote?.simulated === true
  )).length;

  return {
    marketOpen,
    latestScanAt,
    scanAgeMs: scanAge,
    quotes: quoteList.length,
    staleQuotes,
    indicators: [
      {
        key: 'market',
        label: 'Market',
        value: marketOpen == null ? 'okänt' : (marketOpen ? 'öppen' : 'stängd'),
        hint: sessionLabel,
        tone: marketOpen == null ? 'neutral' : (marketOpen ? 'success' : 'warning'),
      },
      {
        key: 'scanner',
        label: 'Scanner',
        value: scanner.connected == null ? 'okänt' : (scanner.connected ? 'aktiv' : 'frånkopplad'),
        hint: scanner.connected === false ? 'ingen scanmotor ansluten' : null,
        tone: scanner.connected == null ? 'neutral' : (scanner.connected ? 'success' : 'danger'),
      },
      {
        key: 'broker',
        label: 'Broker',
        value: executionConnected == null ? 'okänt' : (executionConnected ? 'ansluten' : 'frånkopplad'),
        hint: 'IBKR Paper',
        tone: executionConnected == null ? 'neutral' : (executionConnected ? 'success' : 'danger'),
      },
      {
        key: 'quotes',
        label: 'Quotes',
        value: quoteList.length ? String(quoteList.length) : (marketDataConnected == null ? 'okänt' : '0'),
        hint: staleQuotes ? `${staleQuotes} utan färsk feed` : (marketDataConnected === false ? 'market data nere' : null),
        tone: !quoteList.length || marketDataConnected === false
          ? 'warning'
          : (staleQuotes ? 'warning' : 'success'),
      },
      {
        key: 'last_scan',
        label: 'Senaste scan',
        value: latestScanAt,
        ageMs: scanAge,
        // Ett svep som är äldre än fem minuter är inte längre "nyss" — då står
        // radarn still och det ska synas utan att man öppnar Live Scanner.
        tone: scanAge == null ? 'neutral' : (scanAge > 5 * 60 * 1000 ? 'warning' : 'success'),
      },
    ],
  };
}

function tradeActivityTone(trade) {
  if (trade?.status === 'open') return 'info';
  const pnl = numberOrNull(trade?.netPnl);
  if (pnl == null) return 'neutral';
  if (pnl > 0) return 'good';
  if (pnl < 0) return 'danger';
  return 'neutral';
}

// Aktivitet: tre korta strömmar i stället för en lång logg. Varje rad pekar på
// något användaren kan öppna på rätt flik.
export function buildActivity({
  trades = [],
  positionRows = [],
  scanHistory = [],
  limit = 6,
  now = Date.now(),
} = {}) {
  const recentTrades = toArray(trades)
    .filter((trade) => trade?.entryMs != null || trade?.exitMs != null)
    .slice()
    .sort((a, b) => (b.exitMs ?? b.entryMs ?? 0) - (a.exitMs ?? a.entryMs ?? 0))
    .slice(0, limit)
    .map((trade) => ({
      id: trade.key,
      executionId: trade.executionId,
      symbol: trade.symbol,
      strategyName: trade.strategyName,
      direction: trade.direction,
      status: trade.status,
      statusLabel: trade.statusLabel,
      statusDot: trade.statusDot,
      netPnl: numberOrNull(trade.netPnl),
      unrealizedPnl: numberOrNull(trade.unrealizedPnl),
      at: trade.exitMs ?? trade.entryMs,
      closed: trade.exitMs != null,
      tone: tradeActivityTone(trade),
    }));

  const scannerEvents = toArray(scanHistory)
    .slice()
    .sort((a, b) => (msOrNull(b?.startedAt) ?? 0) - (msOrNull(a?.startedAt) ?? 0))
    .slice(0, limit)
    .map((row, index) => ({
      id: row?.scanId || `scan_${index}`,
      at: msOrNull(row?.startedAt),
      ageMs: ageMs(row?.startedAt, now),
      signalsRead: numberOrNull(row?.tradingOsSignalsRead),
      candidates: numberOrNull(row?.candidatesCreated),
      status: row?.status || null,
      executionTarget: row?.executionTarget || null,
      // Ett svep som skapade en kandidat är det enda som förändrade något.
      tone: numberOrNull(row?.candidatesCreated) > 0 ? 'good' : 'neutral',
    }));

  const positions = toArray(positionRows)
    .slice()
    .sort((a, b) => (b.entryMs ?? 0) - (a.entryMs ?? 0))
    .slice(0, limit)
    .map((row) => ({
      id: row.key,
      symbol: row.symbol,
      strategyName: row.strategyName,
      direction: row.direction,
      quantity: row.quantity,
      entryPrice: row.entryPrice,
      currentPrice: row.currentPrice,
      pnl: numberOrNull(row.pnl),
      statusLabel: row.statusLabel,
      statusDot: row.statusDot,
      at: row.entryMs,
      tone: row.status === 'unprotected'
        ? 'danger'
        : (numberOrNull(row.pnl) == null ? 'neutral' : (row.pnl < 0 ? 'danger' : 'good')),
    }));

  return { trades: recentTrades, scannerEvents, positions };
}
