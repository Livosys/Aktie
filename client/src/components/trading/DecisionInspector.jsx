import React from 'react';
import { DecisionCard } from './DecisionCard.jsx';
import { DecisionMetadataPanel } from './DecisionMetadataPanel.jsx';

export const DecisionInspector = React.memo(function DecisionInspector({
  view = null,
  evidence = [],
  alternatives = [],
  metadata = {},
}) {
  if (!view) return null;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <DecisionCard view={view} evidence={evidence} alternatives={alternatives} />
      <DecisionMetadataPanel metadata={metadata} />
    </div>
  );
});
