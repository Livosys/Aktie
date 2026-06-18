import React from 'react';

function safeString(value, fallback = '–') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function sectionStyle(theme = 'dark') {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 18,
    marginBottom: 18,
    boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.06)' : '0 18px 40px rgba(2,6,23,0.18)',
  };
}

function badgeStyle(tone = 'neutral') {
  const map = {
    neutral: { border: 'var(--border)', bg: 'var(--surface-2)', fg: 'var(--text)' },
    success: { border: 'rgba(34,197,94,0.28)', bg: 'rgba(34,197,94,0.10)', fg: '#86efac' },
    warning: { border: 'rgba(245,158,11,0.28)', bg: 'rgba(245,158,11,0.10)', fg: '#fcd34d' },
    danger: { border: 'rgba(239,68,68,0.28)', bg: 'rgba(239,68,68,0.10)', fg: '#fca5a5' },
    info: { border: 'rgba(56,189,248,0.28)', bg: 'rgba(56,189,248,0.10)', fg: '#7dd3fc' },
  };
  const cfg = map[tone] || map.neutral;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: 999,
    border: `1px solid ${cfg.border}`,
    background: cfg.bg,
    color: cfg.fg,
    fontSize: 11,
    fontWeight: 800,
    lineHeight: 1.2,
  };
}

function ValueList({ values }) {
  const items = safeArray(values);
  if (!items.length) return <span style={{ color: 'var(--muted)' }}>–</span>;
  return <>{items.map((item, index) => <span key={`${item}-${index}`}>{index > 0 ? ' · ' : ''}{item}</span>)}</>;
}

function FieldRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 10, alignItems: 'start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>{value}</div>
    </div>
  );
}

function BlueprintCard({ blueprint }) {
  const missing = safeArray(blueprint?.missingFields);
  const warnings = safeArray(blueprint?.warnings);
  const possible = blueprint?.pineScriptPossible === true;
  const tone = possible ? 'success' : 'warning';

  return (
    <details style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 14, background: 'var(--surface-2)' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>{safeString(blueprint?.strategyName, blueprint?.displayName || blueprint?.strategyId)}</div>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{safeString(blueprint?.strategyId)} · {safeString(blueprint?.direction)} · {safeString(blueprint?.timeframe)}</div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
            <span style={badgeStyle(tone)}>{possible ? 'pineScriptPossible=true' : 'pineScriptPossible=false'}</span>
            <span style={badgeStyle('info')}>missing: {missing.length}</span>
            <span style={badgeStyle('neutral')}>cooldown {safeString(blueprint?.cooldownMinutes)}</span>
            <span style={badgeStyle('neutral')}>max/day {safeString(blueprint?.maxTradesPerDay)}</span>
          </div>
        </div>
      </summary>

      <div style={{ marginTop: 14, display: 'grid', gap: 0 }}>
        <FieldRow label="Strategy" value={`${safeString(blueprint?.strategyId)} · ${safeString(blueprint?.strategyName, blueprint?.displayName)}`} />
        <FieldRow label="Direction" value={safeString(blueprint?.direction)} />
        <FieldRow label="Symbol" value={safeString(blueprint?.symbol)} />
        <FieldRow label="Timeframe" value={safeString(blueprint?.timeframe)} />
        <FieldRow label="Source" value={safeString(blueprint?.source)} />
        <FieldRow label="Indicators" value={<ValueList values={blueprint?.indicatorsRequired} />} />
        <FieldRow label="Entry human" value={<ValueList values={blueprint?.entryConditionsHuman} />} />
        <FieldRow label="Entry Pine" value={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, lineHeight: 1.6 }}>{safeString(blueprint?.entryConditionsPinePseudo)}</pre>} />
        <FieldRow label="Exit human" value={<ValueList values={blueprint?.exitConditionsHuman} />} />
        <FieldRow label="Exit Pine" value={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, lineHeight: 1.6 }}>{safeString(blueprint?.exitConditionsPinePseudo)}</pre>} />
        <FieldRow label="Filters human" value={<ValueList values={blueprint?.filtersHuman} />} />
        <FieldRow label="Filters Pine" value={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, lineHeight: 1.6 }}>{safeString(blueprint?.filtersPinePseudo)}</pre>} />
        <FieldRow label="Risk rules" value={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, lineHeight: 1.6 }}>{JSON.stringify(blueprint?.riskRules || {}, null, 2)}</pre>} />
        <FieldRow label="Session filter" value={safeString(blueprint?.sessionFilter)} />
        <FieldRow label="Recommended lookback" value={`${safeString(blueprint?.recommendedLookbackDays)} days`} />
        <FieldRow label="Missing fields" value={missing.length ? <ValueList values={missing} /> : '–'} />
        <FieldRow label="Warnings" value={warnings.length ? <ValueList values={warnings} /> : '–'} />
      </div>
    </details>
  );
}

export default function TradingViewTestBlueprintPanel({ data, theme = 'dark' }) {
  const summary = data?.summary || {};
  const fieldInventory = data?.fieldInventory || {};
  const blueprints = Array.isArray(data?.blueprints) ? data.blueprints : [];
  const pineScriptPossibleCount = blueprints.filter((blueprint) => blueprint?.pineScriptPossible === true).length;
  const needsAttentionCount = blueprints.filter((blueprint) => safeArray(blueprint?.warnings).length > 0 || safeArray(blueprint?.missingFields).length > 0).length;
  const directionBothCount = blueprints.filter((blueprint) => String(blueprint?.direction || '').toLowerCase() === 'both').length;
  const strategiesCount = toPositiveNumber(summary.strategies) || toPositiveNumber(summary.totalStrategies) || blueprints.length;
  const emptyState = data?.status === 'empty' || (!blueprints.length && summary.totalStrategies === 0);
  const sourceLabel = safeString(data?.source, data?.status === 'empty' ? 'none' : 'unknown');

  return (
    <section style={sectionStyle(theme)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>TradingView Test Blueprint</h2>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 13 }}>
            Read-only blueprint för att göra strategier Pine-ready utan att ändra execution, broker eller risk.
          </div>
          <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>
            Blueprint är strategins testrecept. När en blueprint har testats i TradingView kan resultatet jämföras mot paper-kandidater och Learning.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={badgeStyle('neutral')}>status {safeString(data?.status, 'unknown')}</span>
          <span style={badgeStyle('neutral')}>source {sourceLabel}</span>
          <span style={badgeStyle('success')}>strategies {strategiesCount}</span>
          <span style={badgeStyle('info')}>pineScriptPossible {toPositiveNumber(summary.pineScriptPossible) || pineScriptPossibleCount}</span>
          <span style={badgeStyle('warning')}>needsAttention {toPositiveNumber(summary.needsAttention) || needsAttentionCount}</span>
          <span style={badgeStyle('neutral')}>directionBoth {toPositiveNumber(summary.directionBoth) || directionBothCount}</span>
        </div>
      </div>

      {emptyState ? (
        <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(245,158,11,0.22)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>
          Blueprint-data saknas ännu. Blueprint-källa inte ansluten ännu.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
        {safeArray(fieldInventory.fields).map((field) => (
          <div key={field.field} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)' }}>
            <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{field.field}</div>
            <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{field.present}</div>
            <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>missing {field.missing}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {blueprints.map((blueprint) => (
          <BlueprintCard key={blueprint.strategyId} blueprint={blueprint} />
        ))}
      </div>
    </section>
  );
}
