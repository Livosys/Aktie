import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './controlRoom.css';
import { SafeText, safeString, num } from '../utils/safeRender.js';

// Home / Control Room — the main landing page for Trading OS.
// Read-only. Consumes ONLY GET /api/supervisor/overview and maps its blocks
// into a plain-language pipeline overview. No backend logic, no order/exec code.
// Trading OS is a research/learning platform — it never places real orders.

function apiJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const STATUS_LABEL = { ok: 'Fungerar', empty: 'Ingen data än', degraded: 'Delvis', error: 'Fel', unknown: 'Okänt' };

function StatusDot({ status }) {
  const s = status || 'unknown';
  return <span className={`cr-dot cr-dot-${s}`} title={STATUS_LABEL[s] || s}>{STATUS_LABEL[s] || s}</span>;
}

function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('sv-SE');
}

// Build the six pipeline stages from the flat top-level overview keys.
function buildStages(d) {
  const data = d.dataStatus || {};
  const replay = d.replayStatus || {};
  const batch = d.batchStatus || {};
  const learning = d.learningStatus || {};
  const paper = d.paperStatus || {};

  const aiRecs = (d.aiRecommendations && Array.isArray(d.aiRecommendations.items)) ? d.aiRecommendations.items : [];
  const aiStatus = (d.aiRecommendations && d.aiRecommendations.status) || (aiRecs.length ? 'ok' : 'empty');
  const aiCount = aiRecs.length;

  const narrow = learning.narrowLearning || {};
  const best = narrow.bestStrategy || {};

  return [
    {
      key: 'data', icon: '🗄️', title: 'Data', to: '/data',
      status: safeString(data.status, 'unknown'),
      explain: 'Marknadsdata som systemet kan testa på. Visar hur många symboler som är redo.',
      count: `${num(data.storedSymbols)}/${num(data.symbolsTotal)} symboler redo`,
      detail: data.missingData ? `${num(data.missingData)} symboler saknar data` : `Täckning ${num(data.totalCoverageScore)}`,
    },
    {
      key: 'replay', icon: '⏪', title: 'Replay', to: '/replay',
      status: safeString(replay.status, 'unknown'),
      explain: 'Testar historiska signaler mot historisk data — lär utan att handla live.',
      count: `${num(replay.totalReplayRuns)} körningar`,
      detail: replay.latestReplay ? `Senaste: ${fmtTime(replay.latestReplay.createdAt)}` : 'Ingen körning än',
    },
    {
      key: 'batch', icon: '🧮', title: 'Batch', to: '/batch',
      status: safeString(batch.status, 'unknown'),
      explain: 'Jämför många versioner av strategier för att hitta bättre inställningar.',
      count: `${num(batch.totalBatches)} batchtester`,
      detail: batch.latestBatch ? `Senaste: ${fmtTime(batch.latestBatch.startedAt || batch.latestBatch.createdAt)}` : 'Ingen batch än',
    },
    {
      key: 'learning', icon: '🧠', title: 'Learning', to: '/learning', core: true,
      status: safeString(learning.status, 'unknown'),
      explain: 'Systemets kärna: samlar resultat från replay, batch och paper för att se vad som fungerar.',
      count: best.name ? `Bäst: ${safeString(best.name)}` : 'Samlar slutsatser',
      detail: narrow.message ? safeString(narrow.message) : (best.winRate != null ? `winRate ${num(best.winRate, '%')}` : '—'),
    },
    {
      key: 'ai', icon: '🤖', title: 'AI Analyst', to: '/ai-analyst',
      status: safeString(aiStatus, 'unknown'),
      explain: 'AI förklarar resultaten och föreslår nästa forskningssteg. Kan inte handla.',
      count: `${aiCount} rekommendationer`,
      detail: 'Endast förslag — ingen auto-apply, inga order',
    },
    {
      key: 'paper', icon: '📝', title: 'Paper Trading', to: '/paper-trading',
      status: safeString(paper.status, 'unknown'),
      explain: 'Simulerad handel. Inga riktiga pengar och inga riktiga order.',
      count: `${num(paper.count != null ? paper.count : (paper.summary && paper.summary.totalTrades))} låtsastrades`,
      detail: paper.emptyReason === 'no_paper_trades' ? 'Inga låtsastrades än' : 'Simulering pågår',
    },
  ];
}

function PipelineStage({ stage, isLast }) {
  return (
    <>
      <Link to={stage.to} className={`cr-stage${stage.core ? ' cr-stage-core' : ''}`}>
        <div className="cr-stage-head">
          <span className="cr-stage-icon">{stage.icon}</span>
          <span className="cr-stage-title">{stage.title}</span>
          {stage.core && <span className="cr-stage-coretag">Produkten</span>}
        </div>
        <StatusDot status={stage.status} />
        <p className="cr-stage-explain">{stage.explain}</p>
        <p className="cr-stage-count">{stage.count}</p>
        <p className="cr-stage-detail">{stage.detail}</p>
        <span className="cr-stage-next">Öppna →</span>
      </Link>
      {!isLast && <span className="cr-arrow" aria-hidden="true">→</span>}
    </>
  );
}

