import React, { useMemo } from 'react';
import { EMPTY_STRATEGY_STORE, strategyDisplayName, strategyModelKey } from '../../stores/strategyStore.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { getEventSummary } from '../../domain/EventDomain.js';
import {
  EMPTY_VALUE,
  fmtNumber,
  fmtPercent,
  fmtTime,
  hasValue,
  numberOrNull,
  signedTone,
} from '../../utils/tradingFormatters.js';
import { MetricCard } from './MetricCard.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import {
  UNAVAILABLE,
  WAITING_RUNTIME,
  compactJsonValue,
  firstPathValue,
  valueText,
} from './intelligenceUtils.js';

const METRICS = [
  { key: 'winRate', label: 'Win Rate', format: (value) => fmtPercent(value, 1), tone: 'info' },
  { key: 'profitFactor', label: 'Profit Factor', format: (value) => fmtNumber(value, 2), tone: 'info' },
  { key: 'tradesTotal', label: 'Total Trades', format: (value) => fmtNumber(value), tone: 'neutral' },
  { key: 'tradesToday', label: 'Trades Today', format: (value) => fmtNumber(value), tone: 'neutral' },
  { key: 'pnlToday', label: 'PnL Today', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'pnlWeek', label: 'PnL Week', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'avgPnl', label: 'Avg PnL', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'expectancy', label: 'Expectancy', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'netPnl', label: 'Net PnL', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'grossPnl', label: 'Gross PnL', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'commission', label: 'Commission', format: (value) => fmtNumber(value, 2), tone: 'neutral' },
  { key: 'largestWin', label: 'Largest Win', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'largestLoss', label: 'Largest Loss', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'drawdown', label: 'Drawdown', format: (value) => fmtNumber(value, 2), tone: signedTone },
  { key: 'score', label: 'Score', format: (value) => fmtNumber(value, 2), tone: 'info' },
];

const SERIES_PATHS = [
  { key: 'equityCurve', label: 'Equity Curve', paths: ['equityCurve', 'analytics.equityCurve', 'performance.equityCurve'] },
  { key: 'winRate', label: 'Win Rate', paths: ['winRateSeries', 'analytics.winRateSeries', 'performance.winRateSeries'] },
  { key: 'profitFactor', label: 'Profit Factor', paths: ['profitFactorSeries', 'analytics.profitFactorSeries', 'performance.profitFactorSeries'] },
  { key: 'drawdown', label: 'Drawdown', paths: ['drawdownSeries', 'analytics.drawdownSeries', 'performance.drawdownSeries'] },
  { key: 'expectancy', label: 'Expectancy', paths: ['expectancySeries', 'analytics.expectancySeries', 'performance.expectancySeries'] },
  { key: 'dailyPnl', label: 'Daily PnL', paths: ['dailyPnl', 'dailyPnlSeries', 'portfolio.dailyPnl', 'analytics.dailyPnl', 'analytics.dailyPnlSeries'] },
  { key: 'portfolioPnl', label: 'Portfolio PnL', paths: ['portfolioPnl', 'portfolio.portfolioPnl', 'performance.portfolioPnl'] },
  { key: 'realizedPnl', label: 'Realized PnL', paths: ['realizedPnl', 'portfolio.realizedPnl', 'performance.realizedPnl'] },
  { key: 'unrealizedPnl', label: 'Unrealized PnL', paths: ['unrealizedPnl', 'portfolio.unrealizedPnl', 'performance.unrealizedPnl'] },
  { key: 'weeklyPnl', label: 'Weekly PnL', paths: ['weeklyPnl', 'weeklyPnlSeries', 'analytics.weeklyPnl', 'analytics.weeklyPnlSeries'] },
  { key: 'monthlyPnl', label: 'Monthly PnL', paths: ['monthlyPnl', 'monthlyPnlSeries', 'analytics.monthlyPnl', 'analytics.monthlyPnlSeries'] },
];

function metricValue(strategy, key) {
  return strategy?.performance?.[key];
}

function metricRows(strategies, metric) {
  return strategies
    .map((strategy) => ({
      strategy,
      value: metricValue(strategy, metric.key),
    }))
    .filter((row) => hasValue(row.value));
}

function barWidth(value, max) {
  const n = numberOrNull(value);
  if (n == null || !max) return 0;
  const magnitude = Math.abs(n);
  return Math.max(3, Math.min(100, (magnitude / max) * 100));
}

