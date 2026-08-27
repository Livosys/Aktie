// Trade journal: en rad = EN trade.
//
// Broker-verkligheten är orderben (entry / stopLoss / takeProfit / flatten) och
// fills. Användaren bryr sig om traden. Den här modulen grupperar därför den
// befintliga identitetskedjan — signalId → candidateId → intentId → executionId →
// tradeId → brokerOrderIds — till en trade per executionId.
//
// Ingen ny datamodell och ingen ny persistence: allt läses ur runtime-snapshotens
// brokerReconciliation.intents, brokerOrders, brokerFills och brokerOrderStatuses.
// Modulen är ren (inga React-beroenden) så den kan enhetstestas utan DOM.

import {
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

export const TRADE_STATUS = Object.freeze({
  OPEN: 'open',
  WIN: 'win',
  LOSS: 'loss',
  BREAKEVEN: 'breakeven',
  CLOSED_UNVERIFIED: 'closed_unverified',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
});

const STATUS_META = Object.freeze({
  open: { label: 'Open', dot: '🟡', tone: 'warning' },
  win: { label: 'Win', dot: '🟢', tone: 'success' },
  loss: { label: 'Loss', dot: '🔴', tone: 'danger' },
  breakeven: { label: 'Breakeven', dot: '⚪', tone: 'neutral' },
  // Stängd hos brokern men utan broker-verifierad realiserad PnL. Att visa den som
  // breakeven vore en felaktig uppgift om pengar — okänt är inte noll.
  closed_unverified: { label: 'Closed (PnL saknas)', dot: '⚪', tone: 'neutral' },
  cancelled: { label: 'Cancelled', dot: '⚪', tone: 'neutral' },
  rejected: { label: 'Rejected', dot: '⚪', tone: 'danger' },
});

// Sorteringsgrupp: öppna trades först, sedan stängda, sist avbrutna.
const STATUS_GROUP = Object.freeze({
  open: 0,
  win: 1,
  loss: 1,
  breakeven: 1,
  closed_unverified: 1,
  rejected: 2,
  cancelled: 2,
});

// Journalen ska fungera lika bra vid 10 som vid 3000 trades. Renderingen är
// paginerad, så taket skyddar inte DOM:en — det skulle bara tysta bort äldre
// trades ur både tabell och statistik. Taket är därför en yttre säkerhetsgräns,
// inte en visningsgräns.
export const DEFAULT_TRADE_LIMIT = 3000;

export const NO_STRATEGY_ID = '__no_strategy__';
export const NO_STRATEGY_LABEL = 'Utan strategi (manuell flatten)';
export const NO_FAMILY_ID = '__no_family__';
export const NO_FAMILY_LABEL = 'Utan familj';
export const NO_SYMBOL_ID = '__no_symbol__';
export const NO_SYMBOL_LABEL = 'Utan marknad';

// IBKR-orderRef bär executionId: TOS-PAPER-<executionId>-<leg>.
const ORDER_REF_PATTERN = /^TOS-PAPER-(.+)-(entry|stopLoss|takeProfit|emergencyFlatten|flatten)$/;

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

export function parseOrderRef(orderRef) {
  const text = String(orderRef || '');
  const match = ORDER_REF_PATTERN.exec(text);
  if (match) return { executionId: match[1], leg: match[2] };
  // Okänt benschema ska inte tappa kopplingen: ta allt mellan prefix och sista bindestreck.
  if (text.startsWith('TOS-PAPER-')) {
    const rest = text.slice('TOS-PAPER-'.length);
    const cut = rest.lastIndexOf('-');
    if (cut > 0) return { executionId: rest.slice(0, cut), leg: rest.slice(cut + 1) };
    return { executionId: rest, leg: null };
  }
  return { executionId: null, leg: null };
}

export function executionIdOf(row = {}) {
  return firstValue(row.executionId, parseOrderRef(row.orderRef).executionId);
}

// Benet heter olika i olika källor: orderRef bär camelCase (stopLoss), medan
// backendens normaliserade fills bär exitReason-formen (stop_loss). Utan en
// gemensam form skulle samma ben bli två rader i detaljkortet.
const LEG_ALIASES = Object.freeze({
  entry: 'entry',
  stop_loss: 'stopLoss',
  stoploss: 'stopLoss',
  stop: 'stopLoss',
  take_profit: 'takeProfit',
  takeprofit: 'takeProfit',
  target: 'takeProfit',
  emergency_flatten: 'flatten',
  emergencyflatten: 'flatten',
  flatten: 'flatten',
});

export function normalizeLegName(value) {
  if (!hasValue(value)) return null;
  const text = String(value).trim();
  return LEG_ALIASES[text.toLowerCase()] || text;
}

function legOf(row = {}) {
  return normalizeLegName(firstValue(parseOrderRef(row.orderRef).leg, row.orderLeg));
}

function groupByExecutionId(rows = []) {
  const map = new Map();
  for (const row of toArray(rows)) {
    const executionId = executionIdOf(row || {});
    if (!executionId) continue;
    if (!map.has(executionId)) map.set(executionId, []);
    map.get(executionId).push(row);
  }
  return map;
}

function indexOrderStatuses(orderStatuses = []) {
  const byOrderId = new Map();
  for (const status of toArray(orderStatuses)) {
    const orderId = firstValue(status?.orderId, status?.ibOrderId);
    if (orderId == null) continue;
    const key = String(orderId);
    const existing = byOrderId.get(key);
    // Senaste statusraden per orderId vinner.
    if (!existing || (msOrNull(status?.updatedAt) ?? 0) >= (msOrNull(existing?.updatedAt) ?? 0)) {
      byOrderId.set(key, status);
    }
  }
  return byOrderId;
}

export function directionOf(intent = {}) {
  const direction = String(firstValue(intent.direction, intent.side, '') || '').trim().toUpperCase();
  if (['LONG', 'BUY', 'BOT'].includes(direction)) return 'LONG';
  if (['SHORT', 'SELL', 'SLD'].includes(direction)) return 'SHORT';
  return null;
}

// Exitorsaken är deterministisk ur vilket orderben som fylldes — samma regel som
// backend använder i normalizeBrokerExecution.
export function exitReasonOf({ filledLeg = null, status = null, hasExit = false } = {}) {
  const leg = String(filledLeg || '').trim();
  if (leg === 'stopLoss') return 'STOP';
  if (leg === 'takeProfit') return 'TAKE PROFIT';
  if (leg === 'flatten' || leg === 'emergencyFlatten') return 'MANUAL';
  if (status === 'rejected') return 'ERROR';
  if (!hasExit) return null;
  return 'UNKNOWN';
}

// Broker-execution-läget separat från vinst/förlust: en trade kan vara Filled och
// ändå vara en förlust.
function executionStateOf({ intentStatus, hasEntry, hasExit }) {
  const status = String(intentStatus || '').trim().toLowerCase();
  if (status === 'rejected') return 'Rejected';
  if (hasExit) return 'Filled';
  if (hasEntry) return 'Open';
  if (['cancelled', 'canceled', 'expired'].includes(status)) return 'Cancelled';
  if (['intent_created', 'guard_passed', 'submit_started', 'submitted', 'working'].includes(status)) return 'Open';
  return status ? status : 'Unknown';
}

function tradeStatusOf({ intentStatus, hasEntry, hasExit, netPnl }) {
  const status = String(intentStatus || '').trim().toLowerCase();
  if (hasExit) {
    if (netPnl == null) return TRADE_STATUS.CLOSED_UNVERIFIED;
    if (netPnl > 0) return TRADE_STATUS.WIN;
    if (netPnl < 0) return TRADE_STATUS.LOSS;
    return TRADE_STATUS.BREAKEVEN;
  }
  // Terminal intent-status går före entry-fillen: ett intent som är rejected,
  // cancelled eller expired är stängt hos brokern även om entrybenet hann fylla.
  // Testas hasEntry först blir gamla utgångna intents renderade som levande
  // positioner (reconciliation dämpar dem redan och rapporterar 0 discrepancies).
  if (status === 'rejected') return TRADE_STATUS.REJECTED;
  if (['cancelled', 'canceled', 'expired'].includes(status)) return TRADE_STATUS.CANCELLED;
  if (hasEntry) return TRADE_STATUS.OPEN;
  return TRADE_STATUS.OPEN;
}

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.cancelled;
}

