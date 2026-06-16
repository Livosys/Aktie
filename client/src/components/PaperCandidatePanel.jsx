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

function candidateTone(candidate) {
  const status = normalizeStatus(candidate);
  if (candidate?.alreadyApproved || status === 'approved') return 'approved';
  if (candidate?.blockers?.length > 0) return 'blocked';
  if (candidate?.recommendation?.decision === 'reject' || status === 'nekad' || status === 'max_nått') return 'rejected';
  if (candidate?.nextAction === 'paper_trade_test' || candidate?.runtimeReady || candidate?.paperRunnable) return 'ready';
  if (candidate?.recommendation?.decision === 'watch') return 'warning';
  return 'neutral';
}

function hasHardBlockers(candidate) {
  return Array.isArray(candidate?.blockers) && candidate.blockers.length > 0;
}

function isReplaySource(source) {
  return safeString(source, 'unknown').toLowerCase().includes('replay');
}

function isLowConfidenceCandidate(candidate) {
  const raw = safeString(candidate?.recommendation?.confidence || candidate?.confidence, '').toLowerCase();
  if (raw === 'low' || raw === 'låg' || raw === 'weak') return true;
  const score = Number(candidate?.recommendation?.confidence || candidate?.confidence);
  return Number.isFinite(score) && score < 50;
}

function getCandidateUiState(candidate) {
  const strategyId = safeString(candidate?.strategyId);
  const decision = safeString(candidate?.recommendation?.decision || candidate?.decision).toLowerCase();
  const runtimeReady = candidate?.runtimeReady === true;
  const paperRunnable = candidate?.paperRunnable === true;
  const alreadyApproved = candidate?.alreadyApproved === true || normalizeStatus(candidate) === 'approved';
  const blocked = hasHardBlockers(candidate);
  const hasRejectDecision = decision === 'reject';
  const canCreatePaperCandidate = !!strategyId && !hasRejectDecision && !blocked && runtimeReady !== false && paperRunnable !== false;
  let uiStatus = 'neutral';
  let uiLabel = 'Kandidat';
  let uiTone = 'neutral';
  let canShowReadyForPaperTest = false;
  let reason = '';

  if (!strategyId) {
    uiStatus = 'missing_strategy_id';
    uiLabel = 'Saknar strategyId';
    uiTone = 'danger';
    reason = 'Replay-resultatet saknar strategyId och kan inte matchas mot runtime.';
  } else if (hasRejectDecision) {
    uiStatus = 'rejected';
    uiLabel = 'Rekommenderas ej';
    uiTone = 'danger';
    reason = 'Kandidaten är markerad som Reject och ska inte visas som redo för paper-test.';
  } else if (!runtimeReady) {
    uiStatus = 'runtime_not_ready';
    uiLabel = 'Runtime ej redo';
    uiTone = 'danger';
    reason = 'Kandidaten saknar runtime-ready koppling eller har runtime-blockers.';
  } else if (!paperRunnable) {
    uiStatus = 'not_paper_runnable';
    uiLabel = 'Ej redo för paper-test';
    uiTone = 'warning';
    reason = 'Kandidaten är inte paper-runnable ännu.';
  } else if (blocked) {
    uiStatus = 'blocked';
    uiLabel = 'Blockerad';
    uiTone = 'warning';
    reason = 'Kandidaten har blockers som måste lösas först.';
  } else if (alreadyApproved && runtimeReady && paperRunnable) {
    uiStatus = 'approved_ready';
    uiLabel = 'Redo för paper-test';
    uiTone = 'success';
    canShowReadyForPaperTest = true;
    reason = 'Godkänd via paper allowlist och matchad mot runtime.';
  } else if (strategyId && runtimeReady && paperRunnable) {
    uiStatus = 'candidate_ready_for_review';
    uiLabel = 'Redo för manuell granskning';
    uiTone = 'info';
    reason = 'Du måste godkänna den innan paper trading testar den.';
  }

  return {
    uiStatus,
    uiLabel,
    uiTone,
    canCreatePaperCandidate,
    canShowReadyForPaperTest,
    reason,
    strategyId,
    decision,
    runtimeReady,
    paperRunnable,
    alreadyApproved,
    blocked,
  };
}

