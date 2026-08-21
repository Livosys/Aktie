'use strict';

const configService = require('./ibPaperExecutionConfigService');
const futuresContractCatalog = require('./futuresContractCatalogService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_broker_risk',
});

function buildSafety(executionTarget = 'ibkr_paper') {
  return {
    ...configService.buildExecutionSafety(executionTarget),
    source: 'ib_paper_broker_risk',
  };
}

function nowMs(now = new Date()) {
  const ms = new Date(now).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ageMsFromGeneratedAt(generatedAt, now = new Date()) {
  const parsed = Date.parse(generatedAt || '');
  const current = nowMs(now);
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function addCheck(checks, code, ok, blocker, detail = {}) {
  checks.push({
    code,
    ok: ok === true,
    blocker: ok === true ? null : blocker,
    ...detail,
  });
}

const TERMINAL_ORDER_STATUSES = Object.freeze(['cancelled', 'apicancelled', 'filled']);

// Benet står i orderRef, som vi själva skriver: TOS-{PAPER,LIVE}-<executionId>-<ben>.
// Det är den enda identifieraren som är vår egen och som inte förändras under
// orderns livstid.
const ORDER_REF_LEG_PATTERN = /-(entry|stopLoss|takeProfit|flatten)$/;

function legOfOrderRow(row = {}) {
  const ref = row.orderRef ?? row.order?.orderRef ?? null;
  const match = ORDER_REF_LEG_PATTERN.exec(String(ref || ''));
  if (match) return match[1];
  const explicit = String(row.role || row.order?.role || '').trim();
  return explicit || null;
}

function isTerminalOrderRow(row = {}) {
  const status = String(row.status || row.state || row.orderStatus || '').toLowerCase();
  return TERMINAL_ORDER_STATUSES.includes(status);
}

// Räknar VÄNTANDE ENTRY-ORDER. Tidigare identifierades entry-ordern på
// `role` plus `parentId === 0`. `role` sätts aldrig på broker-rader — varken
// adaptern eller reconciliation skriver fältet — så parentId var i praktiken
// enda kriteriet, och parentId ägs av IB och ändras under orderns livstid:
// skyddsbenen får förälderns orderId vid inläggning men rapporteras med
// parentId 0 när föräldern inte längre finns i orderboken. Samma bracket-par
// räknades därför som 0 väntande entries dagen det lades och som 2 två dagar
// senare. orderRef-benet är vårt eget och ligger stilla hela vägen.
function countPendingEntries(openOrders = []) {
  return openOrders.filter((row) => {
    if (isTerminalOrderRow(row)) return false;
    const leg = legOfOrderRow(row);
    // Okänt ben = order vi inte lagt själva. Fail closed: den räknas som en
    // väntande entry och stryper nya entries hellre än att släppa igenom dem.
    if (leg == null) return true;
    return leg === 'entry';
  }).length;
}

// Räknar ÖPPEN EXPONERING i kontrakt, inte antal positionsrader. En rad från
// IB:s reqPositions aggregerar hela nettopositionen per kontrakt (.position är
// signerad kvantitet), så radräkning gjorde taket verkningslöst: med taket > 1
// kunde varje ny entry lägga ännu ett kontrakt på en BEFINTLIG rad utan att
// radantalet steg, och exponeringen växte obehindrat.
function getPositionCount(positions = []) {
  return positions.reduce((total, row) => {
    const qty = Number(row.position ?? row.signedQuantity ?? row.quantity ?? row.size ?? 0);
    return Number.isFinite(qty) ? total + Math.abs(qty) : total;
  }, 0);
}

function rootOfRow(row = {}) {
  const raw = row.root || row.symbol || row.localSymbol || row.futuresSymbol || row.contract?.symbol || '';
  const match = String(raw).toUpperCase().match(/\b(MNQ|MES)\b/);
  return match ? match[1] : String(raw).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
}

function hasOpenRoot(positions = [], root) {
  return positions.some((row) => {
    const qty = Number(row.position ?? row.signedQuantity ?? row.quantity ?? row.size ?? 0);
    return Number.isFinite(qty) && Math.abs(qty) > 0 && rootOfRow(row) === root;
  });
}

function hasPendingEntryRoot(openOrders = [], root) {
  return openOrders.some((row) => !isTerminalOrderRow(row) && legOfOrderRow(row) === 'entry' && rootOfRow(row) === root);
}

function spreadTicks(quote, tickSize) {
  const bid = numberOrNull(quote?.bid);
  const ask = numberOrNull(quote?.ask);
  const spread = numberOrNull(quote?.spread ?? ((bid != null && ask != null) ? ask - bid : null));
  if (spread == null || !tickSize) return null;
  return spread / tickSize;
}

// ── två sorters kontroller ───────────────────────────────────────────────────
//
// Riskmotorn prövar två saker som råkar bo i samma lista:
//
//   1. Är ORDERN tillåten?      symbol, kvantitet, ordertyp, positionstak,
//                               stop loss, dagsförlust. Gäller överallt.
//   2. Är BROKERN frisk just nu? realtidsquote, bid/ask, kontosammanfattningens
//                               ålder, avstämning. Gäller bara mot en levande
//                               anslutning.
//
// Skillnaden syntes aldrig förrän Replay skulle köra samma motor. Mot en fil
// kan grupp 2 aldrig passera — historiken innehåller barer, inte quotes, så
// bid och ask är null och källan är derived_from_candle. Frestelsen är att ge
// Replay en egen, mildare riskmotor. Det vore två riskregelverk, och det ena
// skulle sluta likna det andra.
//
// I stället NAMNGES grupp 2 här. Motorn räknar precis som förut och `allowed`
// betyder precis samma sak som förut — paper och live är oförändrade. Replay
// kör samma anrop och redovisar båda grupperna var för sig, så att det syns i
// rapporten exakt vilka kontroller som inte gick att pröva.
const BROKER_CONNECTIVITY_CHECKS = Object.freeze([
  'quote_realtime',
  'quote_not_stale_flagged',
  'quote_has_timestamp',
  'quote_fresh',
  'quote_bid_numeric',
  'quote_ask_numeric',
  'quote_ask_gte_bid',
  'spread_numeric',
  'spread_ticks_numeric',
  'account_summary_present',
  'account_summary_has_timestamp',
  'account_summary_fresh',
  'reconciliation_ok',
]);

const CONNECTIVITY_CHECK_SET = new Set(BROKER_CONNECTIVITY_CHECKS);

/**
 * Delar ett riskutfall i orderrisk och brokeranslutning.
 *
 * `allowed` i utfallet är och förblir konjunktionen av BÅDA. Den här funktionen
 * tolkar bara resultatet — den mildrar ingenting.
 */
function partitionBlockers(result = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const failed = checks.filter((check) => check.ok !== true);
  const orderRisk = failed.filter((check) => !CONNECTIVITY_CHECK_SET.has(check.code));
  const connectivity = failed.filter((check) => CONNECTIVITY_CHECK_SET.has(check.code));
  return {
    orderRiskBlockers: orderRisk.map((check) => check.blocker || check.code),
    orderRiskChecks: orderRisk,
    connectivityBlockers: connectivity.map((check) => check.blocker || check.code),
    connectivityChecks: connectivity,
    // Sant när ordern hade släppts igenom om brokeranslutningen vore frisk.
    orderRiskAllowed: orderRisk.length === 0,
  };
}

function evaluateBrokerRisk({
  executionTarget = null,
  root,
  quantity,
  orderType,
  stopLossPrice,
  quote,
  openOrders = [],
  positions = [],
  accountSummary = null,
  reconciliation = null,
  now = new Date(),
} = {}) {
  const target = configService.normalizeExecutionTarget(executionTarget);
  const targetSafety = buildSafety(target);
  const limits = configService.getPilotLimits({ executionTarget: target });
  const checks = [];
  const normalizedRoot = String(root || '').trim().toUpperCase();
  const qty = Number(quantity);
  const type = String(orderType || '').trim().toUpperCase();
	  const catalog = futuresContractCatalog.getContract(normalizedRoot);
	  const tickSize = catalog?.tickSize || quote?.tickSize || 0.25;
	  const quoteAgeMs = quote?.updatedAt ? Math.max(0, nowMs(now) - new Date(quote.updatedAt).getTime()) : null;
	  const bid = numberOrNull(quote?.bid);
	  const ask = numberOrNull(quote?.ask);
	  const spread = numberOrNull(quote?.spread ?? ((bid != null && ask != null) ? ask - bid : null));
	  const price = numberOrNull(quote?.last ?? quote?.price ?? quote?.close ?? ((bid != null && ask != null) ? (bid + ask) / 2 : null));
	  const contractNotionalUsd = price != null && catalog ? price * catalog.pointValueUsd * qty : null;
	  const stop = numberOrNull(stopLossPrice);
	  const stopRiskUsd = price != null && stop != null && catalog ? Math.abs(price - stop) * catalog.pointValueUsd * qty : null;
	  const accountAgeMs = numberOrNull(accountSummary?.cacheAgeMs ?? accountSummary?.ageMs)
	    ?? ageMsFromGeneratedAt(accountSummary?.generatedAt, now);
	  const realizedPnl = numberOrNull(accountSummary?.account?.realizedPnl ?? accountSummary?.realizedPnl);
  const expectedAccountClassification = target === 'ibkr_live' ? 'live_or_unknown' : 'paper';
  const accountSummaryBlocker = target === 'ibkr_live' ? 'live_account_summary_missing' : 'paper_account_summary_missing';
  const openPositionCount = getPositionCount(positions);
  const pendingEntries = countPendingEntries(openOrders);
  const paperTarget = target === configService.EXECUTION_TARGETS?.PAPER || target === 'ibkr_paper';

  addCheck(checks, 'symbol_allowlisted', limits.symbolAllowlist.includes(normalizedRoot), 'symbol_not_allowlisted', { root: normalizedRoot, allowlist: limits.symbolAllowlist });
	  addCheck(checks, 'quantity_exactly_one_micro', Number.isInteger(quantity) && qty === 1 && qty === limits.maxQuantity, 'quantity_must_be_exactly_one', { quantity, parsedQuantity: qty, maxQuantity: limits.maxQuantity });
	  addCheck(checks, 'order_type_allowed', limits.allowedOrderTypes.includes(type), 'order_type_not_allowed', { orderType: type, allowedOrderTypes: limits.allowedOrderTypes });
  addCheck(checks, paperTarget ? 'max_open_paper_positions' : 'max_one_open_broker_position', openPositionCount < limits.maxOpenPositions, 'max_open_broker_positions', { openPositionCount, maxOpenPositions: limits.maxOpenPositions });
  addCheck(checks, paperTarget ? 'max_pending_paper_entries' : 'max_one_pending_entry', pendingEntries < limits.maxPendingEntryOrders, 'max_pending_entry_orders', { pendingEntries, maxPendingEntryOrders: limits.maxPendingEntryOrders });
  // ── En position per rot: borttagen 2026-08-20 ─────────────────────────────
  //
  // Grinden tillät aldrig två affärer i samma instrument. Tillsammans med ett
  // tak som satt i allowlistens längd betydde det högst en MNQ och en MES — och
  // i praktiken oftast bara en, eftersom båda rötterna sällan signalerar
  // samtidigt. Mätt 2026-08-19/20 avvisades 2 078 av 2 098 kandidater på
  // positionstaket.
  //
  // Det den skyddade mot var att exponeringen växte obemärkt i ett instrument.
  // Det skyddet ligger nu där det hör hemma: getPositionCount summerar
  // |kvantitet| över alla rader, så taket räknar KONTRAKT och inte
  // positionsrader. Fyra kontrakt är fyra kontrakt oavsett hur de fördelar sig
  // mellan MNQ och MES, och det är den storhet risken faktiskt bor i.
  //
  // hasOpenRoot och hasPendingEntryRoot står kvar som funktioner: de används av
  // rapportlagret för att visa exponering per rot, vilket fortfarande är en
  // rimlig fråga att ställa — den styr bara inte längre om en order får läggas.
  addCheck(checks, 'stop_loss_required', stopLossPrice != null && Number.isFinite(Number(stopLossPrice)), 'stop_loss_required', { stopLossPrice: stopLossPrice ?? null });
	  addCheck(checks, 'quote_present', Boolean(quote), 'current_quote_missing');
	  addCheck(checks, 'quote_realtime', quote?.source === 'ibkr_realtime' && quote?.simulated !== true && quote?.delayed !== true, 'quote_not_realtime_ibkr', {
	    source: quote?.source || null,
	    simulated: quote?.simulated === true,
	    delayed: quote?.delayed === true,
	  });
	  addCheck(checks, 'quote_not_stale_flagged', quote?.stale !== true, 'stale_quote', { stale: quote?.stale === true });
	  addCheck(checks, 'quote_has_timestamp', Boolean(quote?.updatedAt), 'quote_timestamp_missing', { updatedAt: quote?.updatedAt || null });
	  addCheck(checks, 'quote_fresh', quoteAgeMs != null && quoteAgeMs <= limits.maxQuoteAgeMs, 'stale_quote', { quoteAgeMs, maxQuoteAgeMs: limits.maxQuoteAgeMs });
	  const spreadInTicks = spreadTicks(quote, tickSize);
	  addCheck(checks, 'quote_bid_numeric', bid != null, 'quote_bid_missing', { bid: quote?.bid ?? null });
	  addCheck(checks, 'quote_ask_numeric', ask != null, 'quote_ask_missing', { ask: quote?.ask ?? null });
	  addCheck(checks, 'quote_ask_gte_bid', bid != null && ask != null && ask >= bid, 'quote_crossed_or_invalid', { bid, ask });
	  addCheck(checks, 'spread_numeric', spread != null && spread >= 0, 'spread_unknown', { spread });
	  addCheck(checks, 'spread_ticks_numeric', spreadInTicks != null && Number.isFinite(spreadInTicks), 'spread_ticks_unknown', { spreadTicks: spreadInTicks });
	  addCheck(checks, 'account_summary_present', accountSummary?.ok === true && accountSummary?.account?.classification === expectedAccountClassification && Boolean(accountSummary?.account?.accountIdMasked), accountSummaryBlocker, { accountIdMasked: accountSummary?.account?.accountIdMasked || null, classification: accountSummary?.account?.classification || null, expectedClassification: expectedAccountClassification });
	  addCheck(checks, 'account_summary_has_timestamp', Boolean(accountSummary?.generatedAt), 'account_summary_timestamp_missing', { generatedAt: accountSummary?.generatedAt || null });
	  addCheck(checks, 'account_summary_fresh', accountAgeMs != null && accountAgeMs <= limits.maxAccountSummaryAgeMs, 'account_summary_stale', { accountAgeMs, maxAccountSummaryAgeMs: limits.maxAccountSummaryAgeMs });
	  addCheck(checks, 'daily_loss_within_limit', realizedPnl == null || realizedPnl > -Math.abs(limits.maxDailyLossSek), 'daily_paper_loss_limit', { realizedPnl, maxDailyLossSek: limits.maxDailyLossSek });
  addCheck(checks, 'reconciliation_ok', reconciliation?.degraded !== true, 'reconciliation_degraded', { reconciliationStatus: reconciliation?.status || null });

  const blockers = checks.filter((check) => check.ok !== true).map((check) => check.blocker || check.code);
  return {
    ok: true,
    allowed: blockers.length === 0,
    blockers,
    blockedReason: blockers[0] || null,
    checks,
    limits,
	    exposureUsd: contractNotionalUsd,
	    contractNotionalUsd,
	    stopRiskUsd,
	    spreadTicks: spreadInTicks,
    quoteAgeMs,
    ...targetSafety,
  };
}

module.exports = {
  SAFETY,
  BROKER_CONNECTIVITY_CHECKS,
  evaluateBrokerRisk,
  partitionBlockers,
  _internal: { countPendingEntries, getPositionCount, legOfOrderRow, rootOfRow, hasOpenRoot, hasPendingEntryRoot },
};
