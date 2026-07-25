import React from 'react';
import { EMPTY_VALUE } from '../../utils/tradingFormatters.js';
import { strategyDisplayName } from '../../stores/strategyStore.js';
import { StatusBadge, statusTone } from './StatusBadge.jsx';
import { StrategyApprovalPanel } from './StrategyApprovalPanel.jsx';
import { StrategyIntelligencePanel } from './StrategyIntelligencePanel.jsx';
import { StrategyMetadataPanel } from './StrategyMetadataPanel.jsx';
import { StrategyOrdersPanel } from './StrategyOrdersPanel.jsx';
import { StrategyOverviewPanel } from './StrategyOverviewPanel.jsx';
import { StrategyPerformancePanel } from './StrategyPerformancePanel.jsx';
import { StrategyRiskPanel } from './StrategyRiskPanel.jsx';
import { StrategyRuntimePanel } from './StrategyRuntimePanel.jsx';
import { StrategySignalPanel } from './StrategySignalPanel.jsx';
import { stateText } from './StrategyDashboardUtils.js';

export const StrategyDrawer = React.memo(function StrategyDrawer({
  strategy,
  onClose,
}) {
  if (!strategy) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(2,6,23,0.40)',
        display: 'grid',
        justifyItems: 'end',
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Strategy details ${strategyDisplayName(strategy, EMPTY_VALUE)}`}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(760px, 100vw)',
          height: '100%',
          overflowY: 'auto',
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: '-24px 0 60px rgba(2,6,23,0.28)',
          padding: 18,
          display: 'grid',
          alignContent: 'start',
          gap: 12,
        }}
      >
        <header style={{
          position: 'sticky',
          top: -18,
          zIndex: 1,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          padding: '0 0 14px',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'flex-start',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              color: 'var(--muted)',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}>
              Strategy Detail
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 24, lineHeight: 1.1, overflowWrap: 'anywhere' }}>
              {strategyDisplayName(strategy, EMPTY_VALUE)}
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5, overflowWrap: 'anywhere' }}>
              {strategy.strategyId || EMPTY_VALUE}
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10 }}>
              <StatusBadge tone={statusTone(strategy.runtimeState || strategy.metadata?.status)}>{stateText(strategy)}</StatusBadge>
              <StatusBadge tone={statusTone(strategy.approvalState)}>{strategy.approvalState || EMPTY_VALUE}</StatusBadge>
              <StatusBadge tone={statusTone(strategy.riskState)}>{strategy.riskState || EMPTY_VALUE}</StatusBadge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close strategy details"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface-2)',
              color: 'var(--text)',
              width: 34,
              height: 34,
              display: 'inline-grid',
              placeItems: 'center',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              flex: '0 0 auto',
            }}
          >
            x
          </button>
        </header>

        <StrategyIntelligencePanel strategy={strategy} />
        <StrategyOverviewPanel strategy={strategy} />
        <StrategyRuntimePanel strategy={strategy} />
        <StrategySignalPanel strategy={strategy} />
        <StrategyRiskPanel strategy={strategy} />
        <StrategyApprovalPanel strategy={strategy} />
        <StrategyPerformancePanel strategy={strategy} />
        <StrategyOrdersPanel strategy={strategy} />
        <StrategyMetadataPanel strategy={strategy} />
      </aside>
    </div>
  );
});
