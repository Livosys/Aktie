import React from 'react';
import { useScan } from '../hooks.js';
import SimpleStatusCard from '../components/tradingos/SimpleStatusCard.jsx';

// Narrow State Lab — Narrow State-first overview, beginner-friendly.
// Read-only. Consumes GET /api/supervisor/narrow-state. Never trades.

const BAND_LABELS = {
  strong_compression: 'Stark compression',
  confirmed_narrow: 'Bekräftad narrow',
  weak_narrow: 'Svag narrow',
  not_narrow: 'Ej narrow',
};

const REGIME_LABELS = {
  narrow: 'Narrow',
  narrow_breakout_watch: 'Breakout Watch',
  narrow_fakeout_risk: 'Fakeout Risk',
  narrow_mean_reversion: 'Mean Reversion',
  trending: 'Trend',
  volatile: 'Volatil',
  unclear: 'Oklart',
};

// Friendly, plain-Swedish names for the three narrow-state strategies.
const STRATEGY_FRIENDLY = {
  narrow_breakout_v1: {
    name: 'Breakout efter trång marknad',
    desc: 'När marknaden varit lugn och ihoptryckt testar systemet utbrottet uppåt eller nedåt.',
    badge: 'Breakout Watch',
    tone: 'green',
  },
  narrow_fakeout_reversal_v1: {
    name: 'Falskt breakout och vändning',
    desc: 'Priset bryter ut men lurar marknaden och vänder snabbt tillbaka in i lugnzonen.',
    badge: 'Fakeout Risk',
    tone: 'amber',
  },
  narrow_vwap_mean_reversion_v1: {
    name: 'Återgång mot VWAP',
    desc: 'Priset köps nära kanten av lugnzonen och siktar på att återgå mot mitten/VWAP.',
    badge: 'Mean Reversion',
    tone: 'blue',
  },
};

// What the Learning Engine is meant to answer over time.
const LEARNING_QUESTIONS = [
  'Vilket narrowScore-intervall ger bäst resultat?',
  'Hjälper volymbekräftelse?',
  'Hjälper VWAP-bekräftelse?',
  'Fungerar breakout eller fakeout bäst?',
  'Vilken timeframe fungerar bäst?',
];

function regimeTone(regime) {
  if (regime === 'narrow_breakout_watch') return 'green';
  if (regime === 'narrow_fakeout_risk') return 'amber';
  if (regime === 'narrow_mean_reversion') return 'blue';
  return 'blue';
}

function Badge({ tone = 'blue', children }) {
  return <span className={`ns-badge ns-badge-${tone}`}>{children}</span>;
}

function SymbolRow({ item }) {
  return (
    <div className="ns-row">
      <span className="ns-row-sym">{item?.symbol || '—'}</span>
      <Badge tone={regimeTone(item?.regimeLabel)}>
        {REGIME_LABELS[item?.regimeLabel] || item?.regimeLabel || '—'}
      </Badge>
      <span className="ns-row-score">{item?.narrowScore ?? '—'}</span>
      <span className="ns-row-band">{BAND_LABELS[item?.band] || item?.band || ''}</span>
    </div>
  );
}

