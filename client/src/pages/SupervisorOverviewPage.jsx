import React, { useEffect, useState } from 'react';
import './supervisorOverview.css';
import { SafeText, num } from '../utils/safeRender.js';

// Read-only Supervisor Overview page. Consumes GET /api/supervisor/overview.
// Standalone on purpose: it does not touch SupervisorBrainPage.jsx so parallel
// UI work stays untouched. No backend logic here — it only renders what the
// fault-isolated overview endpoint already aggregated.

const TERMS = [
  ['paper_only', 'Systemet simulerar och analyserar — det lägger aldrig riktiga order.'],
  ['winRate', 'Andel trades som blev vinst, där TIMEOUT räknas emot. Konservativ vy.'],
  ['decisiveWinRate', 'Vinstandel bara bland trades som faktiskt avgjordes (TIMEOUT exkluderad).'],
  ['TIMEOUT', 'Trade som stängdes av maxtid — varken ren vinst eller förlust.'],
  ['avgPnl', 'Genomsnittligt testresultat i procent. Positivt är bättre.'],
  ['narrow-only', 'Gäller bara Narrow State-strategier, inte hela systemet.'],
  ['system-wide', 'Gäller hela systemet, alla strategier.'],
];

function apiJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function ScopeBadge({ scope }) {
  if (!scope) return null;
  const narrow = scope === 'narrow_only';
  return <span className={`sov-scope ${narrow ? 'sov-scope-narrow' : 'sov-scope-wide'}`}>{narrow ? 'narrow-only' : 'system-wide'}</span>;
}

function StatusDot({ status }) {
  const map = { ok: 'sov-dot-ok', empty: 'sov-dot-empty', degraded: 'sov-dot-warn', error: 'sov-dot-err' };
  const label = { ok: 'OK', empty: 'Ingen data än', degraded: 'Delvis', error: 'Fel' }[status] || status;
  return <span className={`sov-dot ${map[status] || ''}`} title={label}>{label}</span>;
}

function Block({ icon, title, block, children }) {
  const status = block ? block.status : 'error';
  return (
    <section className="sov-block">
      <div className="sov-block-head">
        <h3>{icon} {title}</h3>
        <div className="sov-block-meta">
          <ScopeBadge scope={block && block.scope} />
          <StatusDot status={status} />
        </div>
      </div>
      {status === 'error' && (
        <p className="sov-soft">Kunde inte läsas just nu{block && block.error ? `: ${block.error}` : ''}. Andra block visas ändå.</p>
      )}
      {status === 'empty' && <p className="sov-soft">Ingen data än — kör fler tester.</p>}
      {(status === 'ok' || status === 'degraded') && children}
      {block && block.source && <p className="sov-source">Källa: {block.source}</p>}
    </section>
  );
}

