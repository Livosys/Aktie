import { hasValue } from '../utils/tradingFormatters.js';
import { boolText } from '../utils/tradingFormatters.js';
import { firstValue } from '../models/strategyViewModel.js';
import { statusTone } from './StrategyDomain.js';

export function marketState(market = {}, strategyOverviewMeta = {}) {
  const open = market.isMarketOpen ?? market.isOpen ?? strategyOverviewMeta.marketOpen ?? null;
  return {
    session: firstValue(market.sessionLabel, market.session, strategyOverviewMeta.currentSession),
    sessionId: firstValue(market.sessionId, strategyOverviewMeta.currentSessionId),
    isOpen: open,
    label: boolText(open),
    tone: open === true ? 'success' : (open === false ? 'warning' : 'neutral'),
  };
}

export function sessionState(nextSessionTransition = {}) {
  return {
    at: firstValue(nextSessionTransition.at, nextSessionTransition.timestamp, nextSessionTransition.nextTransitionAt),
    toSession: firstValue(nextSessionTransition.toSession, nextSessionTransition.sessionLabel, nextSessionTransition.type),
  };
}

export function quoteAvailability(quotes = []) {
  const rows = Array.isArray(quotes) ? quotes : [];
  return {
    available: Array.isArray(quotes),
    count: rows.length,
    staleCount: rows.filter((quote) => quote?.stale === true).length,
    degradedCount: rows.filter((quote) => quote?.fallback === true || quote?.simulated === true).length,
  };
}

export function dataFeedHealth(dataFeed = {}, ibDataLayer = {}) {
  const connected = ibDataLayer.connected ?? dataFeed.connected ?? null;
  return {
    connected,
    source: firstValue(ibDataLayer.source, dataFeed.source),
    provider: dataFeed.provider || null,
    delayed: dataFeed.delayed === true,
    tone: connected === true ? 'success' : (connected === false ? 'warning' : statusTone(dataFeed.status)),
  };
}

export function marketSummary({
  market = {},
  dataFeed = {},
  ibDataLayer = {},
  quotes = [],
  strategyOverviewMeta = {},
  nextSessionTransition = {},
} = {}) {
  return {
    market: marketState(market, strategyOverviewMeta),
    session: sessionState(nextSessionTransition),
    quotes: quoteAvailability(quotes),
    feed: dataFeedHealth(dataFeed, ibDataLayer),
    hasMarketData: hasValue(dataFeed.source) || Array.isArray(quotes),
  };
}
