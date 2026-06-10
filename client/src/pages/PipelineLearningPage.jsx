import React from 'react';
import { PipelinePage, Kpis, EmptyNote, fmtTime, useOverview } from './pipelineCommon.jsx';
import { num, safeString, SafeText } from '../utils/safeRender.js';

// Learning — the core product page. What the system has learned. Read-only.
export default function PipelineLearningPage() {
  const { data, error, loading, reload } = useOverview();
  const ls = (data && data.learningStatus) || {};
  const nl = ls.narrowLearning || {};
  const best = nl.bestStrategy;
  const worst = nl.worstStrategy;
  const nextTests = (data && Array.isArray(data.nextRecommendedActions)) ? data.nextRecommendedActions : [];
  const recent = (data && Array.isArray(data.recentTests)) ? data.recentTests : [];

  return (
    <PipelinePage
      icon="🧠" title={<>Learning <span className="cr-pill-core">Produkten</span></>} status={ls.status} loading={loading} error={error} onReload={reload}
      intro="Learning samlar resultat från replay, batch och paper för att hitta vad som fungerar och vad som behöver förbättras. Det här är systemets faktiska produkt."
      next={{ to: '/ai-analyst', label: 'AI Analyst' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Learning-status', value: safeString(nl.status || ls.status, '—') },
            { label: 'Bästa strategi', value: best ? safeString(best.name) : '—' },
            { label: 'Bäst winRate', value: best ? num(best.winRate, '%') : '—' },
            { label: 'Analyserade trades (bäst)', value: best ? num(best.trades) : '—' },
          ]} />

          {nl.message && <p className="cr-soft">{safeString(nl.message)}</p>}

          <div className="cr-card">
            <h3>Starkaste och svagaste fynd</h3>
            <ul className="cr-list">
              <li><span className="cr-good">Starkast:</span> {best ? `${safeString(best.name)} — winRate ${num(best.winRate, '%')}, avgPnl ${num(best.avgPnl)}, omdöme ${safeString(best.verdict, '—')}` : '— (för lite data)'}</li>
              <li><span className="cr-bad">Svagast:</span> {worst ? `${safeString(worst.name)} — winRate ${num(worst.winRate, '%')}, avgPnl ${num(worst.avgPnl)}, omdöme ${safeString(worst.verdict, '—')}` : '—'}</li>
            </ul>
          </div>

          <div className="cr-card">
            <h3>Rekommenderade nästa tester</h3>
            {nextTests.length ? (
              <ol className="cr-list">
                {nextTests.slice(0, 5).map((a, i) => (
                  <li key={i}><strong><SafeText value={a.title} fallback="Test" /></strong> — <SafeText value={a.reason} fallback="" /></li>
                ))}
              </ol>
            ) : <EmptyNote>Inga rekommendationer ännu.</EmptyNote>}
          </div>

          <div className="cr-card">
            <h3>Senaste tester och körningar ({recent.length})</h3>
            {recent.length ? (
              <table className="cr-table">
                <thead><tr><th>Tid</th><th>Typ</th><th>Strategi</th><th>Symbol/TF</th></tr></thead>
                <tbody>
                  {recent.slice(0, 10).map((t, i) => (
                    <tr key={i}>
                      <td>{fmtTime(t.timestamp)}</td>
                      <td><span className="cr-tag">{safeString(t.type, '—')}</span></td>
                      <td>{safeString(t.strategy, '—')}</td>
                      <td>{safeString(t.symbol, '—')}{t.timeframe ? ` · ${safeString(t.timeframe)}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyNote>Inga körningar loggade ännu.</EmptyNote>}
          </div>
        </>
      )}
    </PipelinePage>
  );
}
