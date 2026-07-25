import React from 'react';
import { EMPTY_VALUE, textOrEmpty } from '../../utils/tradingFormatters.js';
import { DecisionBadge } from './DecisionBadge.jsx';

export const DecisionSummary = React.memo(function DecisionSummary({
  view = {},
}) {
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}>
            {textOrEmpty(view.category || 'decision')}
          </div>
          <div style={{
            color: 'var(--text)',
            fontSize: 18,
            fontWeight: 900,
            lineHeight: 1.15,
            marginTop: 3,
            overflowWrap: 'anywhere',
          }}>
            {textOrEmpty(view.label)}
          </div>
        </div>
        <DecisionBadge label={view.status || EMPTY_VALUE} tone={view.color || 'neutral'} />
      </div>
      {view.description ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          {view.description}
        </div>
      ) : null}
    </div>
  );
});