function getCandidateGroupKey(candidate) {
  const source = safeString(candidate?.source, 'unknown');
  const decision = safeString(candidate?.recommendation?.decision || candidate?.decision, 'unknown').toLowerCase();
  const strategyId = safeString(candidate?.strategyId);
  const recommendationId = safeString(candidate?.recommendationId);
  const candidateId = safeString(candidate?.candidateId);
  const displayName = safeString(candidate?.displayName || candidate?.strategyName);
  const normalizedTitle = displayName.toLowerCase().replace(/\s+/g, ' ').trim();
  if (strategyId) return `${source}:${strategyId}:${decision || 'unknown'}`;
  if (recommendationId) return `${source}:${recommendationId}:${decision || 'unknown'}`;
  if (candidateId) return `${source}:${candidateId}:${decision || 'unknown'}`;
  return `${source}:${normalizedTitle || 'unknown'}:${decision || 'unknown'}`;
}

function candidateMetaScore(candidate) {
  const approvalRank = candidate?.alreadyApproved === true || normalizeStatus(candidate) === 'approved' ? 0 : 1;
  const runtimeRank = candidate?.runtimeReady === true ? 0 : 1;
  const score = safeNumber(candidate?.metrics?.score, -Infinity);
  const confidence = safeNumber(candidate?.recommendation?.confidence, -Infinity);
  return {
    approvalRank,
    runtimeRank,
    score,
    confidence,
    createdAt: String(candidate?.createdAt || candidate?.updatedAt || ''),
  };
}

function isBetterCandidate(a, b) {
  const A = candidateMetaScore(a);
  const B = candidateMetaScore(b);
  if (A.approvalRank !== B.approvalRank) return A.approvalRank < B.approvalRank;
  if (A.runtimeRank !== B.runtimeRank) return A.runtimeRank < B.runtimeRank;
  if (A.score !== B.score) return A.score > B.score;
  if (A.confidence !== B.confidence) return A.confidence > B.confidence;
  return A.createdAt > B.createdAt;
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

  const grouped = new Map();
  for (const candidate of map.values()) {
    const key = getCandidateGroupKey(candidate);
    if (!grouped.has(key)) {
      grouped.set(key, {
        representative: candidate,
        candidates: [candidate],
        similarCount: 1,
      });
      continue;
    }
    const group = grouped.get(key);
    group.candidates.push(candidate);
    group.similarCount += 1;
    if (isBetterCandidate(candidate, group.representative)) {
      group.representative = candidate;
    }
  }

  return Array.from(grouped.values())
    .map((group) => ({
      ...group.representative,
      similarCount: group.similarCount,
      similarCandidates: group.candidates,
    }))
    .sort((a, b) => {
      if (isBetterCandidate(a, b)) return -1;
      if (isBetterCandidate(b, a)) return 1;
      return 0;
    });
}

