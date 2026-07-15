'use strict';

const configService = require('./ibPaperExecutionConfigService');
const futuresContractCatalog = require('./futuresContractCatalogService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_broker_risk',
});

function nowMs(now = new Date()) {
  const ms = new Date(now).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addCheck(checks, code, ok, blocker, detail = {}) {
  checks.push({
    code,
    ok: ok === true,
    blocker: ok === true ? null : blocker,
    ...detail,
  });
}

function countPendingEntries(openOrders = []) {
  return openOrders.filter((row) => {
    const role = String(row.role || row.order?.role || '').toLowerCase();
    const parentId = row.parentId ?? row.order?.parentId ?? null;
    const status = String(row.status || row.state || row.orderStatus || '').toLowerCase();
    const isCancelled = ['cancelled', 'apicancelled', 'filled'].includes(status);
    return !isCancelled && (!role || role === 'entry') && (parentId == null || Number(parentId) === 0);
  }).length;
}

function getPositionCount(positions = []) {
  return positions.filter((row) => Number(row.position ?? row.quantity ?? row.size ?? 0) !== 0).length;
}

function spreadTicks(quote, tickSize) {
  const bid = numberOrNull(quote?.bid);
  const ask = numberOrNull(quote?.ask);
  const spread = numberOrNull(quote?.spread ?? ((bid != null && ask != null) ? ask - bid : null));
  if (spread == null || !tickSize) return null;
  return spread / tickSize;
}

function evaluateBrokerRisk({
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
  const limits = configService.getPilotLimits();
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
	  const accountAgeMs = numberOrNull(accountSummary?.cacheAgeMs ?? accountSummary?.ageMs);
	  const realizedPnl = numberOrNull(accountSummary?.account?.realizedPnl ?? accountSummary?.realizedPnl);
  const openPositionCount = getPositionCount(positions);
  const pendingEntries = countPendingEntries(openOrders);

  addCheck(checks, 'symbol_allowlisted', limits.symbolAllowlist.includes(normalizedRoot), 'symbol_not_allowlisted', { root: normalizedRoot, allowlist: limits.symbolAllowlist });
	  addCheck(checks, 'quantity_exactly_one_micro', Number.isInteger(quantity) && qty === 1 && qty === limits.maxQuantity, 'quantity_must_be_exactly_one', { quantity, parsedQuantity: qty, maxQuantity: limits.maxQuantity });
	  addCheck(checks, 'order_type_allowed', limits.allowedOrderTypes.includes(type), 'order_type_not_allowed', { orderType: type, allowedOrderTypes: limits.allowedOrderTypes });
  addCheck(checks, 'max_one_open_broker_position', openPositionCount < limits.maxOpenPositions, 'max_open_broker_positions', { openPositionCount, maxOpenPositions: limits.maxOpenPositions });
  addCheck(checks, 'max_one_pending_entry', pendingEntries < limits.maxPendingEntryOrders, 'max_pending_entry_orders', { pendingEntries, maxPendingEntryOrders: limits.maxPendingEntryOrders });
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
	  addCheck(checks, 'spread_within_limit', spreadInTicks != null && spreadInTicks <= limits.maxSpreadTicks, 'spread_too_wide', { spreadTicks: spreadInTicks, maxSpreadTicks: limits.maxSpreadTicks });
	  addCheck(checks, 'stop_risk_within_limit', stopRiskUsd != null && stopRiskUsd <= limits.maxStopRiskUsd, 'stop_risk_too_large', { stopRiskUsd, maxStopRiskUsd: limits.maxStopRiskUsd });
	  addCheck(checks, 'contract_notional_sanity_limit', contractNotionalUsd != null && contractNotionalUsd <= limits.maxContractNotionalUsd, 'contract_notional_too_large', { contractNotionalUsd, maxContractNotionalUsd: limits.maxContractNotionalUsd });
	  addCheck(checks, 'account_summary_present', accountSummary?.ok === true && accountSummary?.account?.classification === 'paper' && Boolean(accountSummary?.account?.accountIdMasked), 'paper_account_summary_missing', { accountIdMasked: accountSummary?.account?.accountIdMasked || null });
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
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  evaluateBrokerRisk,
};
