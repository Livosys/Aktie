import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SectionHeader } from '../shared.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '–';
  const ms = new Date(endIso) - new Date(startIso);
  if (ms < 0) return '–';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function calcDurationMs(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso) - new Date(startIso);
  return ms >= 0 ? ms : null;
}

function sumCandlesSaved(backfillBySymbol) {
  if (!backfillBySymbol) return 0;
  return Object.values(backfillBySymbol).reduce((acc, v) => acc + (v.candles2m || 0), 0);
}

function countStepErrors(steps) {
  if (!steps) return 0;
  return Object.values(steps).filter(s => s && s.ok === false).length;
}

function countSymbolErrors(backfillBySymbol) {
  if (!backfillBySymbol) return 0;
  return Object.values(backfillBySymbol).filter(v => v.error).length;
}

// ── Status data hook ──────────────────────────────────────────────────────────

function useMachineStatus(pollingActive) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const timerRef = useRef(null);

  const fetch_ = useCallback(async () => {
    try {
      const res  = await fetch('/api/system/auto-machine-status');
      const json = res.ok ? await res.json() : null;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => { fetch_(); }, [fetch_]);

  // Poll while pollingActive OR while the API says running=true
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollingActive || !!data?.running) {
      timerRef.current = setInterval(fetch_, 5000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [pollingActive, data, fetch_]);

  return { data, loading, error, refresh: fetch_ };
}

// ── Pipeline step definitions ─────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { key: 'backfill',           icon: '📥', label: 'Backfill',          desc: 'Hämtar historiska candles via Alpaca & Binance' },
  { key: 'replay',             icon: '▶️', label: 'Replay',            desc: 'Spelar upp candles genom hela signalpipelinen' },
  { key: 'huntSignals',        icon: '🎯', label: 'Hunt signals',      desc: 'Hittar och sparar intressanta signaler' },
  { key: 'analyzeOutcomes',    icon: '📊', label: 'Analyze outcomes',  desc: 'Analyserar vad som hände efter varje signal' },
  { key: 'updateLearning',     icon: '🧠', label: 'Update learning',   desc: 'Uppdaterar learning-summary med ny statistik' },
  { key: 'buildRuleMemory',    icon: '🎓', label: 'Rule Memory',       desc: 'Bygger regelminne — vilka blockerade signaler som fortsatte starkt' },
  { key: 'buildSymbolProfiles',icon: '🧬', label: 'Symbol Profiles',   desc: 'Bygger per-symbol beteendeprofiler (win rate, justeringar)' },
  { key: 'buildRegimeProfiles',icon: '📊', label: 'Regime Profiles',   desc: 'Bygger per-marknadsregim profiler (historisk träffsäkerhet)' },
  { key: 'invalidateCaches',   icon: '⚡', label: 'Refresh cache',     desc: 'Rensar historicalEdge- och adaptive-cachen' },
];

// ── Step status indicator ─────────────────────────────────────────────────────

function stepStatus(stepKey, steps, isRunning, currentStepIdx) {
  if (!steps) return 'idle';
  const stepIdx = PIPELINE_STEPS.findIndex(s => s.key === stepKey);
  if (steps[stepKey] === undefined) {
    // Not run yet
    if (isRunning && stepIdx >= currentStepIdx) return 'pending';
    return 'idle';
  }
  if (steps[stepKey]?.ok === false) return 'error';
  return 'ok';
}

function guessCurrentStep(steps) {
  if (!steps) return 0;
  let last = 0;
  PIPELINE_STEPS.forEach((s, i) => {
    if (steps[s.key] !== undefined) last = i + 1;
  });
  return last;
}

function StepBadge({ status }) {
  if (status === 'ok')      return <span className="mc-step-badge mc-step-ok">✓</span>;
  if (status === 'error')   return <span className="mc-step-badge mc-step-err">✗</span>;
  if (status === 'pending') return <span className="mc-step-badge mc-step-pending"><span className="spinner mc-spinner" /></span>;
  return <span className="mc-step-badge mc-step-idle">–</span>;
}