export default function SupervisorOverviewPage() {
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

  const blocks = (data && data.blocks) || {};
  const cs = data && data.canonicalStats;
  const strat = blocks.strategies && blocks.strategies.summary;
  const narrow = blocks.narrow && blocks.narrow.summary;
  const ap = blocks.autopilot && blocks.autopilot.summary;
  const daily = blocks.daily_pipeline && blocks.daily_pipeline.summary;
  const sh = blocks.system_health && blocks.system_health.summary;
  const learn = blocks.learning && blocks.learning.summary;
  const opt = blocks.ai_optimization && blocks.ai_optimization.summary;
  const regime = blocks.market_regime && blocks.market_regime.summary;

  return (
    <div className="sov-page">
      <div className="sov-safety">
        🔒 PAPER ONLY · LIVE TRADING OFF · INGA RIKTIGA ORDER · endast analysläge, inte investeringsråd
      </div>

      <header className="sov-header">
        <h1>🧠 Supervisor — Systemöversikt</h1>
        <button className="sov-refresh" onClick={load} disabled={loading}>{loading ? 'Laddar…' : '↻ Uppdatera'}</button>
      </header>

      {error && <div className="sov-error">Kunde inte hämta översikten: {error}. (Endpointen finns först efter deploy av backend.)</div>}

      {data && (
        <>
          {/* Headline canonical numbers — the single source of truth */}
          <section className="sov-headline">
            <div className="sov-stat"><span className="sov-stat-num">{num(cs && cs.totalTrades)}</span><span className="sov-stat-lbl">Trades (testdata)</span></div>
            <div className="sov-stat"><span className="sov-stat-num">{num(cs && cs.winRate, '%')}</span><span className="sov-stat-lbl">winRate (TIMEOUT räknas emot)</span></div>
            <div className="sov-stat"><span className="sov-stat-num">{num(cs && cs.decisiveWinRate, '%')}</span><span className="sov-stat-lbl">decisiveWinRate (TIMEOUT exkluderad)</span></div>
            <div className="sov-stat"><span className="sov-stat-num">{num(cs && cs.avgPnl)}</span><span className="sov-stat-lbl">avgPnl</span></div>
          </section>
          <p className="sov-explain">
            Samma trades, två ärliga tal: skillnaden beror enbart på hur {num(cs && cs.timeoutRate, '%')} TIMEOUT räknas.
            Detta är testdata — ingen bevisad edge.
          </p>

          <div className="sov-grid">
            <Block icon="🟢" title="Systemstatus" block={blocks.system_health}>
              <p><strong><SafeText value={sh && sh.overallStatus} fallback="—" /></strong> — <SafeText value={sh && sh.summarySv} fallback="inga detaljer" /></p>
              <p className="sov-soft">{sh && num(sh.alertCount)} larm ({sh && num(sh.criticalAlerts)} kritiska), {sh && num(sh.componentCount)} komponenter.</p>
            </Block>

            <Block icon="🧠" title="Vad AI lärde sig" block={blocks.learning}>
              {learn && learn.canonicalPaperStats && (
                <p>Paper: {num(learn.canonicalPaperStats.totalTrades)} trades, winRate {num(learn.canonicalPaperStats.winRate, '%')} / decisive {num(learn.canonicalPaperStats.decisiveWinRate, '%')}.</p>
              )}
              {learn && learn.connectorSummary && (
                <p className="sov-soft">Lärt om {num(learn.connectorSummary.strategiesTracked)} strategier.</p>
              )}
            </Block>

            <Block icon="📈" title="Bästa strategier" block={blocks.strategies}>
              <ul className="sov-list">
                {strat && strat.top && strat.top.length ? strat.top.map((s, i) => (
                  <li key={`t-${i}`}><span><SafeText value={s.key} /></span><span className="sov-good">{num(s.winRate, '%')}</span><span className="sov-soft">{num(s.trades)} trades</span></li>
                )) : <li className="sov-soft">Ingen data än.</li>}
              </ul>
            </Block>

            <Block icon="📉" title="Sämsta strategier" block={blocks.strategies}>
              <ul className="sov-list">
                {strat && strat.worst && strat.worst.length ? strat.worst.map((s, i) => (
                  <li key={`w-${i}`}><span><SafeText value={s.key} /></span><span className="sov-bad">{num(s.winRate, '%')}</span><span className="sov-soft">{num(s.trades)} trades</span></li>
                )) : <li className="sov-soft">Ingen data än.</li>}
              </ul>
              <p className="sov-soft">Ingen auto-apply — ändringar görs manuellt i Trading Lab.</p>
            </Block>

            <Block icon="🔬" title="Pågående tester" block={blocks.autopilot}>
              <p>Autopilot: {ap && ap.schedulerActive ? 'aktiv' : 'vilande'} · {ap && ap.dryRunOnly ? 'DRY-RUN ONLY' : 'execute?'} · execute {ap && ap.executionEnabled ? 'PÅ' : 'av'}.</p>
              {ap && ap.nextRunAt && <p className="sov-soft">Nästa planering: {new Date(ap.nextRunAt).toLocaleString('sv-SE')}.</p>}
              {ap && ap.blockedReason && <p className="sov-soft">Pausorsak: <SafeText value={ap.blockedReason} />.</p>}
              {daily && <p className="sov-soft">Daglig pipeline: {daily.enabled ? 'på' : 'av'}{daily.lastStatus ? <> · senast <SafeText value={daily.lastStatus} /></> : ''}.</p>}
            </Block>

            <Block icon="🌍" title="Marknadsläge" block={blocks.market_regime}>
              <p><SafeText value={regime && regime.regime} fallback="okänt" /> {regime && regime.volatilityState ? <>· <SafeText value={regime.volatilityState} /></> : ''}</p>
              {regime && regime.biasSv && <p className="sov-soft"><SafeText value={regime.biasSv} /></p>}
            </Block>

            <Block icon="📊" title="AI-optimering" block={blocks.ai_optimization}>
              {opt && <p>Score {num(opt.overallScore)} · {num(opt.tradeCount)} trades · winRate {num(opt.winRatePct, '%')} · timeout {num(opt.timeoutRatePct, '%')}.</p>}
            </Block>

            <Block icon="📉" title="Narrow State" block={blocks.narrow}>
              {narrow && <p><SafeText value={narrow.status} fallback="—" /> · {num(narrow.totalTrades)} trades · tillit <SafeText value={narrow.dataConfidence} fallback="—" />.</p>}
              {narrow && narrow.bestStrategy && <p className="sov-soft">Bäst: <SafeText value={narrow.bestStrategy} /> (<SafeText value={narrow.bestScoreBand} fallback="—" />).</p>}
            </Block>
          </div>

          {/* Risks */}
          <section className="sov-block sov-risks">
            <h3>⚠ Risker</h3>
            <ul className="sov-list">
              {(Array.isArray(data.risks) ? data.risks : []).map((r, i) => (
                <li key={i} className={`sov-risk sov-risk-${r && r.level ? r.level : 'info'}`}><span className="sov-risk-lvl"><SafeText value={r && r.level} fallback="info" /></span><span><SafeText value={r && r.message_sv} /></span></li>
              ))}
            </ul>
          </section>

          {/* Action plan */}
          <section className="sov-block sov-plan">
            <h3>📋 Handlingsplan — vad fokusera på</h3>
            <ol className="sov-list">
              {(Array.isArray(data.actionPlan) ? data.actionPlan : []).map((p, i) => (
                <li key={i}><strong>[<SafeText value={p && p.priority} fallback="low" />] <SafeText value={p && p.title_sv} /></strong><br /><span className="sov-soft"><SafeText value={p && p.detail_sv} fallback="" /></span></li>
              ))}
            </ol>
          </section>

          {/* Beginner terms */}
          <section className="sov-block sov-terms">
            <h3>📖 Ordförklaringar</h3>
            <div className="sov-term-grid">
              {TERMS.map(([t, h]) => (<div key={t} className="sov-term"><strong>{t}</strong><span>{h}</span></div>))}
            </div>
          </section>

          <p className="sov-foot">Genererad {data.generatedAt ? new Date(data.generatedAt).toLocaleString('sv-SE') : '—'} · {data.mode} · live_trading_enabled={String(data.live_trading_enabled)}</p>
        </>
      )}
    </div>
  );
}
