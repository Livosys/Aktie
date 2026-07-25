import React from 'react';
import { EMPTY_VALUE, fmtTime, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { DecisionEvidencePanel } from './DecisionEvidencePanel.jsx';
import { DecisionRecommendationPanel } from './DecisionRecommendationPanel.jsx';
import { DecisionSummary } from './DecisionSummary.jsx';

export const DecisionCard = React.memo(function DecisionCard({
  view = {},
  evidence = [],
  alternatives = [],
}) {
  return (
    <article style={{
      border: '1px solid var(--border)',
      background: 'var(--surface)',
      borderRadius: 8,
      padding: 14,
      display: 'grid',
      gap: 12,
      minWidth: 0,
    }}>
      <DecisionSummary view={view} />
      <FieldGrid
        items={[
          { label: 'Decision ID', value: textOrEmpty(view.decisionId) },
          { label: 'Event ID', value: textOrEmpty(view.eventId) },
          { label: 'Strategy ID', value: textOrEmpty(view.strategyId) },
          { label: 'Candidate ID', value: textOrEmpty(view.candidateId) },
          { label: 'Order ID', value: textOrEmpty(view.orderId) },
          { label: 'Position ID', value: textOrEmpty(view.positionId) },
          { label: 'Trade ID', value: textOrEmpty(view.tradeId) },
          { label: 'Source', value: textOrEmpty(view.source) },
          { label: 'Timestamp', value: fmtTime(view.timestamp) },
          { label: 'Confidence', value: textOrEmpty(view.confidenceLabel || EMPTY_VALUE) },
          { label: 'Severity', value: textOrEmpty(view.severity) },
          { label: 'Priority', value: textOrEmpty(view.priority) },
        ]}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <DecisionEvidencePanel evidence={evidence} />
        <DecisionRecommendationPanel recommendation={view.recommendedAction} alternatives={alternatives} />
      </div>
    </article>
  );
});
