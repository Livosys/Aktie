import React from 'react';
import { PipelinePage, Kpis, EmptyNote, fmtTime, useOverview } from './pipelineCommon.jsx';
import { num, safeString, SafeText } from '../utils/safeRender.js';

// AI Analyst — AI interpretation and recommendations. Cannot trade. Read-only.
export default function PipelineAiAnalystPage() {
  const { data, error, loading, reload } = useOverview();
  const st = (data && data.aiAnalystStatus) || {};
  const recs = (data && data.aiRecommendations && Array.isArray(data.aiRecommendations.items)) ? data.aiRecommendations.items : [];
  const losses = (data && data.lossFeedbackQueue && Array.isArray(data.lossFeedbackQueue.items)) ? data.lossFeedbackQueue.items : [];
  const status = (data && data.aiRecommendations && data.aiRecommendations.status) || (recs.length ? 'ok' : 'empty');

  return (
    <PipelinePage
      icon="🤖" title="AI Analyst" status={status} loading={loading} error={error} onReload={reload}
      intro="AI Analyst förklarar resultaten och föreslår forskningssteg. Den kan inte handla och kan inte lägga order. Inga knappar för execute eller auto-apply finns här."
      next={{ to: '/paper-trading', label: 'Paper Trading' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Leverantör', value: safeString(st.provider, '—') },
            { label: 'Modell', value: safeString(st.model, '—') },
            { label: 'Beredskap', value: safeString(st.readiness, '—') },
            { label: 'Rekommendationer', value: num(recs.length) },
          ]} />
          {st.message && <p className="cr-soft">{safeString(st.message)}</p>}

          <div className="cr-card">
            <h3>Rekommendationer från AI</h3>
            {recs.length ? (
              <ol className="cr-list">
                {recs.slice(0, 8).map((r, i) => (
                  <li key={i}>
                    <span className={`cr-prio cr-prio-${safeString(r.priority, 'low')}`}>{safeString(r.priority, 'low')}</span>
                    <span><strong><SafeText value={r.title} fallback="Förslag" /></strong> — <SafeText value={r.reason} fallback="" /></span>
                  </li>
                ))}
              </ol>
            ) : <EmptyNote>Ingen AI-analys genererad ännu.</EmptyNote>}
          </div>

          {losses.length > 0 && (
            <div className="cr-card">
              <h3>Förlust-feedback (vad AI ser att undvika)</h3>
              <ol className="cr-list">
                {losses.slice(0, 6).map((l, i) => (
                  <li key={i}>
                    <span className={`cr-prio cr-prio-${safeString(l.priority, 'low')}`}>{safeString(l.priority, 'low')}</span>
                    <span><strong><SafeText value={l.title} fallback="" /></strong> — <SafeText value={l.reason} fallback="" /></span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <p className="cr-foot">
            AI-status genererad {fmtTime(st.latestTimestamp)} · {safeString(data.mode, 'paper_only')} · AI kan inte handla.
          </p>
        </>
      )}
    </PipelinePage>
  );
}
