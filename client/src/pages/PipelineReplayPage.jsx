import React from 'react';
import { PipelinePage, Kpis, EmptyNote, fmtTime, useOverview } from './pipelineCommon.jsx';
import { num, safeString } from '../utils/safeRender.js';

// Replay — historical replay testing of signals against historical data. Read-only.
export default function PipelineReplayPage() {
  const { data, error, loading, reload } = useOverview();
  const rs = (data && data.replayStatus) || {};
  const sum = (data && data.replaySummary) || {};
  const latest = sum.latestReplay || rs.latestReplay || null;
  const best = latest && latest.bestSymbol;

  return (
    <PipelinePage
      icon="⏪" title="Replay" status={rs.status} loading={loading} error={error} onReload={reload}
      intro="Replay testar historiska signaler mot historisk data. Det hjälper systemet att lära sig utan att handla live — inga riktiga order läggs."
      next={{ to: '/batch', label: 'Batch' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Replay-körningar', value: num(rs.totalReplayRuns != null ? rs.totalReplayRuns : sum.totalReplayTests) },
            { label: 'Senaste körning', value: fmtTime(latest && latest.createdAt) },
            { label: 'Events (senaste)', value: num(latest && latest.totalEvents) },
            { label: 'Snittbetyg', value: num(latest && latest.avgTradeScore) },
            { label: 'Tidsupplösning', value: safeString(latest && latest.timeframe, '—') },
            { label: 'Bästa symbol', value: best ? `${safeString(best.symbol)} (${num(best.avgScore)})` : '—' },
          ]} />

          {latest ? (
            <div className="cr-card">
              <h3>Senaste replay</h3>
              <ul className="cr-list">
                <li><strong>Körning:</strong> {safeString(latest.runId, '—')}</li>
                <li><strong>Period:</strong> {latest.period ? `${safeString(latest.period.from)} → ${safeString(latest.period.to)}` : '—'}</li>
                <li><strong>Symboler:</strong> {Array.isArray(latest.symbols) ? latest.symbols.join(', ') : '—'}</li>
                <li><strong>Läge:</strong> <span className="cr-tag">{safeString(latest.replayMode || 'scan_only')}</span></li>
                {latest.outcome && <li><strong>Resultat:</strong> {safeString(latest.outcome)}</li>}
              </ul>
            </div>
          ) : <EmptyNote>Ingen replay-körning ännu. Kör replay på symboler som är redo i Data.</EmptyNote>}
        </>
      )}
    </PipelinePage>
  );
}
