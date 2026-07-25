import React from 'react';
import { DecisionTimeline } from './DecisionTimeline.jsx';

export const DecisionHistory = React.memo(function DecisionHistory({
  items = [],
  emptyText = 'No decisions available.',
}) {
  return <DecisionTimeline items={items} emptyText={emptyText} />;
});
