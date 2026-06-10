import React from 'react';
import { PipelinePage, Kpis, EmptyNote, useOverview } from './pipelineCommon.jsx';
import { num, safeString } from '../utils/safeRender.js';

// Data — what market data exists and what is missing. Read-only.
export default function PipelineDataPage() {
  const { data, error, loading, reload } = useOverview();
  const ds = (data && data.dataStatus) || {};
  const ready = Array.isArray(ds.readySymbols) ? ds.readySymbols : [];

  return (
    <PipelinePage
      icon="🗄️" title="Data" status={ds.status} loading={loading} error={error} onReload={reload}
      intro="Marknadsdata som systemet kan testa på. Här ser du vilka symboler som är redo och vad som saknas. Utan data kan ett steg inte testas."
      next={{ to: '/replay', label: 'Replay' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Symboler totalt', value: num(ds.symbolsTotal) },
            { label: 'Med data', value: num(ds.storedSymbols) },
            { label: 'Saknar data', value: num(ds.missingData) },
            { label: 'Redo för replay', value: num(ds.readyForReplay) },
            { label: 'Redo för batch', value: num(ds.readyForBatch) },
            { label: 'Täckning (poäng)', value: num(ds.totalCoverageScore) },
            { label: 'Tidsupplösningar', value: Array.isArray(ds.availableTimeframes) ? ds.availableTimeframes.join(', ') : '—' },
            { label: 'Backfill-jobb', value: num(ds.activeBackfillJobs) },
          ]} />

          <div className="cr-card">
            <h3>Symboler redo för testning ({ready.length})</h3>
            {ready.length ? (
              <table className="cr-table">
                <thead><tr><th>Symbol</th><th>Grupp</th><th className="num">Täckning</th><th className="num">Dagar</th></tr></thead>
                <tbody>
                  {ready.map((s, i) => (
                    <tr key={i}>
                      <td><strong>{safeString(s.symbol)}</strong></td>
                      <td><span className="cr-tag">{safeString(s.marketGroup, '—')}</span></td>
                      <td className="num">{num(s.coverageScore)}</td>
                      <td className="num">{num(s.daysCovered)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyNote>Inga symboler har tillräcklig data ännu.</EmptyNote>}
          </div>

          {ds.status === 'degraded' && (
            <p className="cr-soft">Delvis täckning: {num(ds.missingData)} symboler saknar data och kan inte testas förrän de fyllts på.</p>
          )}
        </>
      )}
    </PipelinePage>
  );
}