export default function ControlRoomPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    apiJson('/api/supervisor/overview')
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const stages = data ? buildStages(data) : [];
  const nextActions = (data && Array.isArray(data.nextRecommendedActions) && data.nextRecommendedActions.length)
    ? data.nextRecommendedActions
    : (data && Array.isArray(data.actionPlan) ? data.actionPlan : []);
  const nextAction = nextActions[0];

  return (
    <div className="cr-page">
      <div className="cr-safety">
        🔒 Paper Only · Live Trading Off · Real Orders Blocked · Broker Disabled
        <Link to="/technical" className="cr-safety-tech">Tekniska detaljer →</Link>
      </div>

      <header className="cr-header">
        <div>
          <h1>🧭 Control Room</h1>
          <p className="cr-sub">Trading OS testar strategier säkert, jämför resultat, lär av utfall och föreslår nästa forskningssteg. Det lägger aldrig riktiga order.</p>
        </div>
        <button className="cr-refresh" onClick={load} disabled={loading}>{loading ? 'Laddar…' : '↻ Uppdatera'}</button>
      </header>

      {error && <div className="cr-error">Kunde inte hämta översikten: {error}.</div>}

      {data && (
        <>
          {/* Pipeline */}
          <section className="cr-section">
            <h2 className="cr-section-title">Pipeline</h2>
            <p className="cr-section-help">Data → Replay → Batch → Learning → AI Analyst → Paper Trading. Varje steg visar om det fungerar och vad som händer härnäst.</p>
            <div className="cr-pipeline">
              {stages.map((s, i) => (
                <PipelineStage key={s.key} stage={s} isLast={i === stages.length - 1} />
              ))}
            </div>
          </section>

          {/* Next recommended action */}
          <section className="cr-section cr-next">
            <h2 className="cr-section-title">Nästa rekommenderade åtgärd</h2>
            {nextAction ? (
              <div className="cr-next-card">
                <span className={`cr-prio cr-prio-${safeString(nextAction.priority, 'low')}`}>{safeString(nextAction.priority, 'low')}</span>
                <div>
                  <strong><SafeText value={nextAction.title || nextAction.title_sv} fallback="Fortsätt i paper-only" /></strong>
                  <p className="cr-soft"><SafeText value={nextAction.reason || nextAction.detail_sv} fallback="" /></p>
                </div>
              </div>
            ) : (
              <p className="cr-soft">Inget specifikt just nu — fortsätt köra paper-only-tester.</p>
            )}
          </section>

          {/* Current research status */}
          <section className="cr-section">
            <h2 className="cr-section-title">Vad händer just nu</h2>
            <div className="cr-now-grid">
              <div className="cr-now"><span className="cr-now-lbl">Senaste replay</span><span className="cr-now-val">{fmtTime(data.replayStatus && data.replayStatus.latestReplay && data.replayStatus.latestReplay.createdAt)}</span></div>
              <div className="cr-now"><span className="cr-now-lbl">Senaste batch</span><span className="cr-now-val">{fmtTime(data.batchStatus && data.batchStatus.latestBatch && (data.batchStatus.latestBatch.startedAt || data.batchStatus.latestBatch.createdAt))}</span></div>
              <div className="cr-now"><span className="cr-now-lbl">Learning</span><span className="cr-now-val"><SafeText value={data.learningStatus && data.learningStatus.narrowLearning && data.learningStatus.narrowLearning.status} fallback="—" /></span></div>
              <div className="cr-now"><span className="cr-now-lbl">AI-förslag</span><span className="cr-now-val">{num(data.aiRecommendations && Array.isArray(data.aiRecommendations.items) ? data.aiRecommendations.items.length : 0)}</span></div>
              <div className="cr-now"><span className="cr-now-lbl">Paper trading</span><span className="cr-now-val">{STATUS_LABEL[safeString(data.paperStatus && data.paperStatus.status, 'unknown')] || '—'}</span></div>
              <div className="cr-now"><span className="cr-now-lbl">Strategier</span><span className="cr-now-val">{num(data.strategyRanking && data.strategyRanking.activeStrategies)} aktiva</span></div>
            </div>
          </section>

          {/* Risks (compact) */}
          {Array.isArray(data.risks) && data.risks.length > 0 && (
            <section className="cr-section">
              <h2 className="cr-section-title">Risker systemet ser ({data.risks.length})</h2>
              <ul className="cr-risks">
                {data.risks.slice(0, 5).map((r, i) => (
                  <li key={i} className={`cr-risk cr-risk-${safeString(r && r.level, 'info')}`}>
                    <span className="cr-risk-lvl">{safeString(r && r.level, 'info')}</span>
                    <SafeText value={r && (r.message_sv || r.message)} fallback="" />
                  </li>
                ))}
              </ul>
              {data.risks.length > 5 && <Link to="/technical" className="cr-soft cr-more">Se alla risker i Technical →</Link>}
            </section>
          )}

          <p className="cr-foot">
            Genererad {fmtTime(data.generatedAt)} · {safeString(data.mode, 'paper_only')} · live_trading_enabled={String(data.live_trading_enabled)}
          </p>
        </>
      )}
    </div>
  );
}