// Prisrörelse i procent från entry. För en futures-position är det samma sak som
// avkastning på nominellt värde, så ingen kontraktsmultiplikator behövs.
export function pnlPercentOf({ entryPrice, exitPrice, direction }) {
  const entry = numberOrNull(entryPrice);
  const exit = numberOrNull(exitPrice);
  if (entry == null || exit == null || entry === 0) return null;
  const sign = direction === 'SHORT' ? -1 : 1;
  return ((exit - entry) / entry) * 100 * sign;
}

function buildLegs({ intent = {}, ordersByExecutionId, fillsByExecutionId, statusByOrderId, executionId }) {
  const orders = toArray(ordersByExecutionId.get(executionId));
  const fills = toArray(fillsByExecutionId.get(executionId));
  const expected = toArray(intent.expectedBracketLegs);
  const legs = new Map();

  const ensure = (rawName) => {
    const key = normalizeLegName(rawName) || 'unknown';
    if (!legs.has(key)) {
      legs.set(key, {
        leg: key,
        orderId: null,
        orderRef: null,
        transmit: null,
        orderType: null,
        limitPrice: null,
        stopPrice: null,
        quantity: null,
        status: null,
        filled: null,
        remaining: null,
        avgFillPrice: null,
        updatedAt: null,
        fills: [],
      });
    }
    return legs.get(key);
  };

  for (const row of expected) {
    const leg = ensure(row?.leg || parseOrderRef(row?.orderRef).leg);
    leg.orderId = firstValue(row?.orderId, leg.orderId);
    leg.orderRef = firstValue(row?.orderRef, leg.orderRef);
    leg.transmit = row?.transmit ?? leg.transmit;
  }

  for (const order of orders) {
    const leg = ensure(legOf(order));
    leg.orderId = firstValue(order?.orderId, order?.id, leg.orderId);
    leg.orderRef = firstValue(order?.orderRef, leg.orderRef);
    leg.orderType = firstValue(order?.orderType, leg.orderType);
    leg.limitPrice = firstNumber(order?.limitPrice, leg.limitPrice);
    leg.stopPrice = firstNumber(order?.stopPrice, leg.stopPrice);
    leg.quantity = firstNumber(order?.quantity, leg.quantity);
    leg.status = firstValue(order?.status, leg.status);
    leg.updatedAt = firstValue(order?.updatedAt, leg.updatedAt);
    leg.permId = firstValue(order?.permId, leg.permId);
  }

  for (const fill of fills) {
    const leg = ensure(legOf(fill));
    leg.orderId = firstValue(fill?.orderId, fill?.ibOrderId, leg.orderId);
    leg.orderRef = firstValue(fill?.orderRef, leg.orderRef);
    leg.permId = firstValue(fill?.permId, leg.permId);
    leg.fills.push(fill);
  }

  for (const leg of legs.values()) {
    if (leg.orderId == null) continue;
    const status = statusByOrderId.get(String(leg.orderId));
    if (!status) continue;
    leg.status = firstValue(status.status, status.ibStatus, leg.status);
    leg.ibStatus = firstValue(status.ibStatus, leg.ibStatus);
    leg.filled = firstNumber(status.filled, leg.filled);
    leg.remaining = firstNumber(status.remaining, leg.remaining);
    leg.avgFillPrice = firstNumber(status.avgFillPrice, leg.avgFillPrice);
    leg.parentId = firstValue(status.parentId, leg.parentId);
    leg.permId = firstValue(status.permId, leg.permId);
    leg.updatedAt = firstValue(status.updatedAt, leg.updatedAt);
  }

  const order = ['entry', 'stopLoss', 'takeProfit', 'flatten', 'emergencyFlatten'];
  return Array.from(legs.values()).sort((a, b) => {
    const ai = order.indexOf(a.leg);
    const bi = order.indexOf(b.leg);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });
}