function ComparisonRows({ metric, rows }) {
  const max = rows.reduce((value, row) => {
    const n = numberOrNull(row.value);
    return n == null ? value : Math.max(value, Math.abs(n));
  }, 0);
  if (!rows.length) {
    return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{UNAVAILABLE}</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {rows.map((row) => {
        const tone = typeof metric.tone === 'function' ? metric.tone(row.value) : metric.tone;
        const width = barWidth(row.value, max);
        return (
          <div key={`${strategyModelKey(row.strategy)}-${metric.key}`} style={{ display: 'grid', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <strong style={{ overflowWrap: 'anywhere' }}>{strategyDisplayName(row.strategy, EMPTY_VALUE)}</strong>
              <span>{metric.format(row.value)}</span>
            </div>
            <div style={{ height: 7, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${width}%`,
                  background: tone === 'danger'
                    ? 'var(--danger)'
                    : tone === 'success'
                      ? 'var(--success)'
                      : 'var(--accent)',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function seriesRows(analytics = {}) {
  return SERIES_PATHS.map((series) => {
    const { value, path } = firstPathValue(analytics, series.paths);
    return {
      ...series,
      value,
      path,
      available: Array.isArray(value) ? value.length > 0 : hasValue(value),
    };
  });
}

function SeriesPreview({ series }) {
  if (!series.available) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{UNAVAILABLE}</div>;
  if (!Array.isArray(series.value)) {
    return <div style={{ fontSize: 13, fontWeight: 800, overflowWrap: 'anywhere' }}>{compactJsonValue(series.value)}</div>;
  }
  const rows = series.value.slice(-6);
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {rows.map((row) => {
        const value = row?.value ?? row?.pnl ?? row?.equity ?? row?.winRate ?? row?.profitFactor ?? row;
        const label = row?.date || row?.day || row?.week || row?.month || row?.timestamp || row?.createdAt || row?.id || EMPTY_VALUE;
        const formattedTime = typeof label === 'string' ? fmtTime(label) : EMPTY_VALUE;
        const rowKey = row?.id || row?.timestamp || row?.createdAt || row?.date || `${series.key}-${valueText(label)}-${valueText(value)}`;
        return (
          <div key={rowKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 7 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>
              {formattedTime !== EMPTY_VALUE ? formattedTime : valueText(label)}
            </span>
            <strong style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{valueText(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

export const TradingAnalyticsPanel = React.memo(function TradingAnalyticsPanel({
  strategyStore = EMPTY_STRATEGY_STORE,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  analytics = {},
  waiting = false,
}) {
  const strategies = useMemo(() => strategyStore.getAllStrategies(), [strategyStore]);
  const eventSummary = useMemo(() => getEventSummary(eventStore.getAllEvents()), [eventStore]);
  const decisionCount = useMemo(() => decisionStore.getDecisions().length, [decisionStore]);
  const metricPanels = useMemo(() => METRICS.map((metric) => ({
    ...metric,
    rows: metricRows(strategies, metric),
  })), [strategies]);
  const exposedPerformanceCount = useMemo(() => (
    strategies.filter((strategy) => METRICS.some((metric) => hasValue(metricValue(strategy, metric.key)))).length
  ), [strategies]);
  const seriesPanels = useMemo(() => seriesRows(analytics), [analytics]);
  const hasAnalyticsSnapshot = useMemo(() => (
    Boolean(analytics && typeof analytics === 'object' && Object.keys(analytics).length)
  ), [analytics]);
  const availableSeriesCount = useMemo(() => (
    seriesPanels.filter((series) => series.available).length
  ), [seriesPanels]);

  return (
    <section style={{ display: 'grid', gap: 14 }} data-trading-event-count={eventSummary.total} data-decision-count={decisionCount}>
      <OverviewPanel
        eyebrow="Charts & Analytics"
        title="Strategy Analytics"
        summary="Visualizes backend-exposed strategy performance and analytics series only."
      >
        {waiting && !strategies.length ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            {WAITING_RUNTIME}
          </div>
        ) : null}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
        }}>
          <MetricCard
            label="Strategies"
            value={strategies.length ? fmtNumber(strategies.length) : (waiting ? WAITING_RUNTIME : EMPTY_VALUE)}
            hint="Strategy Store"
            tone={strategies.length ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Performance Rows"
            value={strategies.length ? fmtNumber(exposedPerformanceCount) : (waiting ? WAITING_RUNTIME : UNAVAILABLE)}
            hint="StrategyViewModel.performance"
            tone={exposedPerformanceCount ? 'success' : 'neutral'}
          />
          <MetricCard
            label="Analytics Series"
            value={hasAnalyticsSnapshot ? fmtNumber(availableSeriesCount) : UNAVAILABLE}
            hint="Existing runtime analytics fields"
            tone={availableSeriesCount ? 'info' : 'neutral'}
          />
        </div>
      </OverviewPanel>

      <OverviewPanel
        eyebrow="Strategy Comparison"
        title="Backend Performance Fields"
        summary="Each bar represents a value already present in StrategyViewModel.performance."
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: 12,
        }}>
          {metricPanels.map((metric) => (
            <div
              key={metric.key}
              style={{
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                borderRadius: 8,
                padding: 12,
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                <strong style={{ fontSize: 13 }}>{metric.label}</strong>
                <StatusBadge tone={metric.rows.length ? 'info' : 'neutral'} compact>
                  {strategies.length ? `${fmtNumber(metric.rows.length)} exposed` : UNAVAILABLE}
                </StatusBadge>
              </div>
              <ComparisonRows metric={metric} rows={metric.rows} />
            </div>
          ))}
        </div>
      </OverviewPanel>

      <OverviewPanel
        eyebrow="Backend Series"
        title="Available Chart Inputs"
        summary="Series are shown only when the existing snapshot already exposes them."
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 12,
        }}>
          {seriesPanels.map((series) => (
            <div
              key={series.key}
              style={{
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{series.label}</strong>
                <StatusBadge tone={series.available ? 'success' : 'neutral'} compact>
                  {series.available ? 'Available' : UNAVAILABLE}
                </StatusBadge>
              </div>
              {series.path ? (
                <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 8, overflowWrap: 'anywhere' }}>
                  {series.path}
                </div>
              ) : null}
              <SeriesPreview series={series} />
            </div>
          ))}
        </div>
      </OverviewPanel>
    </section>
  );
});
