import React, { useEffect, useMemo, useState } from 'react';

const FETCH_TIMEOUT_MS = 6500;

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function useJsonResource(url, refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;

    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      setState((prev) => ({ ...prev, loading: true }));
      fetchJsonWithTimeout(url, { signal: activeController.signal })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, data, error: null });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            data: prev.data,
            error: err?.message || 'read_error',
          }));
        });
    };

    load();
    return () => {
      alive = false;
      if (activeController) activeController.abort();
    };
  }, [url, refreshKey]);

  return state;
}

const STATUS_LABELS = {
  approved: 'Approved',
  not_approved: 'Ej godkänd',
  max_nått: 'Max nått',
  nekad: 'Nekad',
  needs_strategy_id: 'Saknar strategyId',
  unknown: 'Okänd',
};

const DECISION_LABELS = {
  promote_to_paper: 'Promote',
  watch: 'Watch',
  reject: 'Reject',
};

const FLOW_STEPS = [
  { label: 'Förslag', hint: 'Batch / Replay / AI-agent' },
  { label: 'Kandidat', hint: 'Paper-kandidat' },
  { label: 'Runtime redo', hint: 'Runtime readiness' },
  { label: 'Approved', hint: 'Manuell allowlist' },
  { label: 'Paper-testas', hint: 'Paper trading' },
  { label: 'Lärande', hint: 'Learning' },
];

function sourceLabel(source) {
  const raw = safeString(source, 'unknown').toLowerCase();
  if (raw.includes('ai_agent')) return 'AI-agent';
  if (raw.includes('replay')) return 'Replay';
  if (raw.includes('batch')) return 'Batch';
  return raw || 'Okänd';
}

function statusTone(status) {
  const key = safeString(status, 'unknown');
  if (key === 'approved') return 'good';
  if (key === 'not_approved') return 'warn';
  if (key === 'max_nått' || key === 'nekad') return 'bad';
  return 'neutral';
}

function normalizeStatus(candidate) {
  if (!candidate) return 'unknown';
  if (candidate.alreadyApproved === true) return 'approved';
  if (candidate.allowlistStatus === 'approved') return 'approved';
  if (candidate.allowlistStatus) return candidate.allowlistStatus;
  return 'unknown';
}

function candidateKey(candidate) {
  if (!candidate) return null;
  return candidate.candidateId
    || candidate.recommendationId
    || (candidate.sourceRunId && candidate.variantId && `${candidate.sourceRunId}:${candidate.variantId}`)
    || (candidate.strategyId && `${candidate.source || 'source'}:${candidate.strategyId}`)
    || candidate.id
    || null;
}

function mergeCandidate(base, patch) {
  const merged = { ...base, ...patch };
  merged.metrics = { ...(base?.metrics || {}), ...(patch?.metrics || {}) };
  merged.recommendation = { ...(base?.recommendation || {}), ...(patch?.recommendation || {}) };
  merged.allowlistSnapshot = patch?.allowlistSnapshot || base?.allowlistSnapshot || null;
  merged.blockers = patch?.blockers || base?.blockers || [];
  merged.runtimeReady = patch?.runtimeReady ?? base?.runtimeReady ?? false;
  merged.scannerConnected = patch?.scannerConnected ?? base?.scannerConnected ?? false;
  merged.paperRunnable = patch?.paperRunnable ?? base?.paperRunnable ?? false;
  merged.alreadyApproved = patch?.alreadyApproved ?? base?.alreadyApproved ?? false;
  merged.allowlistStatus = patch?.allowlistStatus || base?.allowlistStatus || 'unknown';
  merged.nextAction = patch?.nextAction || base?.nextAction || '–';
  merged.allowlistReason = patch?.allowlistReason || base?.allowlistReason || '';
  merged.saved = patch?.saved ?? base?.saved ?? false;
  return merged;
}