// Broker-tidslinjen byggs bara ur fält som redan finns på intenten. Ingen händelse
// hittas på; saknad tidsstämpel ger ingen rad.
function buildTimeline(intent = {}) {
  const steps = [
    { key: 'intent_created', label: 'Intent created', at: intent.createdAt },
    { key: 'submit_started', label: 'Submit started', at: intent.submitStartedAt },
    { key: 'submitted', label: 'Submitted', at: intent.submittedAt },
    { key: 'entry_filled', label: 'Entry filled', at: intent.entryFilledAt, detail: intent.entryFilledPrice },
    { key: 'exit_filled', label: 'Exit filled', at: intent.filledAt, detail: intent.filledPrice },
    { key: 'resolved', label: 'Resolved', at: intent.resolvedAt, detail: intent.resolvedBy },
    { key: 'updated', label: 'Last update', at: intent.updatedAt },
  ];
  return steps.filter((step) => hasValue(step.at));
}

function collectIds(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!hasValue(value)) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildTradeRow({
  executionId,
  intent = {},
  ordersByExecutionId,
  fillsByExecutionId,
  statusByOrderId,
  positionsByConId,
  resolveStrategy,
}) {
  const orders = toArray(ordersByExecutionId.get(executionId));
  const fills = toArray(fillsByExecutionId.get(executionId));
  const legs = buildLegs({ intent, ordersByExecutionId, fillsByExecutionId, statusByOrderId, executionId });
  const legByName = new Map(legs.map((leg) => [leg.leg, leg]));

  const direction = directionOf(intent) || directionOf(orders[0] || {});
  const entryPrice = firstNumber(intent.entryFilledPrice, intent.entryAvgFillPrice, intent.entryLastFillPrice);
  const exitPrice = firstNumber(intent.filledPrice, intent.filledAvgPrice, intent.filledLastPrice);
  const hasEntry = entryPrice != null || hasValue(intent.entryFilledAt) || hasValue(intent.entryExecId);
  const hasExit = exitPrice != null || hasValue(intent.filledAt) || hasValue(intent.filledExecId);
  const filledLeg = firstValue(intent.filledLeg);

  // IBKR:s realizedPNL i commissionReport är redan netto efter courtage — samma
  // tolkning som futuresPaperStrategyPerformanceService gör i backend.
  const netPnl = hasExit ? firstNumber(intent.filledRealizedPNL, intent.filledRealizedPnl, intent.realizedPNL) : null;
  const entryCommission = numberOrNull(intent.entryCommission);
  const exitCommission = numberOrNull(intent.filledCommission);
  const commission = entryCommission == null && exitCommission == null
    ? null
    : (entryCommission || 0) + (exitCommission || 0);
  const grossPnl = netPnl == null ? null : netPnl + (commission || 0);

  const status = tradeStatusOf({ intentStatus: intent.status, hasEntry, hasExit, netPnl });
  const entryTime = firstValue(intent.entryFilledAt, intent.submitStartedAt, intent.createdAt);
  const exitTime = firstValue(intent.filledAt);
  const entryMs = msOrNull(entryTime);
  const exitMs = msOrNull(exitTime);

  const stopFromLeg = firstNumber(legByName.get('stopLoss')?.stopPrice, legByName.get('stopLoss')?.limitPrice);
  const takeProfitFromLeg = firstNumber(legByName.get('takeProfit')?.limitPrice, legByName.get('takeProfit')?.stopPrice);
  const stopPrice = firstNumber(stopFromLeg, filledLeg === 'stopLoss' ? exitPrice : null);
  const takeProfitPrice = firstNumber(takeProfitFromLeg, filledLeg === 'takeProfit' ? exitPrice : null);

  const conId = firstValue(intent.conId, orders[0]?.conId, fills[0]?.conId);
  const position = conId == null ? null : positionsByConId.get(String(conId)) || null;

  const strategyId = firstValue(intent.strategyId, orders[0]?.strategyId, fills[0]?.strategyId);
  const strategy = typeof resolveStrategy === 'function'
    ? resolveStrategy({ strategyId, candidateId: intent.candidateId, direction, symbol: intent.root })
    : null;

  const brokerOrderIds = collectIds([
    intent.ibOrderId,
    intent.parentOrderId,
    intent.entryFilledOrderId,
    intent.filledOrderId,
    intent.protectiveOrderCancelledId,
    intent.rejectedOrderId,
    intent.cancelledOrderId,
    ...toArray(intent.expectedOrderIds),
    ...orders.map((row) => row?.orderId),
    ...legs.map((leg) => leg.orderId),
  ]);

  return {
    key: executionId,
    executionId,
    // Identitetskedjan — oförändrad, bara omgrupperad.
    identity: {
      signalId: firstValue(intent.signalId, fills[0]?.signalId, orders[0]?.signalId),
      candidateId: firstValue(intent.candidateId, fills[0]?.candidateId, orders[0]?.candidateId),
      lifecycleId: firstValue(intent.lifecycleId, fills[0]?.lifecycleId, orders[0]?.lifecycleId),
      intentId: firstValue(intent.intentId, intent.idempotencyKey, fills[0]?.intentId),
      executionId,
      tradeId: firstValue(intent.tradeId),
      idempotencyKey: firstValue(intent.idempotencyKey),
    },
    tradeId: firstValue(intent.tradeId),
    signalId: firstValue(intent.signalId),
    candidateId: firstValue(intent.candidateId),
    intentId: firstValue(intent.intentId, intent.idempotencyKey),
    lifecycleId: firstValue(intent.lifecycleId),

    status,
    statusLabel: statusMeta(status).label,
    statusDot: statusMeta(status).dot,
    statusTone: statusMeta(status).tone,
    executionState: executionStateOf({ intentStatus: intent.status, hasEntry, hasExit }),
    intentStatus: firstValue(intent.status),

    symbol: firstValue(intent.root, intent.symbol, orders[0]?.symbol, fills[0]?.localSymbol),
    localSymbol: firstValue(intent.localSymbol, orders[0]?.localSymbol, fills[0]?.localSymbol),
    conId,
    direction,
    side: firstValue(intent.side, orders[0]?.action),
    quantity: firstNumber(intent.quantity, intent.entryQuantity, orders[0]?.quantity),

    strategyId,
    strategyName: firstValue(strategy?.strategyName, intent.strategyName, strategyId),
    strategyFamily: firstValue(strategy?.strategyFamily, intent.strategyFamily),
    strategy: strategy || null,

    entryTime,
    exitTime,
    entryMs,
    exitMs,
    durationMs: entryMs != null && exitMs != null ? Math.max(0, exitMs - entryMs) : null,
    signalTimestamp: firstValue(intent.signalTimestamp),
    createdAt: firstValue(intent.createdAt),
    updatedAt: firstValue(intent.updatedAt),
    updatedMs: msOrNull(intent.updatedAt),

    entryPrice,
    exitPrice,
    stopPrice,
    takeProfitPrice,
    orderType: firstValue(intent.orderType, legByName.get('entry')?.orderType),

    pnl: netPnl,
    netPnl,
    grossPnl,
    commission,
    commissionCurrency: firstValue(intent.filledCommissionCurrency, intent.entryCommissionCurrency),
    pnlPercent: pnlPercentOf({ entryPrice, exitPrice, direction }),
    unrealizedPnl: status === TRADE_STATUS.OPEN ? numberOrNull(position?.unrealizedPnl) : null,

    exitReason: exitReasonOf({ filledLeg, status: intent.status, hasExit }),
    filledLeg,

    broker: 'IBKR Paper',
    accountMasked: firstValue(intent.paperAccountIdMasked, intent.expectedAccountMasked, orders[0]?.accountMasked, fills[0]?.accountMasked),
    executionTarget: firstValue(intent.executionTarget),
    source: firstValue(orders[0]?.source, fills[0]?.source, 'ibkr_paper'),

    brokerOrderIds,
    permIds: collectIds([...orders.map((row) => row?.permId), ...fills.map((row) => row?.permId), ...legs.map((leg) => leg?.permId)]),
    execIds: collectIds([intent.entryExecId, intent.filledExecId, ...fills.map((row) => row?.execId)]),
    orderRefs: collectIds([intent.orderRef, ...toArray(intent.orderRefs), ...orders.map((row) => row?.orderRef), ...fills.map((row) => row?.orderRef)]),

    legs,
    orders,
    fills,
    timeline: buildTimeline(intent),
    position,

    // Reconciliation / replay-bevis — oförändrade fält, bara flyttade bakom expand.
    evidence: {
      contractFingerprint: firstValue(intent.contractFingerprint),
      evidenceFingerprint: firstValue(intent.evidenceFingerprint),
      reconciliationRequired: intent.reconciliationRequired === true,
      identityStatus: firstValue(intent.identityStatus),
      migrationVersion: firstValue(intent.migrationVersion),
      migrationSource: firstValue(intent.migrationSource),
      migratedAt: firstValue(intent.migratedAt),
      resolvedBy: firstValue(intent.resolvedBy),
      resolvedAt: firstValue(intent.resolvedAt),
      previousStatus: firstValue(intent.previousStatus),
      repairedAt: firstValue(intent.repairedAt),
      repairNote: firstValue(intent.repairNote),
      blocker: firstValue(intent.blocker),
      ibErrorCode: firstValue(intent.ibErrorCode),
      ibErrorMessage: firstValue(intent.ibErrorMessage),
      protectiveOrderCancelledId: firstValue(intent.protectiveOrderCancelledId),
      protectiveOrderCancelReason: firstValue(intent.protectiveOrderCancelReason),
      rejectedReason: firstValue(intent.rejectedReason),
      cancelReason: firstValue(intent.cancelReason),
      entryExecutionTime: firstValue(intent.entryExecutionTime),
      filledExecutionTime: firstValue(intent.filledExecutionTime),
    },
    intent,
  };
}

