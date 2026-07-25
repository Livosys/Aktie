import {
  EMPTY_VALUE,
  hasValue,
  signedTone,
  textOrEmpty,
} from '../utils/tradingFormatters.js';
import {
  UNAVAILABLE,
  moneyField,
  moneyValue,
  numberField,
  rawField,
} from './DomainUtils.js';

export function getPortfolioPnL(account = {}, portfolio = {}) {
  return {
    dailyPnl: account.dailyPnl ?? portfolio.dailyPnl ?? null,
    unrealizedPnl: account.unrealizedPnl ?? portfolio.unrealizedPnl ?? null,
    realizedPnl: account.realizedPnl ?? portfolio.realizedPnl ?? null,
    portfolioPnl: portfolio.portfolioPnl ?? null,
  };
}

export function getOpenExposure(portfolio = {}) {
  return portfolio.openExposure ?? null;
}

export function getOpenRisk(portfolio = {}) {
  return portfolio.openRisk ?? null;
}

export function getAccountSummary({
  account = {},
  portfolio = {},
  reconciliation = {},
  currency = null,
  waiting = false,
} = {}) {
  const source = { account, portfolio, reconciliation };
  const topMetrics = [
    {
      label: 'Account',
      value: textOrEmpty(account.accountIdMasked || account.account || account.id),
      hint: account.unavailableReason || account.source || EMPTY_VALUE,
      tone: hasValue(account.accountIdMasked || account.account || account.id) ? 'success' : 'warning',
    },
    {
      label: 'Net Liquidation',
      value: moneyValue(account.netLiquidation, currency, waiting),
      hint: 'account.netLiquidation',
      tone: hasValue(account.netLiquidation) ? 'info' : 'warning',
    },
    {
      label: 'Available Funds',
      value: moneyValue(account.availableFunds, currency, waiting),
      hint: 'account.availableFunds',
      tone: hasValue(account.availableFunds) ? 'neutral' : 'warning',
    },
    {
      label: 'Buying Power',
      value: moneyValue(account.buyingPower, currency, waiting),
      hint: 'account.buyingPower',
      tone: hasValue(account.buyingPower) ? 'neutral' : 'warning',
    },
    {
      label: 'Unrealized PnL',
      value: moneyValue(account.unrealizedPnl, currency, waiting),
      hint: 'account.unrealizedPnl',
      tone: signedTone(account.unrealizedPnl),
    },
    {
      label: 'Realized PnL',
      value: moneyValue(account.realizedPnl, currency, waiting),
      hint: 'account.realizedPnl',
      tone: signedTone(account.realizedPnl),
    },
    {
      label: 'Daily PnL',
      value: moneyValue(account.dailyPnl, currency, waiting),
      hint: 'account.dailyPnl',
      tone: signedTone(account.dailyPnl),
    },
  ];

  const groups = [
    {
      title: 'Capital',
      rows: [
        moneyField('Net liquidation', source, 'account.netLiquidation', currency, waiting, 'info'),
        moneyField('Total cash', source, 'account.totalCashValue', currency, waiting, 'neutral'),
        moneyField('Available funds', source, 'account.availableFunds', currency, waiting, 'neutral'),
        moneyField('Buying power', source, 'account.buyingPower', currency, waiting, 'neutral'),
        rawField('Currency', source, ['account.currency'], EMPTY_VALUE),
      ],
    },
    {
      title: 'PnL',
      rows: [
        moneyField('Daily PnL', source, 'account.dailyPnl', currency, waiting),
        moneyField('Unrealized PnL', source, 'account.unrealizedPnl', currency, waiting),
        moneyField('Realized PnL', source, 'account.realizedPnl', currency, waiting),
        moneyField('Portfolio PnL', source, 'portfolio.portfolioPnl', currency, waiting),
      ],
    },
    {
      title: 'Margin',
      rows: [
        moneyField('Init margin', source, 'account.initMarginReq', currency, waiting, 'neutral'),
        moneyField('Full init margin', source, 'account.fullInitMarginReq', currency, waiting, 'neutral'),
        moneyField('Maint margin', source, 'account.maintMarginReq', currency, waiting, 'neutral'),
        moneyField('Full maint margin', source, 'account.fullMaintMarginReq', currency, waiting, 'neutral'),
        moneyField('Excess liquidity', source, 'account.excessLiquidity', currency, waiting, 'neutral'),
        numberField('Cushion', source, 'account.cushion', waiting, 'neutral'),
      ],
    },
    {
      title: 'Allocation & Exposure',
      rows: [
        rawField('Capital allocation', source, ['portfolio.capitalAllocation', 'account.capitalAllocation'], UNAVAILABLE),
        rawField('Strategy allocation', source, ['portfolio.strategyAllocation', 'account.strategyAllocation'], UNAVAILABLE),
        moneyField('Open risk', source, 'portfolio.openRisk', currency, waiting, 'neutral'),
        moneyField('Open exposure', source, 'portfolio.openExposure', currency, waiting, 'neutral'),
        rawField('Correlation', source, ['portfolio.correlation', 'account.correlation'], UNAVAILABLE),
        rawField('Sector exposure', source, ['portfolio.sectorExposure', 'account.sectorExposure'], UNAVAILABLE),
      ],
    },
    {
      title: 'Broker Reconciliation',
      rows: [
        rawField('Status', source, ['reconciliation.status'], EMPTY_VALUE),
        rawField('Blocked reason', source, ['reconciliation.blockedReason'], EMPTY_VALUE),
        rawField('New entries allowed', source, ['reconciliation.newEntriesAllowed'], EMPTY_VALUE),
        rawField('Counts', source, ['reconciliation.counts'], EMPTY_VALUE),
      ],
    },
  ];

  return { topMetrics, groups, pnl: getPortfolioPnL(account, portfolio) };
}

export function getPortfolioHealth({ account = {}, portfolio = {}, reconciliation = {} } = {}) {
  return {
    accountAvailable: hasValue(account.accountIdMasked || account.account || account.id),
    degraded: account.degraded === true || reconciliation.degraded === true,
    stale: account.stale === true || portfolio.stale === true,
    reconciliationStatus: reconciliation.status || null,
    blockedReason: reconciliation.blockedReason || null,
  };
}
