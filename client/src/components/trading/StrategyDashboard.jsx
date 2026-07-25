import React, { useMemo, useState } from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtNumber,
} from '../../utils/tradingFormatters.js';
import { EMPTY_STRATEGY_STORE } from '../../stores/strategyStore.js';
import {
  EMPTY_STRATEGY_FILTERS,
  filterStrategies,
  getStrategyFilterOptions,
  getStrategySummaryCards,
} from '../../domain/StrategyDomain.js';
import { getEventSummary } from '../../domain/EventDomain.js';
import { MetricCard } from './MetricCard.jsx';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';
import { StrategyDrawer } from './StrategyDrawer.jsx';
import { StrategyFilters } from './StrategyFilters.jsx';
import { StrategyGrid } from './StrategyGrid.jsx';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';

export const StrategyDashboard = React.memo(function StrategyDashboard({
  strategyStore = EMPTY_STRATEGY_STORE,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  waiting = false,
  title = 'Strategy Dashboard',
  summary = 'Central operating console for strategy runtime state, signal context, risk, approval and performance.',
}) {
  const [filters, setFilters] = useState(EMPTY_STRATEGY_FILTERS);
  const [selectedStrategyId, setSelectedStrategyId] = useState(null);
  const strategies = useMemo(() => strategyStore.getAllStrategies(), [strategyStore]);
  const cards = useMemo(() => getStrategySummaryCards(strategies), [strategies]);
  const options = useMemo(() => getStrategyFilterOptions(strategyStore, strategies), [strategies, strategyStore]);
  const filteredStrategies = useMemo(() => filterStrategies(strategies, filters), [filters, strategies]);
  const selectedStrategy = useMemo(() => (
    selectedStrategyId ? strategyStore.getStrategy(selectedStrategyId) : null
  ), [selectedStrategyId, strategyStore]);
  const eventSummary = useMemo(() => getEventSummary(eventStore.getAllEvents()), [eventStore]);
  const decisionCount = useMemo(() => decisionStore.getDecisions().length, [decisionStore]);

  return (
    <section style={{ display: 'grid', gap: 14 }} data-trading-event-count={eventSummary.total} data-decision-count={decisionCount}>
      <section style={tradingSectionStyle({ borderColor: 'rgba(59,130,246,0.30)' })}>
        <SectionHeader
          eyebrow="Strategy Dashboard"
          title={title}
          summary={summary}
        />
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          {waiting && !strategies.length ? WAITING_BROKER : `${fmtNumber(strategies.length)} strategies from Strategy Store`}
        </div>
      </section>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 10,
      }}>
        {cards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value || EMPTY_VALUE}
            tone={card.value === EMPTY_VALUE ? 'neutral' : card.tone}
          />
        ))}
      </div>

      <StrategyFilters
        filters={filters}
        options={options}
        onChange={setFilters}
        onReset={() => setFilters(EMPTY_STRATEGY_FILTERS)}
        resultCount={fmtNumber(filteredStrategies.length)}
        totalCount={fmtNumber(strategies.length)}
      />

      <StrategyGrid
        strategies={filteredStrategies}
        selectedStrategyId={selectedStrategyId}
        onSelect={(strategy) => setSelectedStrategyId(strategy.strategyId)}
        waiting={waiting}
      />

      <StrategyDrawer
        strategy={selectedStrategy}
        onClose={() => setSelectedStrategyId(null)}
      />
    </section>
  );
});