function getCandidatePresentationBucket(candidate, ui = getCandidateUiState(candidate)) {
  if (ui.uiStatus === 'approved_ready') return 'approved_ready';
  if (ui.uiStatus === 'candidate_ready_for_review') return 'candidate_ready_for_review';
  if (
    ui.strategyId
    && !ui.alreadyApproved
    && !ui.blocked
    && (ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable')
  ) {
    return 'blocked_fixable';
  }
  if (
    !ui.strategyId
    || ui.uiStatus === 'rejected'
    || (isReplaySource(candidate?.source) && isLowConfidenceCandidate(candidate))
  ) {
    return 'unusable';
  }
  if (ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable') {
    return 'blocked_fixable';
  }
  return 'candidate_ready_for_review';
}

function presentationBucketRank(bucket) {
  if (bucket === 'approved_ready') return 0;
  if (bucket === 'candidate_ready_for_review') return 1;
  if (bucket === 'blocked_fixable') return 2;
  return 3;
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

function sourceBadgeClass(source) {
  const raw = safeString(source, 'unknown').toLowerCase();
  if (raw.includes('ai_agent')) return 'badge-source-ai';
  if (raw.includes('replay')) return 'badge-source-replay';
  if (raw.includes('batch')) return 'badge-source-batch';
  return 'badge-source-neutral';
}

function statusBadgeClass(candidate) {
  const tone = candidateTone(candidate);
  if (tone === 'approved') return 'badge-approved';
  if (tone === 'ready') return 'badge-ready';
  if (tone === 'warning') return 'badge-warning';
  if (tone === 'blocked' || tone === 'rejected') return 'badge-reject';
  return 'badge-neutral';
}

function candidateCardClass(candidate, bucket = null) {
  const ui = getCandidateUiState(candidate);
  const tone = bucket === 'approved_ready'
    ? 'approved'
    : bucket === 'candidate_ready_for_review'
      ? 'ready'
      : bucket === 'blocked_fixable'
        ? 'warning'
        : ui.uiTone === 'success'
          ? 'approved'
          : ui.uiTone === 'info'
            ? 'ready'
            : ui.uiTone === 'warning'
              ? 'warning'
              : ui.uiTone === 'danger'
                ? 'rejected'
                : 'neutral';
  return `candidate-card candidate-card-${tone}`;
}

function metricClass(value, kind = 'neutral') {
  if (kind === 'pnl') {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 'metric-neutral';
    return n > 0 ? 'metric-positive' : 'metric-negative';
  }
  if (kind === 'confidence') {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'metric-neutral';
    if (n < 50) return 'metric-low-confidence';
    if (n < 70) return 'metric-warning';
    return 'metric-positive';
  }
  return 'metric-neutral';
}

function confidenceTone(candidate) {
  const raw = safeString(candidate?.recommendation?.confidence || candidate?.confidence, '').toLowerCase();
  const score = Number(candidate?.recommendation?.confidence || candidate?.confidence);
  if (raw === 'low' || raw === 'låg' || raw === 'weak') return 'badge-low-confidence';
  if (Number.isFinite(score) && score < 50) return 'badge-low-confidence';
  if (raw === 'medium' || raw === 'medel') return 'badge-warning';
  if (raw === 'high' || raw === 'hög') return 'badge-approved';
  return 'badge-neutral';
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
  const [showUnusable, setShowUnusable] = useState(false);
  const [expandedUnusableKeys, setExpandedUnusableKeys] = useState({});

  const previewRows = previewState.data?.candidates || [];
  const savedRows = savedState.data?.candidates || [];
  const readinessRows = readinessState.data?.candidates || [];
  const candidates = useMemo(
    () => buildUnifiedCandidates(previewRows, savedRows, readinessRows),
    [previewRows, savedRows, readinessRows],
  );
  const presentation = useMemo(() => {
    const prepared = candidates.map((candidate) => {
      const ui = getCandidateUiState(candidate);
      const bucket = getCandidatePresentationBucket(candidate, ui);
      return { candidate, ui, bucket };
    });

    const main = prepared.filter((entry) => entry.bucket !== 'unusable');
    const unusable = prepared.filter((entry) => entry.bucket === 'unusable');

    main.sort((a, b) => {
      const rankDiff = presentationBucketRank(a.bucket) - presentationBucketRank(b.bucket);
      if (rankDiff !== 0) return rankDiff;
      if (isBetterCandidate(a.candidate, b.candidate)) return -1;
      if (isBetterCandidate(b.candidate, a.candidate)) return 1;
      return 0;
    });

    unusable.sort((a, b) => {
      if (isBetterCandidate(a.candidate, b.candidate)) return -1;
      if (isBetterCandidate(b.candidate, a.candidate)) return 1;
      return 0;
    });

    return { main, unusable };
  }, [candidates]);

  const approvals = approvalsState.data || {};
  const approvedCount = approvals.approvedCount ?? safeArray(approvals.approvedStrategyIds).length;
  const maxApproved = approvals.maxApproved ?? '–';
  const sourceSummary = useMemo(() => sourceCounts(candidates), [candidates]);
  const approvedReadyCount = presentation.main.filter((entry) => entry.bucket === 'approved_ready').length;
  const reviewCount = presentation.main.filter((entry) => entry.bucket === 'candidate_ready_for_review').length;
  const blockedCount = presentation.main.filter((entry) => entry.bucket === 'blocked_fixable').length;
  const unusableCount = presentation.unusable.length;
  const viewTitle = mode === 'paper'
    ? 'Paper-kandidater från AI, Batch och Replay'
    : 'AI / Batch / Replay → Paper-kandidater';
  const viewSubtitle = mode === 'paper'
    ? 'Samma backend-data som i Lab. Fokus här är manuellt godkännande och runtime-readiness.'
    : 'Samma backend-data som i Paper Trading. Fokus här är preview, score och vad som kan sparas som kandidat.';
  const unusableExpanded = unusableCount <= 3 || showUnusable;

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
        <div className="badge badge-paper-only" style={{ whiteSpace: 'nowrap' }}>
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

      <div className="paper-candidate-summary">
        <div className="paper-candidate-summary-item candidate-summary-approved">
          <span>Godkända och redo</span>
          <strong>{approvedReadyCount}</strong>
        </div>
        <div className="paper-candidate-summary-item candidate-summary-review">
          <span>Behöver granskning</span>
          <strong>{reviewCount}</strong>
        </div>
        <div className="paper-candidate-summary-item candidate-summary-blocked">
          <span>Blockerade/fixbara</span>
          <strong>{blockedCount}</strong>
        </div>
        <div className="paper-candidate-summary-item candidate-summary-unusable">
          <span>Ej användbara</span>
          <strong>{unusableCount}</strong>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <span className="badge badge-paper-only">Förslag {sourceSummary.batch + sourceSummary.replay + sourceSummary.ai_agent}</span>
        <span className="badge badge-ready">Kandidat {candidates.length}</span>
        <span className="badge badge-warning">Runtime redo {readinessState.data?.summary?.runtimeReady ?? 0}</span>
        <span className="badge badge-approved">Approved {readinessState.data?.summary?.alreadyApproved ?? approvedCount}</span>
        <span className="badge badge-paper-only">Paper-testas {readinessState.data?.summary?.paperRunnable ?? 0}</span>
        <span className="badge badge-muted">Lärande via data/logg</span>
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
        {presentation.main.length > 0 ? presentation.main.map((entry) => {
          const candidate = entry.candidate;
          const ui = entry.ui;
          const approved = ui.uiStatus === 'approved_ready';
          const ready = ui.runtimeReady === true;
          const runnable = ui.paperRunnable === true;
          const canCreate = ui.uiStatus === 'candidate_ready_for_review'
            && ui.canCreatePaperCandidate
            && !candidate.saved
            && ['batch', 'replay'].includes(String(candidate.source || ''));
          const canApprove = ui.uiStatus === 'candidate_ready_for_review' && !!candidate.strategyId && !ui.alreadyApproved && !ui.blocked;
          const allowlistText = ui.alreadyApproved
            ? 'Approved'
            : candidate.allowlistStatus === 'max_nått'
              ? 'Max nått'
              : candidate.allowlistStatus === 'nekad'
                ? 'Nekad'
                : candidate.allowlistStatus === 'needs_strategy_id'
                  ? 'Saknar strategyId'
                  : 'Ej godkänd';
          const similarCount = Number(candidate.similarCount) > 1 ? candidate.similarCount : 0;

          return (
            <div key={candidateKey(candidate)} className={candidateCardClass(candidate, entry.bucket)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 4 }}>{candidate.displayName || candidate.strategyName || candidate.strategyId || 'Okänd kandidat'}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                    <span className={`badge ${sourceBadgeClass(candidate.source)}`}>{sourceLabel(candidate.source)}</span>
                    <span className="badge badge-paper-only">paper-only</span>
                    <span className="badge badge-muted">StrategyId: {candidate.strategyId || '–'}</span>
                    {similarCount > 1 ? (
                      <span className="badge badge-muted">{similarCount} liknande förslag samlade</span>
                    ) : null}
                  </div>
                </div>
                <div className={`badge ${ui.uiTone === 'success' ? 'badge-approved' : ui.uiTone === 'info' ? 'badge-ready' : ui.uiTone === 'warning' ? 'badge-warning' : 'badge-reject'}`}>
                  {ui.uiLabel}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 14 }}>
                <Metric label="Trades" value={candidate.metrics?.trades ?? '–'} />
                <Metric label="Win rate" value={candidate.metrics?.winRate != null ? `${candidate.metrics.winRate}%` : '–'} />
                <Metric label="PnL" value={candidate.metrics?.totalPnlPct != null ? `${candidate.metrics.totalPnlPct}%` : '–'} tone={metricClass(candidate.metrics?.totalPnlPct, 'pnl')} />
                <Metric label="Score" value={candidate.metrics?.score ?? '–'} />
                <Metric label="Confidence" value={candidate.recommendation?.confidence || '–'} tone={metricClass(candidate.recommendation?.confidence, 'confidence')} />
                <Metric label="Decision" value={DECISION_LABELS[candidate.recommendation?.decision] || candidate.recommendation?.decision || '–'} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                <span className={`badge ${ready ? 'badge-ready' : 'badge-reject'}`}>{ready ? 'Runtime ready' : 'Runtime ej redo'}</span>
                <span className={`badge ${runnable ? 'badge-ready' : 'badge-warning'}`}>{runnable ? 'Paper runnable' : 'Ej redo för paper-test'}</span>
                <span className={`badge ${ui.alreadyApproved ? 'badge-approved' : 'badge-warning'}`}>
                  {ui.alreadyApproved ? 'Already approved' : allowlistText}
                </span>
                <span className={`badge ${candidate.blockers?.length ? 'badge-reject' : 'badge-ready'}`}>
                  {candidate.blockers?.length ? `${candidate.blockers.length} blocker(s)` : 'Inga blockers'}
                </span>
                <span className={`badge ${confidenceTone(candidate)}`}>
                  Confidence {candidate.recommendation?.confidence || candidate.confidence || '–'}
                </span>
                <span className="badge badge-paper-only">Next action: {candidate.nextAction || '–'}</span>
                <span className={`badge ${sourceBadgeClass(candidate.source)}`}>Source: {sourceLabel(candidate.source)}</span>
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
              ) : ui.canShowReadyForPaperTest ? (
                <div className="callout callout-ready">
                  Redo för paper-test. Godkänd via paper allowlist och matchad mot runtime.
                </div>
              ) : (
                <div className={`callout ${ui.uiTone === 'danger' ? 'callout-danger' : ui.uiTone === 'warning' ? 'callout-warning' : 'callout-info'}`}>
                  {ui.reason || 'Redo för manuell granskning'}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, alignItems: 'center' }}>
                {approved ? (
                  <button type="button" disabled className="candidate-action candidate-action-create" title="Redan godkänd via paper allowlist">
                    Redan godkänd
                  </button>
                ) : canCreate ? (
                  <button
                    type="button"
                    disabled={busyKey === `create:${candidate.candidateId}` || candidate.saved}
                    onClick={() => createCandidate(candidate)}
                    className="candidate-action candidate-action-create"
                  >
                    {candidate.saved ? 'Redan sparad' : busyKey === `create:${candidate.candidateId}` ? 'Sparar...' : 'Skapa paper-testkandidat'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    title={ui.reason || 'Kan inte skapas ännu'}
                    className="candidate-action candidate-action-create"
                  >
                    Kan inte skapas ännu
                  </button>
                )}

                {canApprove ? (
                  <button
                    type="button"
                    disabled={busyKey === `approve:${candidate.strategyId}`}
                    onClick={() => approveCandidate(candidate)}
                    className="candidate-action candidate-action-approve"
                  >
                    {busyKey === `approve:${candidate.strategyId}`
                      ? 'Godkänner...'
                      : 'Lägg till i paper allowlist'}
                  </button>
                ) : null}

                <span className="candidate-next-action-note">
                  {approved
                    ? 'Approved via paper allowlist och matchad mot runtime.'
                    : ui.uiStatus === 'candidate_ready_for_review'
                      ? 'Du måste godkänna den innan paper trading testar den.'
                      : ui.reason || 'Godkänn manuellt när du vill lämna allowlist-status oförändrad tills dess.'}
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

      <div className="paper-unusable-section">
        <div className="paper-unusable-header">
          <div>
            <div className="paper-unusable-title">Ej användbara replay-resultat</div>
            <div className="paper-unusable-subtitle">
              Dessa replay-resultat saknar strategyId, har låg confidence eller är Reject. De kan inte paper-testas förrän de är mappade till en strategi.
            </div>
          </div>
          <div className="paper-unusable-header-actions">
            <span className="badge badge-reject">{unusableCount} resultat</span>
            {unusableCount > 3 ? (
              <button
                type="button"
                className="paper-unusable-toggle"
                onClick={() => setShowUnusable((value) => !value)}
              >
                {unusableExpanded ? 'Dölj detaljer' : 'Visa detaljer'}
              </button>
            ) : null}
          </div>
        </div>
        {unusableExpanded ? (
          <div className="paper-unusable-list">
            {presentation.unusable.length > 0 ? presentation.unusable.map((entry) => {
              const candidate = entry.candidate;
              const ui = entry.ui;
              const key = candidateKey(candidate);
              const open = !!expandedUnusableKeys[key];
              return (
                <div key={key} className={`paper-unusable-row ${ui.uiStatus === 'rejected' ? 'paper-unusable-row-rejected' : ''}`}>
                  <div className="paper-unusable-row-head">
                    <div>
                      <div className="paper-unusable-row-title">
                        {candidate.displayName || candidate.strategyName || candidate.strategyId || 'Okänd kandidat'}
                      </div>
                      <div className="paper-unusable-row-meta">
                        Source: {sourceLabel(candidate.source)} · Decision: {DECISION_LABELS[candidate.recommendation?.decision] || candidate.recommendation?.decision || '–'} · Next action: {candidate.nextAction || '–'}
                      </div>
                    </div>
                    <div className={`badge ${ui.uiTone === 'danger' ? 'badge-reject' : ui.uiTone === 'warning' ? 'badge-warning' : 'badge-neutral'}`}>
                      {ui.uiLabel}
                    </div>
                  </div>

                  <div className="paper-unusable-row-pills">
                    <span className="badge badge-muted">StrategyId: {candidate.strategyId || '–'}</span>
                    <span className={`badge ${confidenceTone(candidate)}`}>Confidence {candidate.recommendation?.confidence || candidate.confidence || '–'}</span>
                    <span className="badge badge-muted">Score {candidate.metrics?.score ?? '–'}</span>
                  </div>

                  <div className="paper-unusable-row-actions">
                    <button
                      type="button"
                      className="paper-unusable-toggle"
                      onClick={() => setExpandedUnusableKeys((prev) => ({ ...prev, [key]: !open }))}
                    >
                      {open ? 'Dölj detaljer' : 'Visa detaljer'}
                    </button>
                  </div>

                  {open ? (
                    <div className="paper-unusable-row-details">
                      <div>{candidate.explanation || candidate.recommendation?.reason || 'Replay-resultatet saknar tillräcklig metadata för paper-test.'}</div>
                      <div>{ui.reason || 'Kan inte bli paper-test ännu.'}</div>
                      <div>Runtime: {ui.runtimeReady ? 'Redo' : 'Ej redo'} · Paper runnable: {ui.paperRunnable ? 'Ja' : 'Nej'} · Blockers: {candidate.blockers?.length || 0}</div>
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <div className="paper-unusable-empty">Inga ej användbara replay-resultat just nu.</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Metric({ label, value, tone = 'metric-neutral' }) {
  return (
    <div className={`candidate-metric ${tone}`}>
      <div style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{value}</div>
    </div>
  );
}
