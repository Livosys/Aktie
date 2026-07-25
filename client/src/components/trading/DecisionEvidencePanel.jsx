import React from 'react';
import { EMPTY_VALUE, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';

export const DecisionEvidencePanel = React.memo(function DecisionEvidencePanel({
  evidence = [],
  title = 'Evidence',
}) {
  const rows = Array.isArray(evidence) && evidence.length
    ? evidence.map((row) => ({
      label: row.label,
      value: textOrEmpty(row.value),
      hint: row.hint || null,
    }))
    : [{ label: title, value: EMPTY_VALUE }];

  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 8,
      padding: 12,
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 10 }}>
        {title}
      </div>
      <FieldGrid items={rows} />
    </div>
  );
});