export default function NarrowStateLabPage() {
  const { data, loading, error } = useScan('/api/supervisor/narrow-state');
  const ns = data?.narrowState || null;

  // Safe accessors — never assume arrays/objects exist.
  const topSymbols = Array.isArray(ns?.topSymbols) ? ns.topSymbols : [];
  const breakoutWatch = Array.isArray(ns?.breakoutWatch) ? ns.breakoutWatch : [];
  const fakeoutRisk = Array.isArray(ns?.fakeoutRisk) ? ns.fakeoutRisk : [];
  const meanReversion = Array.isArray(ns?.meanReversion) ? ns.meanReversion : [];
  const strategies = Array.isArray(ns?.strategies) ? ns.strategies : [];
  const latestLessons = Array.isArray(ns?.latestLessons) ? ns.latestLessons : [];

  return (
    <div className="page narrow-state-lab">
      <header className="page-head">
        <h1>📉 Narrow State Lab</h1>
        <p className="page-sub">
          Marknaden rör sig trångt. Systemet letar efter compression före breakout, fakeout eller mean reversion.
        </p>
      </header>

      {/* Safety banner — always shows the locked state */}
      <div className="ns-safety-banner">
        🟢 Paper Only · live_trading_enabled=false · can_place_orders=false · actions_allowed=false · broker_enabled=false
      </div>

      {/* What is Narrow State? — beginner explainer */}
      <section className="ns-panel ns-explainer">
        <h2>Vad är Narrow State?</h2>
        <p>
          Narrow State betyder att priset rör sig i ett <strong>trångt, lugnt</strong> intervall — det
          trycks ihop (compression). Efter en sådan period brukar något hända: ett{' '}
          <strong>breakout</strong> (priset bryter ut), ett <strong>fakeout</strong> (falskt utbrott
          som vänder), eller en <strong>mean reversion</strong> (återgång mot mitten/VWAP).
        </p>
        <div className="ns-badge-row">
          <Badge tone="blue">Compression</Badge>
          <Badge tone="green">Breakout Watch</Badge>
          <Badge tone="amber">Fakeout Risk</Badge>
          <Badge tone="blue">Mean Reversion</Badge>
          <Badge tone="green">Paper Only</Badge>
        </div>
      </section>

      {error ? <div className="ns-error">{error.message}</div> : null}
      {loading && !ns ? <div className="ns-loading">Laddar Narrow State…</div> : null}

      {/* Dagens status — works even when the arrays are empty */}
      <section className="tr-status-grid">
        <SimpleStatusCard
          icon="📉"
          title="Narrow just nu"
          summary={`Score ≥ ${ns?.minScore ?? 60} på ${ns?.timeframe ?? '2m'}`}
          value={`${ns?.activeCount ?? 0} / ${ns?.scannedCount ?? 0}`}
          tone="blue"
        />
        <SimpleStatusCard
          icon="🧲"
          title="Stark compression"
          summary="Score ≥ 80"
          value={ns?.strongCompressionCount ?? 0}
          tone="green"
        />
        <SimpleStatusCard
          icon="🚀"
          title="Nära breakout"
          summary="Bevakas för utbrott"
          value={breakoutWatch.length}
          tone="green"
        />
        <SimpleStatusCard
          icon="⚠️"
          title="Fakeout-risk"
          summary="Falskt utbrott möjligt"
          value={fakeoutRisk.length}
          tone="amber"
        />
      </section>

      {ns && topSymbols.length === 0 && breakoutWatch.length === 0 && fakeoutRisk.length === 0 ? (
        <p className="ns-empty ns-empty-wide">
          Inga symboler i Narrow State just nu. Det är normalt — systemet väntar på att marknaden
          trycks ihop. Vyn uppdateras automatiskt.
        </p>
      ) : null}

      <div className="ns-columns">
        <section className="ns-panel">
          <h2>📉 Narrow State just nu</h2>
          {topSymbols.length === 0
            ? <p className="ns-empty">Inga symboler i narrow state just nu.</p>
            : topSymbols.map((s, i) => <SymbolRow key={s?.symbol || i} item={s} />)}
        </section>

        <section className="ns-panel">
          <h2>🚀 Nära breakout</h2>
          {breakoutWatch.length === 0
            ? <p className="ns-empty">Inga breakout-kandidater.</p>
            : breakoutWatch.map((s, i) => (
                <div className="ns-row" key={s?.symbol || i}>
                  <span className="ns-row-sym">{s?.symbol || '—'}</span>
                  <span className="ns-row-score">{s?.narrowScore ?? '—'}</span>
                  <span className="ns-row-band">L {s?.longTrigger ?? '—'} / S {s?.shortTrigger ?? '—'}</span>
                </div>
              ))}
        </section>

        <section className="ns-panel">
          <h2>⚠️ Fakeout-risk</h2>
          {fakeoutRisk.length === 0
            ? <p className="ns-empty">Inga fakeout-risker.</p>
            : fakeoutRisk.map((s, i) => <SymbolRow key={s?.symbol || i} item={s} />)}
        </section>

        <section className="ns-panel">
          <h2>🔄 Återgång mot VWAP</h2>
          {meanReversion.length === 0
            ? <p className="ns-empty">Inga mean reversion-kandidater.</p>
            : meanReversion.map((s, i) => (
                <div className="ns-row" key={s?.symbol || i}>
                  <span className="ns-row-sym">{s?.symbol || '—'}</span>
                  <span className="ns-row-score">{s?.narrowScore ?? '—'}</span>
                  <span className="ns-row-band">VWAP {s?.vwap ?? '—'} · mid {s?.rangeMid ?? '—'}</span>
                </div>
              ))}
        </section>
      </div>

      {/* Strategier — friendly names */}
      <section className="ns-panel">
        <h2>🔬 Tre Narrow State-strategier (paper/replay/batch)</h2>
        <div className="ns-strats">
          {strategies.map((s, i) => {
            const friendly = STRATEGY_FRIENDLY[s?.id] || { name: s?.name, desc: '', badge: 'Paper Only', tone: 'blue' };
            return (
              <div className="ns-strat" key={s?.id || i}>
                <div className="ns-strat-top">
                  <strong>{friendly.name}</strong>
                  <Badge tone={friendly.tone}>{friendly.badge}</Badge>
                </div>
                {friendly.desc ? <p className="ns-strat-desc">{friendly.desc}</p> : null}
                <span className="ns-strat-meta">{s?.id} · live={String(s?.live_enabled)}</span>
                <Badge tone="green">Paper Only</Badge>
              </div>
            );
          })}
          {strategies.length === 0 ? <p className="ns-empty">Strategier laddas…</p> : null}
        </div>
      </section>

      {/* Learning */}
      <section className="ns-panel ns-learning">
        <h2>🧠 Vad systemet ska lära sig</h2>
        <ul className="ns-learn-questions">
          {LEARNING_QUESTIONS.map((q) => <li key={q}>{q}</li>)}
        </ul>
        <div className="ns-learn-grid">
          <div>
            <h4>📊 Bästa narrow-strategi</h4>
            {ns?.bestStrategy
              ? <p>{ns.bestStrategy.label} — vinst {Math.round((ns.bestStrategy.win_rate || 0) * 100)}% ({ns.bestStrategy.closed} trades)</p>
              : <p className="ns-empty">Ingen learning-data ännu — kör fler paper/replay-tester.</p>}
            <h4>📉 Sämsta narrow-strategi</h4>
            {ns?.worstStrategy
              ? <p>{ns.worstStrategy.label} — vinst {Math.round((ns.worstStrategy.win_rate || 0) * 100)}% ({ns.worstStrategy.closed} trades)</p>
              : <p className="ns-empty">Ingen learning-data ännu.</p>}
          </div>
          <div>
            <h4>📋 Nästa rekommenderade test</h4>
            {ns?.recommendedNextTest
              ? <p>{ns.recommendedNextTest.reason_sv}</p>
              : <p className="ns-empty">Ingen rekommendation ännu.</p>}
            <h4>💡 Senaste lärdomar</h4>
            {latestLessons.length === 0
              ? <p className="ns-empty">Inga lärdomar ännu.</p>
              : <ul>{latestLessons.map((l, i) => <li key={i}>{typeof l === 'string' ? l : (l?.text || l?.label || JSON.stringify(l))}</li>)}</ul>}
          </div>
        </div>
      </section>
    </div>
  );
}