function StepDetail({ stepKey, steps }) {
  const s = steps?.[stepKey];
  if (!s) return null;

  if (stepKey === 'backfill' && s.bySymbol) {
    const total2m = sumCandlesSaved(s.bySymbol);
    const symErrs = countSymbolErrors(s.bySymbol);
    return (
      <span className="mc-step-detail">
        {total2m.toLocaleString('sv')} candles
        {symErrs > 0 && <span className="mc-step-detail-warn"> · {symErrs} symfel</span>}
      </span>
    );
  }
  if (stepKey === 'replay')      return <span className="mc-step-detail">{(s.totalEvents ?? 0).toLocaleString('sv')} events</span>;
  if (stepKey === 'huntSignals') return <span className="mc-step-detail">{(s.totalSignals ?? 0).toLocaleString('sv')} signaler</span>;
  if (stepKey === 'analyzeOutcomes') return <span className="mc-step-detail">{(s.processed ?? 0).toLocaleString('sv')} utfall</span>;
  if (stepKey === 'buildRuleMemory')     return <span className="mc-step-detail">{(s.totalRules ?? 0).toLocaleString('sv')} regler · {s.watchModeRules ?? 0} watch</span>;
  if (stepKey === 'buildSymbolProfiles') return <span className="mc-step-detail">{s.totalSymbols ?? 0} symboler · {s.highConfSymbols ?? 0} hög konfidenz</span>;
  if (stepKey === 'buildRegimeProfiles') return <span className="mc-step-detail">{s.totalRegimes ?? 0} regimer · bäst: {s.bestRegime ?? '–'}</span>;
  if (s.error) return <span className="mc-step-detail mc-step-detail-err">{s.error}</span>;
  return null;
}

// ── Pipeline visualization ────────────────────────────────────────────────────

