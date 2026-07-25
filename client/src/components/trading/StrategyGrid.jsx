import React from 'react';
import { WAITING_BROKER } from '../../utils/tradingFormatters.js';
import { StrategyCard } from './StrategyCard.jsx';

export const StrategyGrid = React.memo(function StrategyGrid({
  strategies = [],
  selectedStrategyId = null,
  onSelect,
  waiting = false,
}) {
  if (!strategies.length) {
    return (
      <section style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        padding: 18,
        color: 'var(--muted)',
        fontSize: 13,
      }}>
        {waiting ? WAITING_BROKER : 'Unavailable'}
      </section>
    );
  }

  return (
    <section style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
      gap: 12,
      alignItems: 'stretch',
    }}>
      {strategies.map((strategy) => (
        <StrategyCard
          key={strategy.strategyId}
          strategy={strategy}
          selected={strategy.strategyId === selectedStrategyId}
          onSelect={onSelect}
        />
      ))}
    </section>
  );
});
