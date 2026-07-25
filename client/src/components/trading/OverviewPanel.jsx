import React from 'react';

export function tradingSectionStyle(extra = {}) {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 16,
    boxShadow: 'var(--shadow-1, none)',
    ...extra,
  };
}

export function SectionHeader({ eyebrow, title, summary, action }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? (
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}>
            {eyebrow}
          </div>
        ) : null}
        <h2 style={{ margin: '4px 0 0', fontSize: 18, lineHeight: 1.2 }}>{title}</h2>
        {summary ? <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{summary}</p> : null}
      </div>
      {action}
    </div>
  );
}

export const OverviewPanel = React.memo(function OverviewPanel({
  eyebrow,
  title,
  summary,
  children,
  ...sectionProps
}) {
  return (
    <section {...sectionProps} style={tradingSectionStyle({ minHeight: 0, ...(sectionProps.style || {}) })}>
      <SectionHeader eyebrow={eyebrow} title={title} summary={summary} />
      {children}
    </section>
  );
});