// Sortering: öppna överst, sedan senast stängda först.
function compareTrades(a, b) {
  const groupDiff = (STATUS_GROUP[a.status] ?? 3) - (STATUS_GROUP[b.status] ?? 3);
  if (groupDiff !== 0) return groupDiff;
  const aTime = a.exitMs ?? a.entryMs ?? a.updatedMs ?? 0;
  const bTime = b.exitMs ?? b.entryMs ?? b.updatedMs ?? 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(b.executionId).localeCompare(String(a.executionId));
}

export function buildTradeJournal({
  intents = [],
  brokerOrders = [],
  brokerFills = [],
  brokerOrderStatuses = [],
  brokerPositions = [],
  resolveStrategy = null,
  limit = DEFAULT_TRADE_LIMIT,
} = {}) {
  const ordersByExecutionId = groupByExecutionId(brokerOrders);
  const fillsByExecutionId = groupByExecutionId(brokerFills);
  const statusByOrderId = indexOrderStatuses(brokerOrderStatuses);
  const positionsByConId = new Map(
    toArray(brokerPositions)
      .filter((row) => row?.conId != null)
      .map((row) => [String(row.conId), row]),
  );

  const intentByExecutionId = new Map();
  for (const intent of toArray(intents)) {
    const executionId = executionIdOf(intent || {});
    if (!executionId) continue;
    // Intent-loggen är append-only: senaste posten per executionId är sanningen.
    const existing = intentByExecutionId.get(executionId);
    if (!existing || (msOrNull(intent?.updatedAt) ?? 0) >= (msOrNull(existing?.updatedAt) ?? 0)) {
      intentByExecutionId.set(executionId, intent);
    }
  }

  // Brokerrader utan intent får ändå en rad — ingen execution får försvinna.
  const executionIds = new Set([
    ...intentByExecutionId.keys(),
    ...ordersByExecutionId.keys(),
    ...fillsByExecutionId.keys(),
  ]);

  const trades = Array.from(executionIds).map((executionId) => buildTradeRow({
    executionId,
    intent: intentByExecutionId.get(executionId) || {},
    ordersByExecutionId,
    fillsByExecutionId,
    statusByOrderId,
    positionsByConId,
    resolveStrategy,
  }));

  trades.sort(compareTrades);
  const capped = limit > 0 ? trades.slice(0, limit) : trades;
  return { trades: capped, totalTrades: trades.length, truncated: trades.length > capped.length };
}