function buildUnifiedCandidates(previewRows, savedRows, readinessRows) {
  const map = new Map();
  const add = (row, patch = {}) => {
    if (!row) return;
    const key = candidateKey(row);
    if (!key) return;
    const existing = map.get(key);
    const merged = mergeCandidate(existing || row, patch);
    map.set(key, merged);
  };

  for (const row of previewRows) {
    add(row, {
      source: row.source || 'batch',
      sourceLabel: row.sourceLabel || sourceLabel(row.source),
      saved: false,
    });
  }

  for (const row of savedRows) {
    add(row, {
      source: row.source || 'ai_agent_batch_recommendation',
      sourceLabel: row.sourceLabel || sourceLabel(row.source),
      saved: true,
    });
  }

  for (const row of readinessRows) {
    const status = normalizeStatus(row);
    add(row, {
      ...row,
      allowlistStatus: status,
      alreadyApproved: row.alreadyApproved === true || status === 'approved',
      saved: true,
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    const aStatus = normalizeStatus(a);
    const bStatus = normalizeStatus(b);
    const aApproved = aStatus === 'approved' ? 0 : 1;
    const bApproved = bStatus === 'approved' ? 0 : 1;
    if (aApproved !== bApproved) return aApproved - bApproved;
    const aScore = safeNumber(a.metrics?.score, -Infinity);
    const bScore = safeNumber(b.metrics?.score, -Infinity);
    if (aScore !== bScore) return bScore - aScore;
    return String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''));
  });
}

