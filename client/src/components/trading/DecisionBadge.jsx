import React from 'react';
import { EMPTY_VALUE, textOrEmpty } from '../../utils/tradingFormatters.js';
import { StatusBadge } from './StatusBadge.jsx';

export const DecisionBadge = React.memo(function DecisionBadge({
  label = null,
  tone = 'neutral',
  compact = false,
}) {
  return (
    <StatusBadge tone={tone} compact={compact}>
      {textOrEmpty(label || EMPTY_VALUE)}
    </StatusBadge>
  );
});