// "Vilka trades kräver uppmärksamhet?" ska gå att svara på utan att öppna något.
// Bara lägen där någon faktiskt behöver agera räknas — avbrutna ordrar är rutin
// (köplatsen släpps) och skulle bara bli brus i standardvyn.
export function tradeNeedsAttention(trade = {}) {
  if (!trade) return false;
  // Brokern vägrade ordern.
  if (trade.status === TRADE_STATUS.REJECTED) return true;
  // Stängd men utan broker-verifierad PnL — resultatet går inte att utvärdera.
  if (trade.status === TRADE_STATUS.CLOSED_UNVERIFIED) return true;
  // Öppen position utan stop = oskyddad risk just nu.
  if (trade.status === TRADE_STATUS.OPEN && numberOrNull(trade.stopPrice) == null) return true;
  return false;
}

export function summarizeAttention(trades = []) {
  const rows = toArray(trades);
  const rejected = rows.filter((row) => row.status === TRADE_STATUS.REJECTED).length;
  const unverified = rows.filter((row) => row.status === TRADE_STATUS.CLOSED_UNVERIFIED).length;
  const openWithoutStop = rows.filter((row) => row.status === TRADE_STATUS.OPEN
    && numberOrNull(row.stopPrice) == null).length;
  return {
    total: rejected + unverified + openWithoutStop,
    rejected,
    unverified,
    openWithoutStop,
  };
}

