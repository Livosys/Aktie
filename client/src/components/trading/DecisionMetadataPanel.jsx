import React from 'react';
import { EMPTY_VALUE, hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';

function metadataRows(metadata = {}) {
  return Object.entries(metadata || {})
    .filter(([, value]) => hasValue(value) && typeof value !== 'object')
    .slice(0, 12)
    .map(([label, value]) => ({ label, value: textOrEmpty(value) }));
}

export const DecisionMetadataPanel = React.memo(function DecisionMetadataPanel({
  metadata = {},
}) {
  const rows = metadataRows(metadata);
  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 8,
      padding: 12,
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, marginBottom: 10 }}>
        Metadata
      </div>
      <FieldGrid items={rows.length ? rows : [{ label: 'Metadata', value: EMPTY_VALUE }]} />
    </div>
  );
});
