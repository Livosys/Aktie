import React from 'react';
import { PipelinePage, Kpis, EmptyNote, fmtTime, useOverview } from './pipelineCommon.jsx';
import { num, safeString } from '../utils/safeRender.js';

// Batch — compares many strategy configurations. Read-only.
export default function PipelineBatchPage() {
  const { data, error, loading, reload } = useOverview();
  const bs = (data && data.batchStatus) || {};
  const sum = (data && data.batchSummary) || {};
  const latest = sum.latestBatch || bs.latestBatch || null;
  const strategies = latest && typeof latest.strategy === 'string'
    ? latest.strategy.split(',').map((s) => s.trim()).filter(Boolean) : [];

  return (
    <PipelinePage
      icon="🧮" title="Batch" status={bs.status} loading={loading} error={error} onReload={reload}
      intro="Batchtestning jämför många versioner av strategier för att hitta vilka inställningar som presterar bättre. Allt körs i analysläge."
      next={{ to: '/strategies', label: 'Strategier' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Batchtester', value: num(bs.totalBatches != null ? bs.totalBatches : sum.totalBatches) },
            { label: 'Klara', value: num(sum.completedBatches) },
            { label: 'Pågår', value: num(sum.runningBatches) },
            { label: 'Misslyckade', value: num(sum.failedBatches) },
            { label: 'Senaste start', value: fmtTime(latest && latest.startedAt) },
            { label: 'Senaste klar', value: fmtTime(latest && latest.completedAt) },
          ]} />

          {latest ? (
            <div className="cr-card">
              <h3>Senaste batch</h3>
              <ul className="cr-list">
                <li><strong>ID:</strong> {safeString(latest.id, '—')}</li>
                <li><strong>Status:</strong> <span className="cr-tag">{safeString(latest.status, '—')}</span></li>
                <li><strong>Tidsupplösning:</strong> {safeString(latest.timeframe, '—')}</li>
                <li><strong>Symboler:</strong> {Array.isArray(latest.symbols) ? latest.symbols.join(', ') : '—'}</li>
              </ul>
              {strategies.length > 0 && (
                <>
                  <h3 style={{ marginTop: 12 }}>Strategier i batchen ({strategies.length})</h3>
                  <div>{strategies.map((s, i) => <span key={i} className="cr-tag" style={{ marginRight: 6 }}>{s}</span>)}</div>
                </>
              )}
            </div>
          ) : <EmptyNote>Ingen batch körd ännu.</EmptyNote>}
        </>
      )}
    </PipelinePage>
  );
}