export function summarizeTrades(trades = []) {
  const rows = toArray(trades);
  // Stängda med broker-verifierad realiserad PnL — samma urval som backendens
  // strategistatistik gör, så siffrorna inte kan säga emot varandra.
  const closed = rows.filter((row) => row.status === TRADE_STATUS.WIN
    || row.status === TRADE_STATUS.LOSS
    || row.status === TRADE_STATUS.BREAKEVEN);
  const wins = closed.filter((row) => row.status === TRADE_STATUS.WIN);
  const losses = closed.filter((row) => row.status === TRADE_STATUS.LOSS);
  const sum = (list, field) => list.reduce((total, row) => total + (numberOrNull(row[field]) || 0), 0);

  const grossPnl = closed.some((row) => row.grossPnl != null) ? sum(closed, 'grossPnl') : null;
  const netPnl = closed.some((row) => row.netPnl != null) ? sum(closed, 'netPnl') : null;
  const commission = closed.some((row) => row.commission != null) ? sum(closed, 'commission') : null;
  const winSum = sum(wins, 'netPnl');
  const lossSum = sum(losses, 'netPnl');

  // Vilka strategier handlar? — distinkta strategier med trades i urvalet.
  const strategyNames = Array.from(new Set(rows
    .filter((row) => row.strategyId && row.strategyId !== NO_STRATEGY_ID)
    .map((row) => row.strategyName || row.strategyId))).sort();

  return {
    trades: rows.length,
    closedTrades: closed.length,
    strategyNames,
    activeStrategies: strategyNames.length,
    attention: summarizeAttention(rows),
    unverifiedTrades: rows.filter((row) => row.status === TRADE_STATUS.CLOSED_UNVERIFIED).length,
    openTrades: rows.filter((row) => row.status === TRADE_STATUS.OPEN).length,
    cancelledTrades: rows.filter((row) => row.status === TRADE_STATUS.CANCELLED || row.status === TRADE_STATUS.REJECTED).length,
    wins: wins.length,
    losses: losses.length,
    // Win rate = wins / stängda trades (breakeven ingår i nämnaren, inte i wins) —
    // identisk definition med futuresPaperStrategyPerformanceService.
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    grossPnl,
    grossPnlCurrency: grossPnl != null ? 'SEK' : null,
    commission,
    commissionCurrency: commission != null ? 'SEK' : null,
    netPnl,
    netPnlCurrency: netPnl != null ? 'SEK' : null,
    averageWinner: wins.length ? winSum / wins.length : null,
    averageLoser: losses.length ? lossSum / losses.length : null,
    profitFactor: lossSum < 0 ? winSum / Math.abs(lossSum) : null,
  };
}

export const EMPTY_TRADE_FILTERS = Object.freeze({
  status: 'all',
  strategyId: 'all',
  symbol: 'all',
  direction: 'all',
  from: '',
  to: '',
  pnl: 'all',
  openOnly: false,
  search: '',
});

const SEARCH_FIELDS = [
  'executionId',
  'tradeId',
  'intentId',
  'candidateId',
  'signalId',
  'lifecycleId',
  'strategyId',
  'strategyName',
  'symbol',
  'localSymbol',
];

export function tradeMatchesSearch(trade = {}, query = '') {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return true;
  for (const field of SEARCH_FIELDS) {
    if (hasValue(trade[field]) && String(trade[field]).toLowerCase().includes(text)) return true;
  }
  for (const list of [trade.brokerOrderIds, trade.permIds, trade.execIds, trade.orderRefs]) {
    if (toArray(list).some((value) => String(value).toLowerCase().includes(text))) return true;
  }
  return false;
}

