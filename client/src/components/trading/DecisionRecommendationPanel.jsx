import React from 'react';
import { EMPTY_VALUE, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';

export const DecisionRecommendationPanel = React.memo(function DecisionRecommendationPanel({
  recommendation = null,
  alternatives = [],
}) {
  const rows = [
    { label: 'Recommended action', value: textOrEmpty(recommendation || EMPTY_VALUE) },
    ...(Array.isArray(alternatives) && alternatives.length
      ? alternatives.map((row) => ({ label: row.label, value: textOrEmpty(row.value) }))
      : [{ label: 'Alternative actions', value: EMPTY_VALUE }]),
  ];

  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 8,
      padding: 12,
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 10 }}>
        Recommendation
      </div>
      <FieldGrid items={rows} />
    </div>
  );
});
