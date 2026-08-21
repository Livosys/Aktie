import React from 'react';
import { Link } from 'react-router-dom';
import {
  FACTORY_FLOW_STEP_KEYS,
  uiFactoryFlowNavigation,
} from '../../services/uiTerminologyService.js';
import { StatusBadge } from '../trading/index.js';

export default function FactoryFlowNav({ activeKey = FACTORY_FLOW_STEP_KEYS.DASHBOARD }) {
  const copy = uiFactoryFlowNavigation();
  const items = (copy.order || [])
    .map((key) => ({ key, ...(copy.items?.[key] || {}) }))
    .filter((item) => item.path && item.label);

  return (
    <nav aria-label={copy.ariaLabel} style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--surface)',
      padding: 12,
      marginBottom: 16,
      display: 'grid',
      gap: 10,
    }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', fontSize: 14 }}>{copy.title}</strong>
          <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12, lineHeight: 1.35, marginTop: 2 }}>
            {copy.subtitle}
          </span>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 145px), 1fr))',
        gap: 8,
      }}
      >
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <Link
              key={item.key}
              to={item.path}
              aria-current={active ? 'page' : undefined}
              style={{
                border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: active ? 'rgba(59,130,246,0.10)' : 'var(--surface-2)',
                borderRadius: 8,
                padding: 10,
                color: 'var(--text)',
                textDecoration: 'none',
                minWidth: 0,
                display: 'grid',
                gap: 6,
              }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong style={{ fontSize: 13, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{item.label}</strong>
                {active ? <StatusBadge tone="info" compact>{copy.current}</StatusBadge> : null}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                {item.summary}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