function chipStyle(kind = 'neutral') {
  const palette = {
    good: { background: 'rgba(34,197,94,0.14)', color: '#22c55e', border: 'rgba(34,197,94,0.32)' },
    warn: { background: 'rgba(245,158,11,0.14)', color: '#f59e0b', border: 'rgba(245,158,11,0.32)' },
    bad: { background: 'rgba(239,68,68,0.14)', color: '#ef4444', border: 'rgba(239,68,68,0.32)' },
    neutral: { background: 'rgba(148,163,184,0.10)', color: '#cbd5e1', border: 'rgba(148,163,184,0.24)' },
  };
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${palette[kind]?.border || palette.neutral.border}`,
    background: palette[kind]?.background || palette.neutral.background,
    color: palette[kind]?.color || palette.neutral.color,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
  };
}

function panelStyle() {
  return {
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: 18,
    background: 'var(--surface, rgba(15,23,42,0.72))',
    boxShadow: '0 16px 40px rgba(0,0,0,0.16)',
    marginTop: 18,
  };
}

function flowStyle(active = false, tone = 'neutral') {
  const tones = {
    good: 'rgba(34,197,94,0.16)',
    warn: 'rgba(245,158,11,0.16)',
    bad: 'rgba(239,68,68,0.16)',
    neutral: 'rgba(148,163,184,0.12)',
  };
  return {
    minWidth: 120,
    flex: '1 1 120px',
    borderRadius: 14,
    border: `1px solid ${active ? 'rgba(56,189,248,0.55)' : 'var(--border)'}`,
    background: active ? 'rgba(56,189,248,0.08)' : tones[tone] || tones.neutral,
    padding: '12px 14px',
    textAlign: 'center',
  };
}

function statusText(candidate) {
  const status = normalizeStatus(candidate);
  if (candidate?.alreadyApproved) return 'Approved';
  if (candidate?.blockers?.length === 0 && candidate?.nextAction === 'paper_trade_test') return 'Redo för paper-test';
  return STATUS_LABELS[status] || status;
}

function sourceCounts(candidates) {
  const counts = { ai_agent: 0, batch: 0, replay: 0 };
  for (const row of candidates) {
    const raw = safeString(row.source, 'unknown').toLowerCase();
    if (raw.includes('ai_agent')) counts.ai_agent += 1;
    else if (raw.includes('replay')) counts.replay += 1;
    else if (raw.includes('batch')) counts.batch += 1;
  }
  return counts;
}

export default function PaperCandidatePanel({ mode = 'lab' }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const previewState = useJsonResource('/api/optimization/batch-replay-paper-candidates/preview?limit=25', refreshTick);
  const savedState = useJsonResource('/api/optimization/paper-candidates?limit=50', refreshTick);
  const readinessState = useJsonResource('/api/optimization/paper-candidates/readiness?limit=50', refreshTick);
  const approvalsState = useJsonResource('/api/automation/approvals', refreshTick);
  const [busyKey, setBusyKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const previewRows = previewState.data?.candidates || [];
  const savedRows = savedState.data?.candidates || [];
  const readinessRows = readinessState.data?.candidates || [];
  const candidates = useMemo(
    () => buildUnifiedCandidates(previewRows, savedRows, readinessRows),
    [previewRows, savedRows, readinessRows],
  );

  const approvals = approvalsState.data || {};
  const approvedCount = approvals.approvedCount ?? safeArray(approvals.approvedStrategyIds).length;
  const maxApproved = approvals.maxApproved ?? '–';
  const sourceSummary = useMemo(() => sourceCounts(candidates), [candidates]);
  const viewTitle = mode === 'paper'
    ? 'Paper-kandidater från AI, Batch och Replay'
    : 'AI / Batch / Replay → Paper-kandidater';
  const viewSubtitle = mode === 'paper'
    ? 'Samma backend-data som i Lab. Fokus här är manuellt godkännande och runtime-readiness.'
    : 'Samma backend-data som i Paper Trading. Fokus här är preview, score och vad som kan sparas som kandidat.';

  async function reloadAll() {
    setRefreshTick((tick) => tick + 1);
  }

  async function createCandidate(candidate) {
    if (!candidate?.candidateId) return;
    if (!['batch', 'replay'].includes(String(candidate.source || ''))) return;
    setBusyKey(`create:${candidate.candidateId}`);
    setMessage('');
    setError('');
    try {
      const res = await fetch('/api/optimization/batch-replay-paper-candidates/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId: candidate.candidateId,
          reason: 'manual_create_from_batch_replay_preview',
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'Kunde inte skapa paper-testkandidat.');
      setMessage(json.deduped ? 'Paper-testkandidat fanns redan sparad.' : 'Skickad till paper-testkandidater.');
      await reloadAll();
    } catch (err) {
      setError(err?.message || 'Kunde inte skapa paper-testkandidat.');
    } finally {
      setBusyKey('');
    }
  }

  async function approveCandidate(candidate) {
    if (!candidate?.strategyId) return;
    const ok = window.confirm('Detta godkänner endast låtsashandel. Inga riktiga order kan läggas.');
    if (!ok) return;
    setBusyKey(`approve:${candidate.strategyId}`);
    setMessage('');
    setError('');
    try {
      const res = await fetch('/api/automation/approvals/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategyId: candidate.strategyId,
          reason: `manual_ui_from_${mode}:${candidate.displayName || candidate.strategyId}`,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'Kunde inte lägga till i paper allowlist.');
      setMessage(`Lades till i paper allowlist: ${candidate.displayName || candidate.strategyId}.`);
      await reloadAll();
    } catch (err) {
      setError(err?.message || 'Kunde inte lägga till i paper allowlist.');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <div className="paper-candidate-panel" style={panelStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 4 }}>{viewTitle}</div>
          <div style={{ color: '#94a3b8', lineHeight: 1.5, fontSize: 13 }}>
            {viewSubtitle}
          </div>
        </div>
        <div style={{ ...chipStyle('neutral'), whiteSpace: 'nowrap' }}>
          allowlist {approvedCount} / {maxApproved}
        </div>
      </div>

      <div className="paper-candidate-flow" style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 14,
        padding: 12,
        borderRadius: 14,
        border: '1px solid var(--border)',
        background: 'rgba(15,23,42,0.4)',
      }}>
        {FLOW_STEPS.map((step, index) => {
          const tone = index === 0 ? 'good' : index === 2 ? 'warn' : 'neutral';
          const active = mode === 'lab' ? index === 0 || index === 1 : index === 3 || index === 4;
          return (
            <React.Fragment key={step.label}>
              <div className="paper-candidate-flow-step" style={flowStyle(active, tone)}>
                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 4 }}>{step.label}</div>
                <div style={{ color: '#94a3b8', fontSize: 11, lineHeight: 1.4 }}>{step.hint}</div>
              </div>
              {index < FLOW_STEPS.length - 1 && (
                <div className="paper-candidate-flow-arrow" style={{ alignSelf: 'center', color: '#64748b', fontWeight: 900, fontSize: 18 }}>→</div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div style={{ marginTop: 12, color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>
        Detta är paper-only research. Systemet får föreslå, men du godkänner manuellt.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <span style={chipStyle('neutral')}>Förslag {sourceSummary.batch + sourceSummary.replay + sourceSummary.ai_agent}</span>
        <span style={chipStyle('good')}>Kandidat {candidates.length}</span>
        <span style={chipStyle('warn')}>Runtime redo {readinessState.data?.summary?.runtimeReady ?? 0}</span>
        <span style={chipStyle('good')}>Approved {readinessState.data?.summary?.alreadyApproved ?? approvedCount}</span>
        <span style={chipStyle('neutral')}>Paper-testas {readinessState.data?.summary?.paperRunnable ?? 0}</span>
        <span style={chipStyle('neutral')}>Lärande via data/logg</span>
      </div>

      {message ? (
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.08)', color: '#86efac' }}>
          {message}
        </div>
      ) : null}
      {error || previewState.error || savedState.error || readinessState.error || approvalsState.error ? (
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>
          {error || previewState.error || savedState.error || readinessState.error || approvalsState.error}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, color: '#94a3b8', fontSize: 12 }}>
        <span>{previewState.loading ? 'Läser preview...' : `${previewRows.length} preview-kandidater`}</span>
        <span>{savedState.loading ? 'Läser saved...' : `${savedRows.length} sparade kandidater`}</span>
        <span>{readinessState.loading ? 'Läser readiness...' : `${readinessRows.length} readiness-kandidater`}</span>
        <span>Samma backenddata används i Lab och Paper Trading.</span>
      </div>

      <div className="paper-candidate-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        {candidates.length > 0 ? candidates.map((candidate) => {
          const status = normalizeStatus(candidate);
          const approved = status === 'approved';
          const ready = candidate.runtimeReady === true;
          const runnable = candidate.paperRunnable === true;
          const canApprove = !!candidate.strategyId && !approved;
          const showCreate = ['batch', 'replay'].includes(String(candidate.source || '')) && !candidate.saved;
          const statusToneValue = approved ? 'good' : candidate.blockers?.length ? 'warn' : 'neutral';
          const runtimeTone = ready ? 'good' : 'warn';
          const allowlistText = approved
            ? 'Approved'
            : candidate.allowlistStatus === 'max_nått'
              ? 'Max nått'
              : candidate.allowlistStatus === 'nekad'
                ? 'Nekad'
                : candidate.allowlistStatus === 'needs_strategy_id'
                  ? 'Saknar strategyId'
                  : 'Ej godkänd';

          return (
            <div key={candidateKey(candidate)} style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 16, background: 'rgba(15,23,42,0.52)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 4 }}>{candidate.displayName || candidate.strategyName || candidate.strategyId || 'Okänd kandidat'}</div>
                  <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>
                    StrategyId: {candidate.strategyId || '–'} · Källa: {sourceLabel(candidate.source)} · run {candidate.sourceRunId || '–'} · variant {candidate.variantId || '–'}
                  </div>
                </div>
                <div style={chipStyle(statusToneValue)}>
                  {statusText(candidate)}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 14 }}>
                <Metric label="Trades" value={candidate.metrics?.trades ?? '–'} />
                <Metric label="Win rate" value={candidate.metrics?.winRate != null ? `${candidate.metrics.winRate}%` : '–'} />
                <Metric label="PnL" value={candidate.metrics?.totalPnlPct != null ? `${candidate.metrics.totalPnlPct}%` : '–'} />
                <Metric label="Score" value={candidate.metrics?.score ?? '–'} />
                <Metric label="Confidence" value={candidate.recommendation?.confidence || '–'} />
                <Metric label="Decision" value={DECISION_LABELS[candidate.recommendation?.decision] || candidate.recommendation?.decision || '–'} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                <span style={chipStyle(runtimeTone)}>{ready ? 'Runtime ready' : 'Runtime ej redo'}</span>
                <span style={chipStyle(runnable ? 'good' : 'warn')}>{runnable ? 'Paper runnable' : 'Ej paper runnable'}</span>
                <span style={chipStyle(candidate.alreadyApproved ? 'good' : 'warn')}>
                  {candidate.alreadyApproved ? 'Already approved' : allowlistText}
                </span>
                <span style={chipStyle(candidate.blockers?.length ? 'warn' : 'good')}>
                  {candidate.blockers?.length ? `${candidate.blockers.length} blocker(s)` : 'Inga blockers'}
                </span>
                <span style={chipStyle('neutral')}>Next action: {candidate.nextAction || '–'}</span>
                <span style={chipStyle('neutral')}>Source: {sourceLabel(candidate.source)}</span>
              </div>

              <div style={{ marginTop: 12, color: '#cbd5e1', fontSize: 13, lineHeight: 1.55 }}>
                {candidate.explanation || candidate.recommendation?.reason || '–'}
              </div>

              {candidate.blockers?.length > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 12 }}>
                  {candidate.blockers.map((blocker) => (
                    <div key={blocker.code} style={{ border: '1px solid rgba(148,163,184,0.24)', borderRadius: 12, padding: 12, background: 'rgba(2,6,23,0.35)' }}>
                      <div style={{ fontWeight: 800, marginBottom: 4 }}>{blocker.label}</div>
                      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6 }}>{blocker.code}</div>
                      <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>{blocker.explanation}</div>
                      <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>Nästa steg: {blocker.nextStep}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(34,197,94,0.28)', background: 'rgba(34,197,94,0.08)', color: '#86efac' }}>
                  Redo för paper-test
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, alignItems: 'center' }}>
                {showCreate ? (
                  <button
                    type="button"
                    disabled={busyKey === `create:${candidate.candidateId}` || candidate.saved}
                    onClick={() => createCandidate(candidate)}
                    style={actionButtonStyle(candidate.saved, false)}
                  >
                    {candidate.saved ? 'Redan sparad' : busyKey === `create:${candidate.candidateId}` ? 'Sparar...' : 'Skapa paper-testkandidat'}
                  </button>
                ) : null}

                {candidate.strategyId ? (
                  <button
                    type="button"
                    disabled={!canApprove || busyKey === `approve:${candidate.strategyId}`}
                    onClick={() => approveCandidate(candidate)}
                    style={actionButtonStyle(!canApprove, true)}
                  >
                    {approved
                      ? 'Redan godkänd'
                      : busyKey === `approve:${candidate.strategyId}`
                        ? 'Godkänner...'
                        : 'Lägg till i paper allowlist'}
                  </button>
                ) : null}

                <span style={{ color: '#94a3b8', fontSize: 12 }}>
                  {approved
                    ? 'Approved via current automation approvals.'
                    : candidate.strategyId
                      ? 'Godkänn manuellt när du vill lämna allowlist-status oförändrad tills dess.'
                      : 'Saknar strategyId för allowlist-godkännande.'}
                </span>
              </div>
            </div>
          );
        }) : (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>
            {previewState.loading || savedState.loading || readinessState.loading || approvalsState.loading
              ? 'Läser kandidatdata...'
              : 'Inga AI-/batch-/replay-kandidater hittades ännu.'}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ border: '1px solid rgba(148,163,184,0.18)', borderRadius: 12, padding: '10px 12px', background: 'rgba(2,6,23,0.35)' }}>
      <div style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function actionButtonStyle(disabled, secondary) {
  return {
    appearance: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    border: `1px solid ${secondary ? 'rgba(56,189,248,0.32)' : 'rgba(34,197,94,0.32)'}`,
    background: secondary ? 'rgba(56,189,248,0.12)' : 'rgba(34,197,94,0.12)',
    color: secondary ? '#38bdf8' : '#22c55e',
    fontWeight: 800,
    fontSize: 12,
    padding: '8px 12px',
    borderRadius: 10,
  };
}
