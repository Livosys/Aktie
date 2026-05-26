import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';

const REFRESH_MS = 15000;

function fmtSek(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${Math.round(n).toLocaleString('sv-SE')} SEK`;
}

function fmtNum(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return n.toFixed(decimals);
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${n.toFixed(2)}%`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function tone(level) {
  if (level === 'block') return { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.28)' };
  if (level === 'high') return { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.28)' };
  if (level === 'medium') return { color: '#eab308', bg: 'rgba(234,179,8,0.08)', border: 'rgba(234,179,8,0.28)' };
  return { color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.24)' };
}

function sourceLabel(source) {
  if (source === 'paper_pipeline') return 'Paper pipeline';
  if (source === 'replay') return 'Replay';
  if (source === 'manual_api_test') return 'Manual API-test';
  return source || '–';
}

function useRiskEngine() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const [statusRes, configRes] = await Promise.all([
        fetch('/api/risk/status'),
        fetch('/api/risk/config'),
      ]);
      const [statusJson, configJson] = await Promise.all([statusRes.json(), configRes.json()]);
      if (!statusRes.ok) throw new Error(statusJson?.error || `API ${statusRes.status}`);
      if (!configRes.ok) throw new Error(configJson?.error || `API ${configRes.status}`);
      setStatus(statusJson);
      setConfig(configJson.config);
      setDraft((current) => Object.keys(current).length ? current : configJson.config || {});
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const payload = {
        enabled: draft.enabled === true,
        risk_per_trade_pct: Number(draft.risk_per_trade_pct),
        max_position_pct: Number(draft.max_position_pct),
        max_daily_loss_pct: Number(draft.max_daily_loss_pct),
        max_trades_per_day: Number(draft.max_trades_per_day),
        max_consecutive_losses: Number(draft.max_consecutive_losses),
        min_confidence: Number(draft.min_confidence),
        max_spread_pct: Number(draft.max_spread_pct),
      };
      const res = await fetch('/api/risk/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || 'config_update_failed');
      setConfig(json.config);
      setDraft(json.config);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return { status, config, draft, setDraft, error, saving, saveConfig, refresh };
}

function Metric({ label, value, sub, color }) {
  return (
    <div className="risk-metric">
      <span>{label}</span>
      <strong style={{ color: color || 'var(--text)' }}>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function ConfigInput({ label, field, draft, setDraft, suffix, type = 'number', step = '0.1' }) {
  return (
    <label className="risk-config-field">
      <span>{label}</span>
      <div>
        <input
          type={type}
          step={step}
          checked={type === 'checkbox' ? draft[field] === true : undefined}
          value={type === 'checkbox' ? undefined : draft[field] ?? ''}
          onChange={(e) => {
            const value = type === 'checkbox' ? e.target.checked : e.target.value;
            setDraft((current) => ({ ...current, [field]: value }));
          }}
        />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

function LatestEvaluation({ evaluation }) {
  const t = tone(evaluation?.risk_level);
  const blockReasons = evaluation?.block_reasons || [];
  const warnings = evaluation?.warnings || [];

  return (
    <div className="risk-panel">
      <div className="risk-panel-head">
        <div>
          <h3>Senaste riskbedömning</h3>
          <p>{evaluation?.symbol || 'Ingen symbol ännu'} · {fmtTime(evaluation?.timestamp)} · {sourceLabel(evaluation?.evaluation_source)}</p>
        </div>
        <span className="risk-badge" style={{ color: t.color, background: t.bg, borderColor: t.border }}>
          {evaluation?.allowed ? 'Tillåten' : evaluation ? 'Blockerad' : 'Väntar'}
        </span>
      </div>
      <div className="risk-metric-grid">
        <Metric label="Positionsstorlek" value={fmtSek(evaluation?.position_size_sek)} />
        <Metric label="Position units" value={fmtNum(evaluation?.position_size_units, 4)} />
        <Metric label="Max risk per affär" value={fmtSek(evaluation?.max_loss_sek)} />
        <Metric label="Risk/reward" value={fmtNum(evaluation?.risk_reward_ratio, 2)} />
      </div>
      <div className="risk-lists">
        <div>
          <span>Blockeringsorsak</span>
          {blockReasons.length ? blockReasons.map((r) => <strong key={r}>{r}</strong>) : <small>Inga</small>}
        </div>
        <div>
          <span>Warnings</span>
          {warnings.length ? warnings.map((w) => <strong key={w}>{w}</strong>) : <small>Inga</small>}
        </div>
      </div>
      {evaluation?.position_notes && <div className="risk-note">{evaluation.position_notes}</div>}
    </div>
  );
}

export default function RiskEnginePage() {
  const { status, config, draft, setDraft, error, saving, saveConfig, refresh } = useRiskEngine();
  const latest = status?.last_evaluation;
  const pause = status?.pause_trading === true || latest?.pause_trading === true;
  const pauseReasons = status?.pause_reasons?.length ? status.pause_reasons : latest?.pause_reasons || [];
  const statusTone = pause ? tone('block') : tone(latest?.risk_level || 'low');

  const blocks = useMemo(() => (status?.blocks_today || []).slice(0, 8), [status]);

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Riskmotor</div>
          <div className="hero-sub">Risk Engine v2 styr om entries tillåts, minskas, blockeras eller pausas i paper-flödet.</div>
        </div>
        <button className="btn" onClick={refresh}>Uppdatera</button>
      </div>

      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>{error}</div>}

      <div className="risk-status-strip" style={{ borderColor: statusTone.border, background: statusTone.bg }}>
        <div>
          <span>Risk status</span>
          <strong style={{ color: statusTone.color }}>{pause ? 'Systempaus' : latest?.allowed === false ? 'Blockerar' : 'Aktiv'}</strong>
        </div>
        <div>
          <span>Risk enabled</span>
          <strong>{config?.enabled ? 'På' : 'Av'}</strong>
        </div>
        <div>
          <span>Systempaus</span>
          <strong>{pause ? 'Ja' : 'Nej'}</strong>
        </div>
        <div>
          <span>Trades today</span>
          <strong>{latest?.account_snapshot?.daily_trades ?? '–'}</strong>
        </div>
        <div>
          <span>Consecutive losses</span>
          <strong>{latest?.account_snapshot?.consecutive_losses ?? '–'}</strong>
        </div>
        <div>
          <span>Källa</span>
          <strong>{sourceLabel(status?.evaluation_source || latest?.evaluation_source)}</strong>
        </div>
      </div>

      <div className="risk-grid-main">
        <div className="risk-panel">
          <SectionHeader icon="R" title="Risk Engine v2" desc="Aktuell riskkonfiguration och kontogränser." />
          <div className="risk-metric-grid">
            <Metric label="Account balance" value={fmtSek(config?.account_balance)} />
            <Metric label="Max risk per affär" value={fmtPct(config?.risk_per_trade_pct)} />
            <Metric label="Max position %" value={fmtPct(config?.max_position_pct)} />
            <Metric label="Daglig förlustgräns" value={fmtPct(config?.max_daily_loss_pct)} />
            <Metric label="Max trades/dag" value={config?.max_trades_per_day ?? '–'} />
            <Metric label="Min confidence" value={config?.min_confidence ?? '–'} />
          </div>
          {pauseReasons.length > 0 && (
            <div className="risk-note risk-note-danger">Systempaus: {pauseReasons.join(', ')}</div>
          )}
        </div>

        <LatestEvaluation evaluation={latest} />
      </div>

      <div className="risk-grid-main">
        <div className="risk-panel">
          <SectionHeader icon="%" title="Risk config" desc="Säkra fält med servervalidering." />
          <div className="risk-config-grid">
            <ConfigInput label="Risk enabled" field="enabled" draft={draft} setDraft={setDraft} type="checkbox" />
            <ConfigInput label="Max risk per affär" field="risk_per_trade_pct" draft={draft} setDraft={setDraft} suffix="%" />
            <ConfigInput label="Max position %" field="max_position_pct" draft={draft} setDraft={setDraft} suffix="%" />
            <ConfigInput label="Daglig förlustgräns" field="max_daily_loss_pct" draft={draft} setDraft={setDraft} suffix="%" />
            <ConfigInput label="Max trades per dag" field="max_trades_per_day" draft={draft} setDraft={setDraft} step="1" />
            <ConfigInput label="Max consecutive losses" field="max_consecutive_losses" draft={draft} setDraft={setDraft} step="1" />
            <ConfigInput label="Min confidence" field="min_confidence" draft={draft} setDraft={setDraft} step="1" />
            <ConfigInput label="Max spread" field="max_spread_pct" draft={draft} setDraft={setDraft} suffix="%" />
          </div>
          <button className="btn primary" onClick={saveConfig} disabled={saving}>{saving ? 'Sparar…' : 'Spara risk config'}</button>
        </div>

        <div className="risk-panel">
          <SectionHeader icon="!" title="Block idag" desc="Senaste risk block från risk:blocks:today." />
          <div className="risk-block-list">
            {blocks.length ? blocks.map((b, i) => (
              <div key={`${b.timestamp}-${i}`} className="risk-block-row">
                <div>
                  <strong>{b.symbol}</strong>
                  <span>{fmtTime(b.timestamp)}</span>
                </div>
                <p>{(b.block_reasons || []).join(', ') || 'risk_block'}</p>
              </div>
            )) : (
              <div className="empty">Inga risk block idag.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
