import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';

const REFRESH_MS = 15000;

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${n.toFixed(2)}%`;
}

function fmtSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function boolText(value) {
  return value ? 'På' : 'Av';
}

function actionTone(action) {
  if (['EXIT', 'TAKE_PROFIT'].includes(action)) return 'exit-tone-hot';
  if (action === 'TIGHTEN_STOP') return 'exit-tone-warn';
  if (action === 'PARTIAL_PROFIT') return 'exit-tone-info';
  return 'exit-tone-cool';
}

function Metric({ label, value, sub }) {
  return (
    <div className="exit-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function LatestDecision({ decision }) {
  return (
    <div className="exit-panel">
      <SectionHeader icon="E" title="Senaste exitbeslut" desc="Senaste evaluation från exit:last_evaluation." />
      {decision ? (
        <>
          <div className="exit-decision-head">
            <div>
              <strong>{decision.symbol || '–'}</strong>
              <span>{fmtTime(decision.timestamp)} · {decision.exit_reason_code}</span>
            </div>
            <span className={`exit-action ${actionTone(decision.action)}`}>{decision.action}</span>
          </div>
          <p className="exit-reason">{decision.reason}</p>
          <div className="exit-metric-grid">
            <Metric label="PnL" value={fmtPct(decision.current_pnl_pct)} />
            <Metric label="Adaptivt target" value={fmtPct(decision.adaptive_target_pct)} />
            <Metric label="Trailing stop" value={fmtPct(decision.trailing_stop_pct)} />
            <Metric label="Ny stop" value={fmtPct(decision.new_stop_loss_pct)} />
            <Metric label="Confidence" value={decision.confidence ?? '–'} />
          </div>
        </>
      ) : (
        <div className="empty">Inget exitbeslut ännu.</div>
      )}
    </div>
  );
}

function RecentDecisions({ decisions }) {
  return (
    <div className="exit-panel">
      <SectionHeader icon="L" title="Senaste exitbeslut" count={decisions.length} desc="Rullande lista från exit:decisions:recent." />
      <div className="exit-decision-list">
        {decisions.length ? decisions.map((d, i) => (
          <div className="exit-row" key={`${d.timestamp}-${d.symbol}-${i}`}>
            <div>
              <strong>{d.symbol || '–'}</strong>
              <span>{fmtTime(d.timestamp)} · {d.exit_reason_code}</span>
            </div>
            <p>{d.reason}</p>
            <span className={`exit-action ${actionTone(d.action)}`}>{d.action}</span>
          </div>
        )) : <div className="empty">Inga beslut loggade.</div>}
      </div>
    </div>
  );
}

function CalibrationPanel({ calibration }) {
  const overall = calibration?.overall;
  const live = calibration?.live_before_after;
  const recommendations = calibration?.recommendations || [];
  const best = calibration?.best_exit_reason;
  const worst = calibration?.worst_exit_reason;

  return (
    <div className="exit-panel exit-calibration-panel">
      <SectionHeader icon="C" title="Exitkalibrering" desc="Replay baseline jämfört med Exit Engine och live paper före/efter." />
      {calibration ? (
        <>
          <div className="exit-calibration-band">
            <div>
              <span>Före Exit Engine</span>
              <strong>{overall?.before?.trades ?? 0}</strong>
              <small>{fmtPct(overall?.before?.avg_pl_pct)} avg P/L · {overall?.wins_before ?? 0}/{overall?.losses_before ?? 0}/{overall?.timeouts_before ?? 0}</small>
            </div>
            <div>
              <span>Efter Exit Engine</span>
              <strong>{overall?.after?.trades ?? 0}</strong>
              <small>{fmtPct(overall?.after?.avg_pl_pct)} avg P/L · {overall?.wins_after ?? 0}/{overall?.losses_after ?? 0}/{overall?.timeouts_after ?? 0}</small>
            </div>
          </div>
          <div className="exit-metric-grid">
            <Metric label="Timeout reduction" value={overall?.timeout_reduction ?? 0} sub={fmtPct(overall?.timeout_reduction_pct)} />
            <Metric label="Avg P/L change" value={fmtSignedPct(overall?.avg_pl_change_pct)} />
            <Metric label="Saved winners" value={overall?.saved_winners ?? 0} sub={`${overall?.near_target_pullbacks_saved ?? 0} pullbacks`} />
            <Metric label="Early exits" value={overall?.early_exits ?? 0} />
            <Metric label="Missed bigger winners" value={overall?.missed_bigger_winners ?? 0} />
            <Metric label="Förbättrade P/L" value={overall?.exits_improved_pl ?? 0} sub={`${overall?.exits_worsened_pl ?? 0} försämrade`} />
            <Metric label="Best exit reason" value={best?.key || '–'} sub={best ? fmtSignedPct(best.avg_pl_change_pct) : null} />
            <Metric label="Worst exit reason" value={worst?.key || '–'} sub={worst ? fmtSignedPct(worst.avg_pl_change_pct) : null} />
          </div>
          <div className="exit-calibration-split">
            <div>
              <h3>Live före/efter</h3>
              <div className="exit-mini-kv"><span>Före</span><strong>{live?.before?.trades ?? 0} trades · {fmtPct(live?.before?.avg_pl_pct)}</strong></div>
              <div className="exit-mini-kv"><span>Efter</span><strong>{live?.after?.trades ?? 0} trades · {fmtPct(live?.after?.avg_pl_pct)}</strong></div>
              <div className="exit-mini-kv"><span>Delta</span><strong>{fmtSignedPct(live?.avg_pl_change_pct)}</strong></div>
            </div>
            <div>
              <h3>Rekommendationer</h3>
              <div className="exit-rec-list">
                {recommendations.length ? recommendations.slice(0, 5).map((rec, i) => (
                  <div className={`exit-rec exit-rec-${rec.severity || 'info'}`} key={`${rec.message}-${i}`}>
                    <strong>{rec.message}</strong>
                    <span>{rec.basis}</span>
                  </div>
                )) : <div className="empty">Inga rekommendationer ännu.</div>}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="empty">Kalibrering saknas.</div>
      )}
    </div>
  );
}

export default function ExitEnginePage() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [replayExit, setReplayExit] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const [statusRes, configRes, sessionsRes, calibrationRes] = await Promise.all([
        fetch('/api/exit/status'),
        fetch('/api/exit/config'),
        fetch('/api/replay/sessions'),
        fetch('/api/exit/calibration'),
      ]);
      const [statusJson, configJson, sessionsJson, calibrationJson] = await Promise.all([
        statusRes.json(),
        configRes.json(),
        sessionsRes.json(),
        calibrationRes.json(),
      ]);
      if (!statusRes.ok) throw new Error(statusJson?.error || `API ${statusRes.status}`);
      if (!configRes.ok) throw new Error(configJson?.error || `API ${configRes.status}`);
      if (!calibrationRes.ok) throw new Error(calibrationJson?.error || `API ${calibrationRes.status}`);
      setStatus(statusJson);
      setConfig(configJson.config);
      setCalibration(calibrationJson);
      const latestWithExit = (sessionsJson.sessions || []).find((s) => s.summary?.exit_engine);
      setReplayExit(latestWithExit?.summary?.exit_engine || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const decisions = useMemo(() => (status?.recent_decisions || []).slice(0, 20), [status]);
  const latest = status?.last_evaluation;

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Exitmotor</div>
          <div className="hero-sub">Exit Engine v1 hanterar profit, trailing, break-even, timeout-intelligens och exitbeslut i paper-flödet.</div>
        </div>
        <button className="btn" onClick={refresh}>Uppdatera</button>
      </div>

      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>{error}</div>}

      <div className="exit-status-strip">
        <Metric label="Enabled" value={boolText(config?.enabled)} />
        <Metric label="Ta vinst nära target" value={boolText(config?.near_target_enabled)} sub={`${config?.near_target_ratio ?? '–'} ratio`} />
        <Metric label="Trailing stop" value={boolText(config?.trailing_enabled)} sub={fmtPct(config?.trailing_distance_pct)} />
        <Metric label="Break-even skydd" value={boolText(config?.break_even_enabled)} sub={fmtPct(config?.break_even_after_profit_pct)} />
        <Metric label="Adaptivt target" value={boolText(config?.adaptive_target_enabled)} sub={`${fmtPct(config?.min_target_pct)}–${fmtPct(config?.max_target_pct)}`} />
      </div>

      <div className="exit-grid">
        <LatestDecision decision={latest} />
        <div className="exit-panel">
          <SectionHeader icon="R" title="Replay-effekt" desc="Senaste replay summary med Exit Engine v1." />
          <div className="exit-metric-grid">
            <Metric label="Timeout minskning" value={replayExit?.timeout_reduction ?? 0} sub={fmtPct(replayExit?.timeout_reduction_pct)} />
            <Metric label="Räddade vinster" value={replayExit?.near_target_saved_trades ?? 0} />
            <Metric label="Trailing exits" value={replayExit?.trailing_stop_exits ?? 0} />
            <Metric label="Momentum fade exits" value={replayExit?.momentum_fade_exits ?? 0} />
            <Metric label="Avg P/L change" value={fmtPct(replayExit?.avg_pl_change)} />
            <Metric label="Förbättrade exits" value={replayExit?.improved_exits_vs_baseline ?? 0} />
          </div>
        </div>
      </div>

      <CalibrationPanel calibration={calibration} />

      <RecentDecisions decisions={decisions} />
    </div>
  );
}