export function filterTrades(trades = [], filters = EMPTY_TRADE_FILTERS) {
  const active = { ...EMPTY_TRADE_FILTERS, ...(filters || {}) };
  const fromMs = active.from ? Date.parse(`${active.from}T00:00:00`) : null;
  const toMs = active.to ? Date.parse(`${active.to}T23:59:59.999`) : null;

  return toArray(trades).filter((trade) => {
    if (active.openOnly && trade.status !== TRADE_STATUS.OPEN) return false;
    // 'attention' är ett tvärsnitt över flera statusar, inte en status i sig.
    if (active.status === 'attention') {
      if (!tradeNeedsAttention(trade)) return false;
    } else if (active.status !== 'all' && trade.status !== active.status) return false;
    if (active.strategyId !== 'all' && trade.strategyId !== active.strategyId) return false;
    if (active.symbol !== 'all' && trade.symbol !== active.symbol) return false;
    if (active.direction !== 'all' && trade.direction !== active.direction) return false;
    if (active.pnl === 'positive' && !(numberOrNull(trade.netPnl) > 0)) return false;
    if (active.pnl === 'negative' && !(numberOrNull(trade.netPnl) < 0)) return false;
    if (fromMs != null || toMs != null) {
      const stamp = trade.exitMs ?? trade.entryMs ?? trade.updatedMs;
      if (stamp == null) return false;
      if (fromMs != null && Number.isFinite(fromMs) && stamp < fromMs) return false;
      if (toMs != null && Number.isFinite(toMs) && stamp > toMs) return false;
    }
    return tradeMatchesSearch(trade, active.search);
  });
}

export function tradeFilterOptions(trades = []) {
  const strategies = new Map();
  const symbols = new Set();
  for (const trade of toArray(trades)) {
    if (hasValue(trade.strategyId)) strategies.set(trade.strategyId, trade.strategyName || trade.strategyId);
    if (hasValue(trade.symbol)) symbols.add(trade.symbol);
  }
  return {
    strategies: Array.from(strategies.entries()).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    symbols: Array.from(symbols).sort(),
  };
}

// Samma trade kan ses ur tre vinklar: vilken strategi tog den, vilken familj
// strategin tillhör och vilken marknad den handlades på. Grupperingen är det enda
// som skiljer — måtten räknas identiskt, så tabellerna kan aldrig säga emot
// varandra eller Trades-sidan.
const STATISTICS_GROUPINGS = {
  strategy: (trade) => ({
    // Manuella emergency-flatten-executions saknar strategyId i intent-loggen och
    // ska inte klumpas ihop under en påhittad strategi.
    key: trade.strategyId || NO_STRATEGY_ID,
    label: trade.strategyId ? (trade.strategyName || trade.strategyId) : NO_STRATEGY_LABEL,
    sublabel: trade.strategyFamily || null,
    strategyId: trade.strategyId || null,
    strategyFamily: trade.strategyFamily || null,
  }),
  family: (trade) => ({
    key: trade.strategyFamily || NO_FAMILY_ID,
    label: trade.strategyFamily || NO_FAMILY_LABEL,
    sublabel: null,
    strategyId: null,
    strategyFamily: trade.strategyFamily || null,
  }),
  symbol: (trade) => ({
    key: trade.symbol || NO_SYMBOL_ID,
    label: trade.symbol || NO_SYMBOL_LABEL,
    sublabel: null,
    strategyId: null,
    strategyFamily: null,
  }),
};

// All statistik härleds ur samma journalrader som Trades-sidan visar, så
// siffrorna aldrig kan säga emot tabellen ovanför.
export function buildTradeStatistics(trades = [], groupBy = 'strategy') {
  const describe = STATISTICS_GROUPINGS[groupBy] || STATISTICS_GROUPINGS.strategy;
  const byGroup = new Map();
  for (const trade of toArray(trades)) {
    const descriptor = describe(trade);
    if (!byGroup.has(descriptor.key)) {
      byGroup.set(descriptor.key, { ...descriptor, rows: [] });
    }
    byGroup.get(descriptor.key).rows.push(trade);
  }

  const stats = Array.from(byGroup.values()).map((group) => {
    const closed = group.rows
      .filter((row) => row.netPnl != null)
      .sort((a, b) => (a.exitMs ?? 0) - (b.exitMs ?? 0));
    const wins = closed.filter((row) => row.netPnl > 0);
    const losses = closed.filter((row) => row.netPnl < 0);
    const netValues = closed.map((row) => row.netPnl);
    const netPnl = netValues.reduce((total, value) => total + value, 0);
    const commission = closed.reduce((total, row) => total + (numberOrNull(row.commission) || 0), 0);
    const grossPnl = closed.reduce((total, row) => total + (numberOrNull(row.grossPnl) ?? numberOrNull(row.netPnl) ?? 0), 0);
    const winSum = wins.reduce((total, row) => total + row.netPnl, 0);
    const lossSum = losses.reduce((total, row) => total + row.netPnl, 0);

    // Sharpe per trade: medelvärde / standardavvikelse på realiserad netto-PnL.
    let sharpe = null;
    if (netValues.length > 1) {
      const mean = netPnl / netValues.length;
      const variance = netValues.reduce((total, value) => total + ((value - mean) ** 2), 0) / (netValues.length - 1);
      const stdev = Math.sqrt(variance);
      sharpe = stdev > 0 ? mean / stdev : null;
    }

    // Maximal drawdown på den realiserade equity-kurvan, i tidsordning.
    let equity = 0;
    let peak = 0;
    let drawdown = 0;
    for (const value of netValues) {
      equity += value;
      if (equity > peak) peak = equity;
      drawdown = Math.min(drawdown, equity - peak);
    }

    return {
      groupKey: group.key,
      groupLabel: group.label,
      groupSublabel: group.sublabel,
      strategyId: group.strategyId,
      // strategyName behålls som alias för groupLabel: Trades-sidan och äldre
      // anropare läser fältet vid namn.
      strategyName: group.label,
      strategyFamily: group.strategyFamily,
      trades: group.rows.length,
      openTrades: group.rows.filter((row) => row.status === TRADE_STATUS.OPEN).length,
      closedTrades: closed.length,
      unverifiedTrades: group.rows.filter((row) => row.status === TRADE_STATUS.CLOSED_UNVERIFIED).length,
      cancelledTrades: group.rows.filter((row) => row.status === TRADE_STATUS.CANCELLED || row.status === TRADE_STATUS.REJECTED).length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      expectancy: closed.length ? netPnl / closed.length : null,
      profitFactor: lossSum < 0 ? winSum / Math.abs(lossSum) : null,
      averageWin: wins.length ? winSum / wins.length : null,
      averageLoss: losses.length ? lossSum / losses.length : null,
      largestWin: wins.length ? Math.max(...wins.map((row) => row.netPnl)) : null,
      largestLoss: losses.length ? Math.min(...losses.map((row) => row.netPnl)) : null,
      sharpe,
      drawdown: closed.length ? drawdown : null,
      netPnl: closed.length ? netPnl : null,
      grossPnl: closed.length ? grossPnl : null,
      commission: closed.length ? commission : null,
    };
  });

  return stats.sort((a, b) => (b.netPnl ?? Number.NEGATIVE_INFINITY) - (a.netPnl ?? Number.NEGATIVE_INFINITY));
}

