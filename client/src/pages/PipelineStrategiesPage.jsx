import React from 'react';
import { PipelinePage, Kpis, EmptyNote, useOverview } from './pipelineCommon.jsx';
import { num, safeString } from '../utils/safeRender.js';

// Strategies — catalog and performance status. Read-only.
export default function PipelineStrategiesPage() {
  const { data, error, loading, reload } = useOverview();
  const sr = (data && data.strategyRanking) || {};
  const learning = ((data && data.learningStatus) || {}).narrowLearning || {};
  const best = learning.bestStrategy;
  const worst = learning.worstStrategy;
  const noTests = Array.isArray(sr.strategiesWithoutTests) ? sr.strategiesWithoutTests : [];

  return (
    <PipelinePage
      icon="🎯" title="Strategier" status={sr.status} loading={loading} error={error} onReload={reload}
      intro="Strategikatalogen och hur strategierna mår. Strategier är inputs — det systemet lär sig av dem är produkten."
      next={{ to: '/learning', label: 'Learning' }}
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Strategier totalt', value: num(sr.totalStrategies) },
            { label: 'Aktiva', value: num(sr.activeStrategies) },
            { label: 'Inaktiva', value: num(sr.inactiveStrategies) },
            { label: 'Paper-only', value: num(sr.paperOnlyStrategies) },
            { label: 'Pausade', value: num(sr.pausedStrategies) },
            { label: 'Med bevis (tester)', value: num(sr.activeStrategiesWithEvidence) },
          ]} />

          <div className="cr-card">
            <h3>Just nu</h3>
            <ul className="cr-list">
              <li><span className="cr-good">Fungerar bäst:</span> {best ? `${safeString(best.name)} — winRate ${num(best.winRate, '%')}, ${num(best.trades)} trades` : '— (för lite data)'}</li>
              <li><span className="cr-bad">Behöver mer testning:</span> {worst ? `${safeString(worst.name)} — winRate ${num(worst.winRate, '%')}, ${num(worst.trades)} trades` : '—'}</li>
            </ul>
            <p className="cr-soft">Ingen auto-apply — eventuella ändringar görs manuellt. Systemet lägger aldrig order.</p>
          </div>

          {noTests.length > 0 && (
            <div className="cr-card">
              <h3>Strategier utan testdata ({noTests.length})</h3>
              <table className="cr-table">
                <thead><tr><th>Strategi</th><th>Status</th><th className="num">Poäng</th><th className="num">Trades</th></tr></thead>
                <tbody>
                  {noTests.slice(0, 12).map((s, i) => (
                    <tr key={i}>
                      <td>{safeString(s.name || s.key)}</td>
                      <td><span className="cr-tag">{safeString(s.status, '—')}</span></td>
                      <td className="num">{num(s.score)}</td>
                      <td className="num">{num(s.trades)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {noTests.length > 12 && <p className="cr-soft">+ {noTests.length - 12} till.</p>}
            </div>
          )}
          {noTests.length === 0 && sr.status === 'empty' && <EmptyNote />}
        </>
      )}
    </PipelinePage>
  );
}