function PipelineSteps({ steps, isRunning }) {
  const currentIdx = isRunning ? guessCurrentStep(steps) : -1;

  return (
    <div className="mc-pipeline">
      {PIPELINE_STEPS.map((step, idx) => {
        const status = stepStatus(step.key, steps, isRunning, currentIdx);
        const isActive = isRunning && status === 'pending' && idx === currentIdx;

        return (
          <div key={step.key} className={`mc-step${isActive ? ' mc-step-active' : ''}`}>
            <div className="mc-step-left">
              <span className="mc-step-icon">{step.icon}</span>
              <div className="mc-step-info">
                <span className="mc-step-label">{step.label}</span>
                <span className="mc-step-desc">{step.desc}</span>
              </div>
            </div>
            <div className="mc-step-right">
              <StepDetail stepKey={step.key} steps={steps} />
              <StepBadge status={status} />
            </div>
            {idx < PIPELINE_STEPS.length - 1 && (
              <div className={`mc-step-connector${status === 'ok' ? ' mc-connector-ok' : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function StatCard({ icon, val, label, color }) {
  return (
    <div className="mc-stat-card">
      <div className="mc-stat-icon">{icon}</div>
      <div className="mc-stat-val" style={color ? { color } : {}}>
        {val ?? '–'}
      </div>
      <div className="mc-stat-label">{label}</div>
    </div>
  );
}

function ResultStats({ result }) {
  if (!result) return null;
  const steps      = result.steps || {};
  const candles    = sumCandlesSaved(steps.backfill?.bySymbol);
  const events     = steps.replay?.totalEvents ?? 0;
  const signals    = steps.huntSignals?.totalSignals ?? 0;
  const outcomes   = steps.analyzeOutcomes?.processed ?? 0;
  const stepErrors = countStepErrors(steps);
  const durationMs = calcDurationMs(result.startedAt, result.finishedAt);
  const durSec     = durationMs != null ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div className="mc-stat-strip">
      <StatCard icon="🕯️" val={candles.toLocaleString('sv')} label="Candles sparade"   color="var(--blue)" />
      <StatCard icon="▶️" val={events.toLocaleString('sv')}   label="Replay events"     color="var(--green)" />
      <StatCard icon="🎯" val={signals.toLocaleString('sv')}  label="Signaler hittade"  color="var(--yellow)" />
      <StatCard icon="📊" val={outcomes.toLocaleString('sv')} label="Utfall analyserade" color="var(--purple)" />
      <StatCard icon="⏱️" val={durSec ? `${durSec} s` : '–'} label="Körtid" />
      <StatCard
        icon={stepErrors === 0 ? '✅' : '⚠️'}
        val={stepErrors === 0 ? 'OK' : stepErrors}
        label={stepErrors === 0 ? 'Inga fel' : 'Stegfel'}
        color={stepErrors === 0 ? 'var(--green)' : 'var(--orange)'}
      />
    </div>
  );
}

// ── Run form ──────────────────────────────────────────────────────────────────

function RunForm({ isRunning, onTriggered }) {
  const [stocks,     setStocks]     = useState(true);
  const [crypto,     setCrypto]     = useState(true);
  const [lookback,   setLookback]   = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const groups = [];
    if (stocks) groups.push('stocks');
    if (crypto) groups.push('crypto');
    if (groups.length === 0) { setError('Välj minst en grupp (Aktier eller Krypto).'); return; }

    setSubmitting(true);
    try {
      const res  = await fetch('/api/system/run-auto-machine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lookbackDays: lookback, groups }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt serverfel');
      setSuccess(true);
      onTriggered();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const busy = isRunning || submitting;

  return (
    <div className="mc-run-form">
      <div className="mc-run-form-title">Kör maskinen manuellt</div>

      {isRunning && (
        <div className="mc-running-banner">
          <span className="spinner" style={{ width: 14, height: 14 }} />
          Maskinen kör redan. Vänta tills den är klar.
        </div>
      )}

      <form onSubmit={handleSubmit} className="mc-form-body">
        <div className="mc-form-row">
          <div className="mc-form-group">
            <span className="mc-form-label">Grupper</span>
            <div className="mc-checkboxes">
              <label className={`mc-checkbox${stocks ? ' mc-cb-active' : ''}`}>
                <input type="checkbox" checked={stocks} onChange={e => setStocks(e.target.checked)} disabled={busy} />
                <span>📈 Aktier</span>
                <span className="mc-cb-hint">NVDA AMD TSLA AAPL MSFT AMZN META QQQ</span>
              </label>
              <label className={`mc-checkbox${crypto ? ' mc-cb-active' : ''}`}>
                <input type="checkbox" checked={crypto} onChange={e => setCrypto(e.target.checked)} disabled={busy} />
                <span>₿ Krypto</span>
                <span className="mc-cb-hint">BTCUSDT ETHUSDT SOLUSDT</span>
              </label>
            </div>
          </div>

          <div className="mc-form-group">
            <span className="mc-form-label">Historik (dagar tillbaka)</span>
            <div className="mc-lookback-options">
              {[1, 3, 7, 30].map(d => (
                <button
                  key={d}
                  type="button"
                  className={`mc-lb-btn${lookback === d ? ' mc-lb-active' : ''}`}
                  onClick={() => setLookback(d)}
                  disabled={busy}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mc-form-actions">
          <button
            className={`mc-run-btn${busy ? ' mc-run-btn-busy' : ''}`}
            type="submit"
            disabled={busy}
          >
            {submitting
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Startar…</>
              : isRunning
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Kör redan…</>
              : '🤖 Kör maskinen nu'}
          </button>

          {success && !isRunning && (
            <span className="mc-form-ok">✓ Maskin startad — polling aktiv</span>
          )}
        </div>

        {error && <div className="mc-form-error">✗ {error}</div>}
      </form>
    </div>
  );
}

// ── Scheduler status hook ─────────────────────────────────────────────────────

function useSchedulerStatus() {
  const [sched, setSched]   = useState(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res  = await fetch('/api/system/scheduler-status');
      const json = res.ok ? await res.json() : null;
      setSched(json);
    } catch (_) {
      setSched(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);
  return { sched, loading, refresh: fetch_ };
}

// ── Scheduler panel ───────────────────────────────────────────────────────────

function fmtTimeShort(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function SchedulerPanel({ sched }) {
  if (!sched) return null;

  const active  = sched.schedulerActive;
  const enabled = sched.enabled;

  return (
    <div className="mc-sched-panel">
      <div className="mc-sched-header">
        <span className="mc-sched-title">⏰ Scheduler</span>
        <span className={`mc-sched-pill ${active ? 'mc-sched-on' : 'mc-sched-off'}`}>
          {active ? '● Aktiv' : '○ Avstängd'}
        </span>
      </div>

      {!enabled && (
        <div className="mc-sched-warn">
          ⚠ Scheduler är avstängd — sätt <code>AUTO_MACHINE_ENABLED=true</code> i .env för att aktivera automatiska körningar.
        </div>
      )}
      {enabled && active && (
        <div className="mc-sched-ok">
          ✓ Scheduler är aktiv och kör automatiskt var {sched.intervalMinutes} min.
        </div>
      )}

      <div className="mc-sched-grid">
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Interval</span>
          <span className="mc-sched-item-val">{sched.intervalMinutes} min</span>
        </div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Lookback</span>
          <span className="mc-sched-item-val">{sched.lookbackDays} dagar</span>
        </div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Grupper</span>
          <span className="mc-sched-item-val">{(sched.groups || []).join(', ') || '–'}</span>
        </div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Nästa körning</span>
          <span className="mc-sched-item-val">
            {active && sched.nextRunEstimate
              ? fmtTimeShort(sched.nextRunEstimate)
              : '–'}
          </span>
        </div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Pipeline kör nu</span>
          <span className="mc-sched-item-val" style={{ color: sched.running ? 'var(--yellow)' : 'var(--muted)' }}>
            {sched.running ? 'Ja' : 'Nej'}
          </span>
        </div>
      </div>

      <div className="mc-sched-env-note">
        Styrs av <code>AUTO_MACHINE_ENABLED</code> · <code>AUTO_MACHINE_INTERVAL_MINUTES</code> · <code>AUTO_MACHINE_LOOKBACK_DAYS</code> · <code>AUTO_MACHINE_GROUPS</code> i .env
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MachinePage() {
  const [triggered, setTriggered] = useState(false);

  const { data, loading, error: fetchError, refresh } = useMachineStatus(triggered);
  const { sched, refresh: refreshSched } = useSchedulerStatus();

  useEffect(() => {
    if (triggered && data && !data.running) {
      setTriggered(false);
    }
  }, [triggered, data]);

  const isRunning  = !!data?.running;
  const status     = data?.status || null;
  const lastResult = status?.lastResult || null;
  const steps      = lastResult?.steps || null;
  const config     = data?.config || {};

  const lastRunAt = status?.startedAt ? fmtDateTime(status.startedAt) : null;
  const duration  = status?.startedAt && status?.finishedAt
    ? fmtDuration(status.startedAt, status.finishedAt)
    : null;

  function handleTriggered() {
    setTriggered(true);
    refresh();
    refreshSched();
  }

  return (
    <div>
      {/* Hero */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">
            <span style={{ color: 'var(--blue)' }}>🤖 Auto</span>
            <span style={{ color: 'var(--text)' }}> Machine</span>
          </div>
          <div className="hero-sub">
            Maskinen hämtar data, spelar upp historik och lär sig vilka signaler som fungerade.
          </div>
        </div>
        <div className="status-bar-v2">
          {isRunning ? (
            <span className="status-pill s-scan">
              <span className="spinner" style={{ width: 10, height: 10 }} />
              Kör pipeline…
            </span>
          ) : (
            <span className="status-pill s-ok">● Redo</span>
          )}
          {sched?.schedulerActive
            ? <span className="status-pill" style={{ color: 'var(--green)', borderColor: 'var(--green-border)', background: 'var(--green-dim)' }}>⏰ Schema aktivt · var {sched.intervalMinutes} min</span>
            : <span className="status-pill" style={{ color: 'var(--orange)', borderColor: 'var(--orange-border)', background: 'var(--orange-dim)' }}>⚠ Schema: avstängd</span>
          }
          <button className="btn" onClick={() => { refresh(); refreshSched(); }} style={{ fontSize: 11, padding: '3px 10px' }}>↻</button>
        </div>
      </div>

      {fetchError && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Kunde inte hämta status: {fetchError}
        </div>
      )}

      {loading && !data && (
        <div className="empty"><span className="spinner" /> Hämtar status…</div>
      )}

      {data && (
        <>
          {/* Status overview */}
          <div className="mc-status-row">
            <div className="mc-status-card">
              <div className="mc-status-card-label">Status</div>
              <div className={`mc-status-card-val ${isRunning ? 'mc-status-running' : 'mc-status-idle'}`}>
                {isRunning
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Kör…</>
                  : lastResult?.ok === false ? '✗ Senaste fel'
                  : lastResult ? '✓ Klar'
                  : '– Ej körts'}
              </div>
            </div>

            <div className="mc-status-card">
              <div className="mc-status-card-label">Senaste körning</div>
              <div className="mc-status-card-val mc-status-mono">{lastRunAt ?? '–'}</div>
            </div>

            <div className="mc-status-card">
              <div className="mc-status-card-label">Körtid</div>
              <div className="mc-status-card-val mc-status-mono">{duration ?? '–'}</div>
            </div>

            <div className="mc-status-card">
              <div className="mc-status-card-label">Lookback</div>
              <div className="mc-status-card-val mc-status-mono">
                {lastResult?.lookbackDays ? `${lastResult.lookbackDays} dagar` : config.lookbackDays ? `${config.lookbackDays} d (default)` : '–'}
              </div>
            </div>

            <div className="mc-status-card">
              <div className="mc-status-card-label">Grupper</div>
              <div className="mc-status-card-val" style={{ fontSize: '0.8rem' }}>
                {(lastResult?.groups ?? config.groups ?? []).join(', ') || '–'}
              </div>
            </div>
          </div>

          {/* Last run stats */}
          {lastResult && (
            <div className="sec">
              <SectionHeader icon="📈" title="Senaste resultatet" desc={`${lastResult.start ?? '?'} → ${lastResult.end ?? '?'}`} />
              <ResultStats result={lastResult} />
            </div>
          )}

          {/* Pipeline steps */}
          <div className="sec">
            <SectionHeader
              icon="🔄"
              title="Pipeline-steg"
              desc="Varje steg körs i ordning. Om ett symbol-backfill misslyckas fortsätter resten."
            />
            <PipelineSteps steps={steps} isRunning={isRunning} />
          </div>

          {/* Run form */}
          <div className="sec">
            <SectionHeader icon="🎛️" title="Kör manuellt" desc="Välj grupper och tidsperiod och starta pipelinen." />
            <RunForm isRunning={isRunning} onTriggered={handleTriggered} />
          </div>

          {/* Scheduler panel */}
          <div className="sec">
            <SectionHeader icon="⏰" title="Scheduler" desc="Automatisk körning enligt schema — konfigureras i .env." />
            <SchedulerPanel sched={sched} />
          </div>
        </>
      )}
    </div>
  );
}
