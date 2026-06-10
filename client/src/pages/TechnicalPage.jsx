import React from 'react';
import { PipelinePage, Kpis, StatusDot, useOverview } from './pipelineCommon.jsx';
import { num, safeString, SafeText } from '../utils/safeRender.js';

// Technical — raw/debug system info. Advanced view. Read-only.
export default function TechnicalPage() {
  const { data, error, loading, reload } = useOverview();
  const tech = (data && data.technical) || {};
  const counts = tech.counts || {};
  const blocks = (data && data.blocks) || {};
  const markers = tech.sourceMarkers || {};
  const risks = (data && Array.isArray(data.risks)) ? data.risks : [];
  const blockKeys = Object.keys(blocks);

  return (
    <PipelinePage
      icon="🔧" title="Technical" status={tech.status} loading={loading} error={error} onReload={reload}
      intro="Teknisk och felsökningsinformation: råa blockstatusar, cache-ålder, källmarkörer, degraderade tjänster och råa säkerhetsflaggor. Inte tänkt för dagligt bruk."
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Block totalt', value: num(counts.total) },
            { label: 'OK', value: num(counts.ok) },
            { label: 'Tomma', value: num(counts.empty) },
            { label: 'Degraderade', value: num(counts.degraded) },
            { label: 'Fel', value: num(counts.error) },
            { label: 'Cache-ålder', value: tech.cacheAgeMs != null ? `${num(tech.cacheAgeMs)} ms` : (data.cacheAgeMs != null ? `${num(data.cacheAgeMs)} ms` : '—') },
          ]} />

          <div className="cr-card">
            <h3>Råa säkerhetsflaggor</h3>
            <ul className="cr-list">
              <li>mode = <strong>{safeString(data.mode, '—')}</strong></li>
              <li>actions_allowed = <strong>{String(data.actions_allowed)}</strong></li>
              <li>can_place_orders = <strong>{String(data.can_place_orders)}</strong></li>
              <li>live_trading_enabled = <strong>{String(data.live_trading_enabled)}</strong></li>
              <li>broker_enabled = <strong>{String(data.broker_enabled)}</strong></li>
            </ul>
          </div>

          <div className="cr-card">
            <h3>Blockstatusar ({blockKeys.length})</h3>
            <table className="cr-table">
              <thead><tr><th>Block</th><th>Status</th><th>Källa</th></tr></thead>
              <tbody>
                {blockKeys.map((k) => {
                  const b = blocks[k] || {};
                  const m = markers[k] || {};
                  return (
                    <tr key={k}>
                      <td>{k}</td>
                      <td><StatusDot status={b.status} /></td>
                      <td><span className="cr-tag">{safeString(b.source || m.source, '—')}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="cr-card">
            <h3>Alla risker ({risks.length})</h3>
            <ul className="cr-list">
              {risks.map((r, i) => (
                <li key={i}>
                  <span className="cr-tag">{safeString(r && r.level, 'info')}</span>
                  <SafeText value={r && (r.message_sv || r.message)} fallback="" />
                </li>
              ))}
            </ul>
          </div>

          <p className="cr-foot">
            Källa: {safeString(tech.source, '—')} · genererad {safeString(tech.generatedAt || data.generatedAt, '—')} · cached={String(data.cached)}.
          </p>
        </>
      )}
    </PipelinePage>
  );
}
