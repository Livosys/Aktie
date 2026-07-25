import React from 'react';
import { OverviewPanel } from './OverviewPanel.jsx';
import { DecisionHistory } from './DecisionHistory.jsx';

export const DecisionPanel = React.memo(function DecisionPanel({
  title = 'Decisions',
  summary = 'Canonical decisions from DecisionStore.',
  items = [],
  emptyText = 'No decisions available.',
}) {
  return (
    <OverviewPanel eyebrow="Decision Engine" title={title} summary={summary}>
      <DecisionHistory items={items} emptyText={emptyText} />
    </OverviewPanel>
  );
});
