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

const BEGINNER_TERMS = [
  ['paper_only', 'Simulering och analys. Inga riktiga order.'],
  ['dry-run', 'Systemet planerar och kontrollerar, men startar inget riktigt test.'],
  ['scheduler', 'Automatisk planering som körs med jämna mellanrum.'],
  ['execute avstängt', 'Systemet får inte starta batch- eller paper-körningar automatiskt.'],
  ['cooldown', 'Väntetid innan nästa automatiska planering.'],
  ['blocked reason', 'Förklarar varför systemet stoppade eller hoppade över något.'],
  ['winRate', 'Hur ofta testerna blev positiva.'],
  ['avgPnL', 'Genomsnittligt resultat i testdata.'],
  ['rekommenderat test', 'Nästa säkra research-test som systemet föreslår.'],
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

function timeText(iso) {
  if (!iso) return 'Saknas';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Saknas';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function schedulerRecommendationText(rec) {
  if (!rec) return null;
  const window = rec.dateWindowSelected || {};
  const band = rec.selectedNarrowScoreBand ? (BAND_LABELS[rec.selectedNarrowScoreBand] || rec.selectedNarrowScoreBand) : 'Band saknas';
  const windowText = window.dateFrom && window.dateTo ? `${window.dateFrom} - ${window.dateTo}` : 'Inget fönster valt';
  return {
    title: rec.strategy_id || 'Nästa narrow-test',
    band,
    windowText,
    reason: rec.reason || 'Systemet har planerat nästa säkra dry-run.',
  };
}

function BeginnerTerms() {
  return (
    <div className="ns-term-grid">
      {BEGINNER_TERMS.map(([term, help]) => (
        <div key={term} className="ns-term-card">
          <strong>{term}</strong>
          <span>{help}</span>
        </div>
      ))}
    </div>
  );
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
  const scheduler = ns?.narrowAutopilotScheduler || null;
  const schedulerRec = schedulerRecommendationText(scheduler?.lastRecommendedTest);
  const schedulerDryRun = scheduler?.lastScheduledDryRun || null;
  // Narrow Performance Learning (measured from paper/replay/batch). May be null.
  const perf = ns?.performanceLearning || null;
  const CONF_LABELS = { none: 'Ingen', low: 'Låg', medium: 'Medium', high: 'Hög' };
  const PERF_STATUS_LABELS = {
    needs_more_data: 'Behöver mer data',
    low_confidence: 'Låg säkerhet',
    ready: 'Redo för slutsatser',
  };

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
        <strong>Tryggt läge: Paper only.</strong>
        <span>Systemet simulerar och analyserar. Live trading, broker och riktiga order är avstängda.</span>
        <small>live_trading_enabled=false · can_place_orders=false · actions_allowed=false · broker_enabled=false</small>
      </div>

      <section className="ns-panel ns-beginner-guide">
        <h2>Snabbguide för nya användare</h2>
        <p>
          Den här sidan visar när marknaden är lugn och ihoptryckt. Systemet använder det för att
          planera säkra research-tester i paper/replay/batch, inte för att handla live.
        </p>
        <BeginnerTerms />
      </section>

      <section className="ns-panel ns-autopilot-scheduler">
        <div className="ns-autopilot-head">
          <div>
            <h2>Automatisk Narrow-planering</h2>
            <p>Schedulern letar efter nästa rimliga research-test. Den kör bara dry-run och kan inte lägga order.</p>
          </div>
          <Badge tone={scheduler?.schedulerActive ? 'green' : 'amber'}>
            {scheduler?.schedulerActive ? 'Automatisk planering aktiv' : 'Planering pausad'}
          </Badge>
        </div>
        <div className="ns-autopilot-grid">
          <div>
            <span>Endast dry-run</span>
            <strong>{scheduler?.dryRunOnly ? 'Ja, bara planering' : 'Kontrollera'}</strong>
          </div>
          <div>
            <span>Execute</span>
            <strong>{scheduler?.executionEnabled ? 'På' : 'Avstängt automatiskt'}</strong>
          </div>
          <div>
            <span>Senaste körning</span>
            <strong>{timeText(scheduler?.lastRunAt)}</strong>
          </div>
          <div>
            <span>Nästa körning</span>
            <strong>{timeText(scheduler?.nextRunAt)}</strong>
          </div>
          <div>
            <span>Cooldown</span>
            <strong>{scheduler?.cooldownActive ? `Aktiv till ${timeText(scheduler.cooldownUntil)}` : 'Inte aktiv'}</strong>
          </div>
          <div>
            <span>Safety</span>
            <strong>{scheduler?.mode || 'paper_only'}</strong>
          </div>
        </div>
        <div className="ns-autopilot-note">
          <strong>Senaste rekommenderade test:</strong>{' '}
          {schedulerRec
            ? `${schedulerRec.title} · ${schedulerRec.band} · ${schedulerRec.windowText}`
            : 'Ingen rekommendation sparad ännu. Det betyder bara att schedulern inte har hittat nästa tydliga test i sparad status.'}
          {schedulerRec?.reason ? <p>{schedulerRec.reason}</p> : null}
        </div>
        <div className="ns-simple-explainers">
          <span><strong>Dry-run</strong> = planerar och analyserar.</span>
          <span><strong>Execute avstängt</strong> = startar inte körningar automatiskt.</span>
          <span><strong>Blocked reason</strong> = varför systemet väntar eller stoppar.</span>
        </div>
        <div className="ns-badge-row">
          <Badge tone={schedulerDryRun?.dryRun ? 'green' : 'amber'}>dryRun={String(Boolean(schedulerDryRun?.dryRun))}</Badge>
          <Badge tone={!schedulerDryRun?.executed ? 'green' : 'amber'}>executed={String(Boolean(schedulerDryRun?.executed))}</Badge>
          <Badge tone={scheduler?.blockedReason ? 'amber' : 'green'}>blockedReason={scheduler?.blockedReason || 'Ingen'}</Badge>
          <Badge tone="green">paper_only</Badge>
        </div>
      </section>

      {/* What is Narrow State? — beginner explainer */}
      <section className="ns-panel ns-explainer">
        <h2>Vad är Narrow State?</h2>
        <p>
          Narrow State betyder att priset rör sig i ett <strong>trångt, lugnt</strong> intervall — det
          trycks ihop (compression). Efter en sådan period brukar något hända: ett{' '}
          <strong>breakout</strong> (priset bryter ut), ett <strong>fakeout</strong> (falskt utbrott
          som vänder), eller en <strong>mean reversion</strong> (återgång mot mitten/VWAP).
        </p>
        <p>
          Om listorna är tomma är det inte ett fel. Det betyder oftast att marknaden inte är tillräckligt
          ihoptryckt just nu eller att systemet väntar på mer testdata.
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
          Inga symboler i Narrow State just nu. Det är normalt: systemet väntar på att marknaden blir
          lugn och ihoptryckt nog för att vara intressant. Inga tester eller order startas härifrån.
        </p>
      ) : null}

      <div className="ns-columns">
        <section className="ns-panel">
          <h2>📉 Narrow State just nu</h2>
          {topSymbols.length === 0
            ? <p className="ns-empty">Inga symboler är tillräckligt lugna och ihoptryckta just nu.</p>
            : topSymbols.map((s, i) => <SymbolRow key={s?.symbol || i} item={s} />)}
        </section>

        <section className="ns-panel">
          <h2>🚀 Nära breakout</h2>
          {breakoutWatch.length === 0
            ? <p className="ns-empty">Inga tydliga utbrottskandidater. Systemet väntar.</p>
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
            ? <p className="ns-empty">Inga tydliga falska utbrott att bevaka just nu.</p>
            : fakeoutRisk.map((s, i) => <SymbolRow key={s?.symbol || i} item={s} />)}
        </section>

        <section className="ns-panel">
          <h2>🔄 Återgång mot VWAP</h2>
          {meanReversion.length === 0
            ? <p className="ns-empty">Inga tydliga återgångar mot mitten/VWAP just nu.</p>
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
          {strategies.length === 0 ? <p className="ns-empty">Strategier saknas i API-svaret just nu. Sidan fortsätter fungera i read-only-läge.</p> : null}
        </div>
      </section>

      {/* Learning */}
      {/* Performance Learning — measured testresultat (paper/replay/batch) */}
      <section className="ns-panel ns-perf">
        <h2>📈 Performance Learning <span className="ns-perf-tag">testresultat · endast analysläge</span></h2>
        <p className="ns-perf-note">
          Mätt på paper-/replay-/batch-tester av de tre narrow-strategierna. Detta är{' '}
          <strong>inte investeringsråd</strong> — bara vad testresultaten visar hittills.
        </p>

        {!perf || perf.totalNarrowTrades === 0 ? (
          <div className="ns-empty-wide">
            <p>{perf?.message || 'Systemet har ännu för lite Narrow State-data för säker slutsats.'}</p>
            <p>Mer paper-/replay-/batch-data behövs innan winRate och avgPnL går att tolka på ett rimligt sätt.</p>
            <div className="ns-badge-row" style={{ marginTop: 10 }}>
              {perf?.status ? <Badge tone="amber">Status: {PERF_STATUS_LABELS[perf.status] || perf.status}</Badge> : null}
              <Badge tone="amber">Datatillit: {CONF_LABELS[perf?.dataConfidence] || 'Ingen'}</Badge>
              <Badge tone="green">Paper Only</Badge>
            </div>
          </div>
        ) : (
          <>
            <div className="ns-badge-row">
              {perf?.status ? <Badge tone={perf.status === 'ready' ? 'green' : 'amber'}>Status: {PERF_STATUS_LABELS[perf.status] || perf.status}</Badge> : null}
              <Badge tone={perf.dataConfidence === 'high' ? 'green' : 'amber'}>
                Datatillit: {CONF_LABELS[perf.dataConfidence] || perf.dataConfidence}
              </Badge>
              <Badge tone="blue">{perf.totalNarrowTrades} testresultat</Badge>
            </div>
            <div className="ns-learn-grid">
              <div>
                <h4>📊 Bästa narrow-strategi</h4>
                {perf.bestStrategy
                  ? <p>{perf.bestStrategy.name} — vinst {perf.bestStrategy.winRate ?? '—'}% ({perf.bestStrategy.trades} tester){perf.dataConfidence === 'low' ? ', men datatilliten är låg' : ''}.</p>
                  : <p className="ns-empty">Ingen tydlig vinnare ännu.</p>}
                <h4>📉 Sämsta narrow-strategi</h4>
                {perf.worstStrategy
                  ? <p>{perf.worstStrategy.name} — vinst {perf.worstStrategy.winRate ?? '—'}% ({perf.worstStrategy.trades} tester).</p>
                  : <p className="ns-empty">För lite data.</p>}
                <h4>🎯 Bästa score-intervall</h4>
                {perf.bestScoreBand
                  ? <p>{perf.bestScoreBand.scoreRange} ({perf.bestScoreBand.band}) — vinst {perf.bestScoreBand.winRate ?? '—'}%.</p>
                  : <p className="ns-empty">För lite data för score-band.</p>}
              </div>
              <div>
                <h4>🔎 Bekräftelse som hjälper mest</h4>
                {perf.strongestConfirmation
                  ? <p>{perf.strongestConfirmation.confirmation.toUpperCase()}-bekräftelse: {perf.strongestConfirmation.withWinRate ?? '—'}% med vs {perf.strongestConfirmation.withoutWinRate ?? '—'}% utan.</p>
                  : <p className="ns-empty">Ingen bekräftelse har tillräcklig data ännu.</p>}
                <h4>📋 Nästa rekommenderade test</h4>
                {perf.recommendedNextTest
                  ? <p><strong>{perf.recommendedNextTest.title}</strong> — {perf.recommendedNextTest.reason}</p>
                  : <p className="ns-empty">Ingen rekommendation ännu.</p>}
              </div>
            </div>
          </>
        )}
      </section>

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
              : <p className="ns-empty">Ingen learning-data ännu. Systemet behöver fler säkra testresultat.</p>}
            <h4>📉 Sämsta narrow-strategi</h4>
            {ns?.worstStrategy
              ? <p>{ns.worstStrategy.label} — vinst {Math.round((ns.worstStrategy.win_rate || 0) * 100)}% ({ns.worstStrategy.closed} trades)</p>
              : <p className="ns-empty">Ingen learning-data ännu.</p>}
          </div>
          <div>
            <h4>📋 Nästa rekommenderade test</h4>
            {ns?.recommendedNextTest
              ? <p>{ns.recommendedNextTest.reason_sv}</p>
              : <p className="ns-empty">Ingen rekommendation ännu. Det är normalt när data saknas eller är för svag.</p>}
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
