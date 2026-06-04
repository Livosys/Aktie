import React from 'react';

export default function SimpleStatusCard({ icon = '•', title, summary, value, tone = 'blue', detail, progress = null }) {
  const pct = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : null;

  return (
    <article className={`tr-status-card tr-status-${tone}`}>
      <div className="tr-status-head">
        <div className="tr-status-icon" aria-hidden="true">{icon}</div>
        <div className="tr-status-copy">
          <h3>{title}</h3>
          <p>{summary}</p>
        </div>
      </div>
      <strong className="tr-status-value">{value}</strong>
      {pct !== null ? (
        <div className="tr-status-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {detail ? <div className="tr-status-detail">{detail}</div> : null}
    </article>
  );
}
