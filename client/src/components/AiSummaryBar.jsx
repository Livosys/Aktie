import React, { useMemo } from 'react';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

function bestStrategy(weights) {
  const key = weights?.topStrategies?.[0];
  const labels = {
    vwap_reclaim: 'VWAP fungerar bäst',
    vwap_rejection: 'VWAP-avvisning fungerar bäst',
    vwap_momentum: 'VWAP stark rörelse fungerar bäst',
    momentum: 'Stark rörelse fungerar bäst',
    mean_reversion: 'Återgång är svagare',
    breakout: 'Utbrott fungerar bäst',
  };
  return labels[key] || 'Mönsterprioritering uppdaterad';
}

function marketText(regime) {
  const bias = regime?.indexBias?.overall;
  if (bias === 'bullish') return 'Bullish marknadsläge';
  if (bias === 'bearish') return 'Bearish marknadsläge';
  return regime?.regimeLabelSv || 'Blandat marknadsläge';
}

export default function AiSummaryBar() {
  const { global, test } = useUnifiedConfig('core');
  const regime = test.marketRegime;
  const health = global.systemHealth;
  const priority = test.prioritySummary;

  const text = useMemo(() => {
    const parts = [
      marketText(regime),
      bestStrategy(regime?.strategyWeights),
    ];
    if (priority?.topFocus?.[0]) parts.push(`${priority.topFocus[0].strategyLabel || priority.topFocus[0].signalFamily} prioriteras`);
    if (priority?.avoid?.some((item) => item.marketContext?.strategyStrength === 'strategin fungerar dåligt')) {
      parts.push('En strategi underpresterar');
    }
    if (priority?.avoid?.some((item) => item.marketContext?.timeoutRisk === 'hög')) {
      parts.push('Timeout-risk hög på svaga signaler');
    }
    if (priority?.clusters?.[0]) parts.push(priority.clusters[0].label);
    if (regime?.riskEnvLabelSv) parts.push(regime.riskEnvLabelSv);
    if (health?.overallStatus === 'WARNING') parts.push('Kontrollera datakällor');
    if (health?.overallStatus === 'CRITICAL') parts.push('Systemvarning kräver åtgärd');
    return `${parts.filter(Boolean).join('. ')}.`;
  }, [regime, health, priority]);

  return (
    <div className="ai-summary-bar">
      <span className="ai-summary-icon">🧠</span>
      <strong>AI Summary:</strong>
      <span>{text}</span>
    </div>
  );
}
