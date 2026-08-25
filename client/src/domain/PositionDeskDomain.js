// Live Trading Desk: sidan man har uppe MEDAN positioner är öppna.
//
// En rad = en öppen position. Raden byggs ur broker mirror-positionen (som redan
// bär entry, stop, take profit och strategiidentitet) och kompletteras med den
// öppna traden ur journalen — samma identitetskedja, ingen ny datamodell.
//
// Allt "live" räknas här ur befintliga fält: quote-priset som runtime-snapshoten
// redan levererar, kontraktets tickSize/pointValue och positionens entry. Modulen
// hämtar ingenting själv och är ren (inga React-beroenden), så den kan testas utan
// DOM. Ingen ny polling, ingen ny websocket, ingen backendförändring.

import {
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

export const POSITION_STATUS = Object.freeze({
  UNPROTECTED: 'unprotected',
  NEAR_STOP: 'near_stop',
  NEAR_TARGET: 'near_target',
  IN_PROFIT: 'in_profit',
  IN_LOSS: 'in_loss',
  FLAT: 'flat',
  NO_PRICE: 'no_price',
});

// Rank = ordningen på skärmen. Det som kräver ett beslut nu ligger överst:
// oskyddad risk, därefter position som är på väg in i stop, sedan mot target.
const STATUS_META = Object.freeze({
  [POSITION_STATUS.UNPROTECTED]: { label: 'Utan stop', dot: '⚠', tone: 'danger', rank: 0 },
  [POSITION_STATUS.NEAR_STOP]: { label: 'Nära stop', dot: '🟠', tone: 'warning', rank: 1 },
  [POSITION_STATUS.NEAR_TARGET]: { label: 'Nära target', dot: '🔵', tone: 'info', rank: 2 },
  [POSITION_STATUS.IN_PROFIT]: { label: 'I vinst', dot: '🟢', tone: 'success', rank: 3 },
  [POSITION_STATUS.IN_LOSS]: { label: 'I förlust', dot: '🔴', tone: 'danger', rank: 4 },
  [POSITION_STATUS.FLAT]: { label: 'Oförändrad', dot: '⚪', tone: 'neutral', rank: 5 },
  [POSITION_STATUS.NO_PRICE]: { label: 'Utan pris', dot: '⚪', tone: 'warning', rank: 6 },
});

// "Nära" mäts i den risk positionen själv definierat: kvar till stop respektive
// target som andel av det ursprungliga avståndet. Ingen ny tröskel hittas på —
// 25 % är samma "sista fjärdedel" som varningen i positionskortet använde.
const NEAR_FRACTION = 0.25;

export function positionStatusMeta(status) {
  return STATUS_META[status] || STATUS_META[POSITION_STATUS.NO_PRICE];
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstValue(...values) {
  return values.find((value) => hasValue(value)) ?? null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function msOrNull(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function rootOf(row = {}) {
  const text = String(row.root || row.symbol || row.localSymbol || '').trim().toUpperCase();
  return text || null;
}

export function directionOf(source = {}) {
  const text = String(firstValue(source.direction, source.side) || '').trim().toUpperCase();
  if (['LONG', 'BUY', 'BOT'].includes(text)) return 'LONG';
  if (['SHORT', 'SELL', 'SLD'].includes(text)) return 'SHORT';
  const signed = numberOrNull(source.signedQuantity ?? source.position);
  if (signed > 0) return 'LONG';
  if (signed < 0) return 'SHORT';
  return null;
}

// Priset som faktiskt rör sig mellan hämtningarna är quoten. Brokerns marketPrice
// i mirror-snapshoten är samma quote frusen vid reconciliation-tillfället och
// används bara när quoten saknas.
export function currentPriceOf({ quote = null, position = null } = {}) {
  return firstNumber(
    quote?.price,
    quote?.last,
    quote?.lastPrice,
    quote?.mid,
    position?.currentPrice,
    position?.marketPrice,
  );
}

export function quoteFreshness(quote = null) {
  if (!quote) return { live: false, label: 'ingen quote', tone: 'warning' };
  if (quote.stale === true) return { live: false, label: 'stale quote', tone: 'warning' };
  if (quote.fallback === true || quote.simulated === true) return { live: false, label: 'fallback-feed', tone: 'warning' };
  if (quote.delayed === true) return { live: true, label: 'delayed', tone: 'warning' };
  return { live: true, label: firstValue(quote.source, 'live') || 'live', tone: 'success' };
}

// Kärnan i "live": allt nedan är en funktion av priset just nu, så det räcker att
// quoten uppdateras för att PnL, ticks, R och avstånden ska följa med.
export function livePositionMetrics({
  direction = null,
  entryPrice = null,
  currentPrice = null,
  quantity = null,
  stopPrice = null,
  takeProfitPrice = null,
  tickSize = null,
  pointValue = null,
  fallbackPnl = null,
} = {}) {
  const short = direction === 'SHORT';
  const entry = numberOrNull(entryPrice);
  const price = numberOrNull(currentPrice);
  const stop = numberOrNull(stopPrice);
  const target = numberOrNull(takeProfitPrice);
  const contracts = numberOrNull(quantity);
  const tick = numberOrNull(tickSize);
  const point = numberOrNull(pointValue);

  const sign = short ? -1 : 1;
  const points = (entry == null || price == null || !direction) ? null : (price - entry) * sign;
  const ticks = (points == null || tick == null || tick === 0) ? null : points / tick;
  const computedPnl = (points == null || point == null) ? null : points * point * (contracts == null ? 1 : Math.abs(contracts));
  const pnl = computedPnl != null ? computedPnl : numberOrNull(fallbackPnl);
  const pnlPercent = (points == null || entry == null || entry === 0) ? null : (points / entry) * 100;

  // Risken är avståndet entry→stop. R är därför positionens egen måttstock, inte
  // en kontostorlek vi skulle behöva gissa.
  const riskPoints = (entry == null || stop == null) ? null : Math.abs(entry - stop);
  const rewardPoints = (entry == null || target == null) ? null : Math.abs(target - entry);
  const rMultiple = (points == null || riskPoints == null || riskPoints === 0) ? null : points / riskPoints;

  // Avstånden är "hur mycket luft är kvar": positivt = stop/target är inte träffad.
  const distanceToStop = (price == null || stop == null) ? null : (short ? stop - price : price - stop);
  const distanceToTarget = (price == null || target == null) ? null : (short ? price - target : target - price);

  return {
    points,
    ticks,
    pnl,
    pnlComputed: computedPnl != null,
    pnlPercent,
    riskPoints,
    rewardPoints,
    rMultiple,
    distanceToStop,
    distanceToStopTicks: (distanceToStop == null || tick == null || tick === 0) ? null : distanceToStop / tick,
    distanceToStopPercent: (distanceToStop == null || price == null || price === 0) ? null : (distanceToStop / price) * 100,
    // Andel kvar av den ursprungliga risken respektive vägen till target — det är
    // den som avgör om raden ska larma.
    stopFraction: (distanceToStop == null || riskPoints == null || riskPoints === 0) ? null : distanceToStop / riskPoints,
    distanceToTarget,
    distanceToTargetTicks: (distanceToTarget == null || tick == null || tick === 0) ? null : distanceToTarget / tick,
    distanceToTargetPercent: (distanceToTarget == null || price == null || price === 0) ? null : (distanceToTarget / price) * 100,
    targetFraction: (distanceToTarget == null || rewardPoints == null || rewardPoints === 0) ? null : distanceToTarget / rewardPoints,
    tickSize: tick,
    pointValue: point,
  };
}

export function resolvePositionStatus({ metrics = {}, stopPrice = null, currentPrice = null } = {}) {
  if (numberOrNull(stopPrice) == null) return POSITION_STATUS.UNPROTECTED;
  if (numberOrNull(currentPrice) == null) return POSITION_STATUS.NO_PRICE;
  if (metrics.stopFraction != null && metrics.stopFraction <= NEAR_FRACTION) return POSITION_STATUS.NEAR_STOP;
  if (metrics.targetFraction != null && metrics.targetFraction <= NEAR_FRACTION) return POSITION_STATUS.NEAR_TARGET;
  if (metrics.pnl == null) return POSITION_STATUS.NO_PRICE;
  if (metrics.pnl > 0) return POSITION_STATUS.IN_PROFIT;
  if (metrics.pnl < 0) return POSITION_STATUS.IN_LOSS;
  return POSITION_STATUS.FLAT;
}

function indexByRoot(rows = []) {
  const map = new Map();
  for (const row of toArray(rows)) {
    const root = rootOf(row || {});
    if (root && !map.has(root)) map.set(root, row);
  }
  return map;
}

function isOpenTrade(trade = {}) {
  return trade?.status === 'open';
}

function tradeKeys(trade = {}) {
  return [
    trade.executionId,
    trade.conId,
  ].filter(hasValue).map((value) => String(value));
}

function buildRow({
  key,
  source,
  position = null,
  trade = null,
  quote = null,
  instrument = null,
  strategy = null,
  brokerAggregate = null,
  now,
}) {
  const direction = directionOf(position || {}) || directionOf({ direction: trade?.direction }) || null;
  const entryPrice = firstNumber(
    position?.entryPrice,
    trade?.entryPrice,
    position?.averageCost,
    position?.avgCost,
  );
  const currentPrice = currentPriceOf({ quote, position });
  // FIXED: Logical trade always qty=1, NOT broker aggregate qty
  const quantity = 1;
  const stopPrice = firstNumber(position?.stopLoss, position?.stopPrice, trade?.stopPrice);
  const takeProfitPrice = firstNumber(position?.takeProfit, position?.takeProfitPrice, trade?.takeProfitPrice);
  const tickSize = firstNumber(position?.tickSize, instrument?.tickSize, quote?.tickSize);
  const pointValue = firstNumber(position?.pointValueUsd, instrument?.pointValueUsd, instrument?.contractSize);

  const metrics = livePositionMetrics({
    direction,
    entryPrice,
    currentPrice,
    quantity,
    stopPrice,
    takeProfitPrice,
    tickSize,
    pointValue,
    fallbackPnl: firstNumber(position?.unrealizedPnl, position?.unrealizedPnlUsd, trade?.unrealizedPnl),
  });

  const status = resolvePositionStatus({ metrics, stopPrice, currentPrice });
  const meta = positionStatusMeta(status);
  const entryTime = firstValue(position?.entryTime, trade?.entryTime, position?.openedAt);
  const entryMs = msOrNull(entryTime);
  const strategyId = firstValue(position?.strategyId, trade?.strategyId);

  return {
    key,
    source,
    status,
    statusLabel: meta.label,
    statusDot: meta.dot,
    statusTone: meta.tone,
    statusRank: meta.rank,

    symbol: firstValue(rootOf(position || {}), trade?.symbol, rootOf(quote || {})),
    localSymbol: firstValue(position?.localSymbol, trade?.localSymbol),
    conId: firstValue(position?.conId, trade?.conId),
    direction,
    quantity,

    strategyId,
    strategyName: firstValue(strategy?.strategyName, trade?.strategyName, strategyId),
    strategyFamily: firstValue(strategy?.strategyFamily, trade?.strategyFamily),

    entryPrice,
    currentPrice,
    stopPrice,
    takeProfitPrice,

    ...metrics,

    entryTime,
    entryMs,
    // Duration räknas mot den klocka anroparen skickar in, så panelen kan låta den
    // ticka lokalt utan att någon ny hämtning behövs.
    durationMs: entryMs == null ? null : Math.max(0, now - entryMs),

    quote,
    quoteFreshness: quoteFreshness(quote),
    instrument,
    position,
    trade,
    // Broker aggregate (qty sum för alla logical trades samma instrument)
    brokerAggregate: brokerAggregate != null ? brokerAggregate : { symbol: null, quantity: null },
    // Identitetskedjan följer med raden så detaljvyn aldrig behöver leta upp den.
    identity: trade?.identity || {
      signalId: firstValue(position?.signalId),
      candidateId: firstValue(position?.candidateId),
      lifecycleId: firstValue(position?.lifecycleId),
      intentId: firstValue(position?.intentId),
      executionId: firstValue(position?.executionId),
      tradeId: null,
      idempotencyKey: firstValue(position?.idempotencyKey),
    },
    executionId: firstValue(position?.executionId, trade?.executionId),
  };
}

export function buildPositionDeskRows({
  brokerPositions = [],
  trades = [],
  quotes = [],
  instruments = [],
  resolveStrategy = null,
  now = Date.now(),
} = {}) {
  const quoteByRoot = indexByRoot(quotes);
  const instrumentByRoot = indexByRoot(instruments);

  const openTrades = toArray(trades).filter(isOpenTrade);
  const brokerPositionsByConId = new Map();
  for (const pos of toArray(brokerPositions)) {
    const conId = String(pos.conId || pos.id || '');
    if (conId && !brokerPositionsByConId.has(conId)) {
      brokerPositionsByConId.set(conId, pos);
    }
  }

  // Aggregate broker qty by symbol for display
  const brokerAggregateBySymbol = new Map();
  for (const pos of toArray(brokerPositions)) {
    const root = rootOf(pos || {});
    if (!root) continue;
    if (!brokerAggregateBySymbol.has(root)) {
      brokerAggregateBySymbol.set(root, { symbol: root, quantity: 0, conId: pos.conId });
    }
    const agg = brokerAggregateBySymbol.get(root);
    const qty = Math.abs(Number(pos.position ?? pos.quantity ?? 0) || 0);
    agg.quantity += qty;
  }

  const rows = [];

  // PRIMARY FLOW: Iterate over LOGICAL TRADES (one row per trade, qty=1 always)
  // Do NOT iterate broker positions: each position aggregates multiple trades.
  for (const trade of openTrades) {
    const conId = String(trade.conId || '');
    const brokerPos = conId ? brokerPositionsByConId.get(conId) : null;
    const root = rootOf(brokerPos || {}) || rootOf({ symbol: trade.symbol }) || null;
    const brokerAggregate = root ? brokerAggregateBySymbol.get(root) || null : null;

    rows.push(buildRow({
      key: trade.executionId || trade.key,
      source: 'logical_trade',
      position: brokerPos || null,
      trade,
      quote: root ? quoteByRoot.get(root) || null : null,
      instrument: root ? instrumentByRoot.get(root) || null : null,
      strategy: typeof resolveStrategy === 'function' && trade.strategyId ? resolveStrategy({ strategyId: trade.strategyId }) : null,
      brokerAggregate,
      now,
    }));
  }

  // Det som kräver ett beslut först hamnar överst; därefter sämsta R.
  return rows.sort((a, b) => (
    a.statusRank - b.statusRank
    || (a.rMultiple ?? Number.POSITIVE_INFINITY) - (b.rMultiple ?? Number.POSITIVE_INFINITY)
    || String(a.symbol).localeCompare(String(b.symbol))
  ));
}

function dayStartMs(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function summarizePositionDesk(rows = [], { trades = [], now = Date.now() } = {}) {
  const list = toArray(rows);
  const withPnl = list.filter((row) => numberOrNull(row.pnl) != null);
  const unrealizedPnl = withPnl.length
    ? withPnl.reduce((total, row) => total + numberOrNull(row.pnl), 0)
    : null;

  // Dagens realiserade resultat läses ur samma journalrader som Trades och
  // Analytics använder — siffrorna kan därför inte gå isär.
  const startOfDay = dayStartMs(now);
  const closedToday = toArray(trades).filter((trade) => (
    numberOrNull(trade?.netPnl) != null
    && trade?.exitMs != null
    && trade.exitMs >= startOfDay
    && trade.exitMs <= now
  ));
  const realizedToday = closedToday.length
    ? closedToday.reduce((total, trade) => total + numberOrNull(trade.netPnl), 0)
    : null;

  const durations = list.map((row) => numberOrNull(row.durationMs)).filter((value) => value != null);

  return {
    openPositions: list.length,
    unrealizedPnl,
    realizedToday,
    // Dagens netto = det som redan är taget hem plus det som står ute just nu.
    netToday: realizedToday == null && unrealizedPnl == null
      ? null
      : (realizedToday || 0) + (unrealizedPnl || 0),
    closedToday: closedToday.length,
    winningPositions: withPnl.filter((row) => numberOrNull(row.pnl) > 0).length,
    losingPositions: withPnl.filter((row) => numberOrNull(row.pnl) < 0).length,
    unprotectedPositions: list.filter((row) => row.status === POSITION_STATUS.UNPROTECTED).length,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : null,
  };
}