export function buildStrategyStatistics(trades = []) {
  return buildTradeStatistics(trades, 'strategy');
}

// Broker-ordersidan: ren orderrad, ingen PnL och ingen strategistatistik.
export function buildBrokerOrderRows({ brokerOrders = [], brokerOrderStatuses = [] } = {}) {
  const statusByOrderId = indexOrderStatuses(brokerOrderStatuses);
  const rows = toArray(brokerOrders).map((order) => {
    const status = order?.orderId == null ? null : statusByOrderId.get(String(order.orderId));
    return {
      key: collectIds([order?.orderId, order?.permId, order?.orderRef]).join('_') || String(order?.id ?? ''),
      time: firstValue(order?.updatedAt, status?.updatedAt),
      timeMs: msOrNull(firstValue(order?.updatedAt, status?.updatedAt)),
      orderId: firstValue(order?.orderId, order?.id),
      permId: firstValue(order?.permId, status?.permId),
      orderRef: firstValue(order?.orderRef),
      leg: legOf(order || {}),
      executionId: executionIdOf(order || {}),
      strategyId: firstValue(order?.strategyId),
      symbol: firstValue(order?.symbol, order?.localSymbol),
      localSymbol: firstValue(order?.localSymbol),
      side: firstValue(order?.action, order?.side),
      orderType: firstValue(order?.orderType),
      quantity: firstNumber(order?.quantity),
      price: firstNumber(order?.limitPrice, order?.stopPrice),
      filled: firstNumber(status?.filled),
      remaining: firstNumber(status?.remaining),
      status: firstValue(status?.status, order?.status, status?.ibStatus),
      ibStatus: firstValue(status?.ibStatus),
      source: firstValue(order?.source, order?.executionSource),
      broker: 'IBKR Paper',
      accountMasked: firstValue(order?.accountMasked),
    };
  });
  return rows.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
}

// Fills-sidan: ren execution-logg.
export function buildFillRows({ brokerFills = [] } = {}) {
  // IBKR:s execution.time är brokerns egen sträng ("20260812 09:11:46 US/Central")
  // och går inte att sortera på. receivedAt är ISO och används för tid/sortering;
  // brokertiden behålls som eget fält så inget går förlorat.
  const rows = toArray(brokerFills).map((fill) => ({
    key: firstValue(fill?.execId, fill?.id) || `${fill?.orderId ?? 'order'}_${fill?.time ?? ''}`,
    time: firstValue(fill?.receivedAt, fill?.time),
    brokerTime: firstValue(fill?.time),
    timeMs: msOrNull(firstValue(fill?.receivedAt, fill?.time)),
    execId: firstValue(fill?.execId),
    orderId: firstValue(fill?.orderId, fill?.ibOrderId),
    permId: firstValue(fill?.permId),
    orderRef: firstValue(fill?.orderRef),
    leg: legOf(fill || {}),
    executionId: executionIdOf(fill || {}),
    strategyId: firstValue(fill?.strategyId),
    symbol: firstValue(fill?.localSymbol),
    side: firstValue(fill?.side),
    quantity: firstNumber(fill?.quantity),
    fillPrice: firstNumber(fill?.fillPrice),
    commission: firstNumber(fill?.commission),
    commissionCurrency: firstValue(fill?.commissionCurrency),
    source: firstValue(fill?.source, fill?.executionSource),
  }));
  return rows.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
}
