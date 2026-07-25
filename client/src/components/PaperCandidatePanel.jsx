import React, { useEffect, useMemo, useState } from 'react';
import {
  resolveStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import { EMPTY_VALUE, fmtNumber, numberOrNull } from '../utils/tradingFormatters.js';

const FETCH_TIMEOUT_MS = 6500;
const UNUSABLE_HIDDEN_STORAGE_KEY = 'paper-candidate-panel-hide-unusable-v1';

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = null) {
  const n = numberOrNull(value);
  return n === null ? fallback : n;
}

function boolLabel(value) {
  if (value === true) return 'Ja';
  if (value === false) return 'Nej';
  return EMPTY_VALUE;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function candidateStrategyModel(candidate = {}) {
  return resolveStrategy(candidate);
}

function candidateStrategyLabel(candidate = {}, fallback = '—') {
  return strategyDisplayName(candidateStrategyModel(candidate), fallback);
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

function sourceLabel(source) {
  const raw = safeString(source, EMPTY_VALUE).toLowerCase();
  if (raw === EMPTY_VALUE) return EMPTY_VALUE;
  if (raw.includes('ai_agent')) return 'AI-agent';
  if (raw.includes('replay')) return 'Replay';
  if (raw.includes('batch')) return 'Batch';
  return raw || EMPTY_VALUE;
}

function statusTone(status) {
  const key = safeString(status, EMPTY_VALUE);
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
  return safeString(source, EMPTY_VALUE).toLowerCase().includes('replay');
}

function isLowConfidenceCandidate(candidate) {
  const raw = safeString(candidate?.recommendation?.confidence ?? candidate?.confidence, '').toLowerCase();
  if (raw === 'low' || raw === 'låg' || raw === 'weak') return true;
  const score = numberOrNull(candidate?.recommendation?.confidence ?? candidate?.confidence);
  return score !== null && score < 50;
}

function getCandidateUiState(candidate) {
  const strategyId = safeString(candidateStrategyModel(candidate).strategyId);
  const decision = safeString(candidate?.recommendation?.decision || candidate?.decision).toLowerCase();
  const runtimeReadyState = candidate?.runtimeReady;
  const paperRunnableState = candidate?.paperRunnable;
  const runtimeReady = runtimeReadyState === true;
  const paperRunnable = paperRunnableState === true;
  const runtimeMissing = runtimeReadyState !== true && runtimeReadyState !== false;
  const paperRunnableMissing = paperRunnableState !== true && paperRunnableState !== false;
  const alreadyApproved = candidate?.alreadyApproved === true || normalizeStatus(candidate) === 'approved';
  const blocked = hasHardBlockers(candidate);
  const hasRejectDecision = decision === 'reject';
  const canCreatePaperCandidate = !!strategyId && !hasRejectDecision && !blocked && runtimeReady && paperRunnable;
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
  } else if (runtimeReadyState === false) {
    uiStatus = 'runtime_not_ready';
    uiLabel = 'Runtime ej redo';
    uiTone = 'danger';
    reason = 'Kandidaten saknar runtime-ready koppling eller har runtime-blockers.';
  } else if (paperRunnableState === false) {
    uiStatus = 'not_paper_runnable';
    uiLabel = 'Ej redo för paper-test';
    uiTone = 'warning';
    reason = 'Kandidaten är inte paper-runnable ännu.';
  } else if (runtimeMissing || paperRunnableMissing) {
    uiStatus = 'waiting_runtime';
    uiLabel = 'Väntar på runtime';
    uiTone = 'neutral';
    reason = 'Runtime- eller paper-runnable-status saknas i backendsvaret.';
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
  const strategyId = safeString(candidateStrategyModel(candidate).strategyId);
  const recommendationId = safeString(candidate?.recommendationId);
  const candidateId = safeString(candidate?.candidateId);
  const displayName = safeString(candidateStrategyLabel(candidate, ''));
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
  const strategyId = candidateStrategyModel(candidate).strategyId;
  return candidate.candidateId
    || candidate.recommendationId
    || (candidate.sourceRunId && candidate.variantId && `${candidate.sourceRunId}:${candidate.variantId}`)
    || (strategyId && `${candidate.source || 'source'}:${strategyId}`)
    || candidate.id
    || null;
}

function mergeCandidate(base, patch) {
  const merged = { ...base, ...patch };
  merged.metrics = { ...(base?.metrics || {}), ...(patch?.metrics || {}) };
  merged.recommendation = { ...(base?.recommendation || {}), ...(patch?.recommendation || {}) };
  merged.allowlistSnapshot = patch?.allowlistSnapshot || base?.allowlistSnapshot || null;
  merged.blockers = Array.isArray(patch?.blockers) ? patch.blockers : Array.isArray(base?.blockers) ? base.blockers : null;
  merged.runtimeReady = patch?.runtimeReady ?? base?.runtimeReady ?? null;
  merged.scannerConnected = patch?.scannerConnected ?? base?.scannerConnected ?? null;
  merged.paperRunnable = patch?.paperRunnable ?? base?.paperRunnable ?? null;
  merged.alreadyApproved = patch?.alreadyApproved ?? base?.alreadyApproved ?? null;
  merged.allowlistStatus = patch?.allowlistStatus || base?.allowlistStatus || null;
  merged.nextAction = patch?.nextAction || base?.nextAction || null;
  merged.allowlistReason = patch?.allowlistReason || base?.allowlistReason || '';
  merged.saved = patch?.saved ?? base?.saved ?? null;
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
    && (ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable' || ui.uiStatus === 'waiting_runtime')
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
  if (ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable' || ui.uiStatus === 'waiting_runtime') {
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
    good: { background: 'var(--surface)', color: 'var(--success)', border: 'var(--border)' },
    warn: { background: 'var(--surface)', color: 'var(--warning)', border: 'var(--border)' },
    bad: { background: 'var(--surface)', color: 'var(--danger)', border: 'var(--border)' },
    neutral: { background: 'var(--surface)', color: 'var(--text)', border: 'var(--border)' },
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

function badgeStyle(kind = 'neutral') {
  const palette = {
    good: 'var(--success)',
    warn: 'var(--warning)',
    bad: 'var(--danger)',
    info: 'var(--accent)',
    muted: 'var(--muted)',
    neutral: 'var(--text)',
  };
  return {
    ...chipStyle('neutral'),
    color: palette[kind] || palette.neutral,
    fontWeight: 800,
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
    const n = numberOrNull(value);
    if (n === null || n === 0) return 'metric-neutral';
    return n > 0 ? 'metric-positive' : 'metric-negative';
  }
  if (kind === 'confidence') {
    const n = numberOrNull(value);
    if (n === null) return 'metric-neutral';
    if (n < 50) return 'metric-low-confidence';
    if (n < 70) return 'metric-warning';
    return 'metric-positive';
  }
  return 'metric-neutral';
}

function confidenceTone(candidate) {
  const raw = safeString(candidate?.recommendation?.confidence ?? candidate?.confidence, '').toLowerCase();
  const score = numberOrNull(candidate?.recommendation?.confidence ?? candidate?.confidence);
  if (raw === 'low' || raw === 'låg' || raw === 'weak') return 'badge-low-confidence';
  if (score !== null && score < 50) return 'badge-low-confidence';
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
  const [hideUnusable, setHideUnusable] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(UNUSABLE_HIDDEN_STORAGE_KEY) === '1';
  });

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
    ? 'Paper-kandidater'
    : 'AI / Batch / Replay → Paper-kandidater';
  const viewSubtitle = mode === 'paper'
    ? 'Samma backend-data som i Lab. Fokus här är manuellt godkännande och runtime-readiness.'
    : 'Samma backend-data som i Paper Trading. Fokus här är preview, score och vad som kan sparas som kandidat.';
  const unusableExpanded = !hideUnusable && (unusableCount <= 3 || showUnusable);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(UNUSABLE_HIDDEN_STORAGE_KEY) === '1';
    setHideUnusable(stored);
  }, []);

  async function reloadAll() {
    setRefreshTick((tick) => tick + 1);
  }

  function setUnusableHidden(nextValue) {
    setHideUnusable(nextValue);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(UNUSABLE_HIDDEN_STORAGE_KEY, nextValue ? '1' : '0');
    }
    if (nextValue) setShowUnusable(false);
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
    const strategy = candidateStrategyModel(candidate);
    if (!strategy.strategyId) return;
    const ok = window.confirm('Detta godkänner endast låtsashandel. Inga riktiga order kan läggas.');
    if (!ok) return;
    setBusyKey(`approve:${strategy.strategyId}`);
    setMessage('');
    setError('');
    try {
      const res = await fetch('/api/automation/approvals/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategyId: strategy.strategyId,
          reason: `manual_ui_from_${mode}:${strategyDisplayName(strategy, strategy.strategyId)}`,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || 'Kunde inte lägga till i paper allowlist.');
      setMessage(`Lades till i paper allowlist: ${strategyDisplayName(strategy, strategy.strategyId)}.`);
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
        <div className="badge badge-paper-only" style={{ ...badgeStyle('info'), whiteSpace: 'nowrap' }}>
          allowlist {approvedCount} / {maxApproved}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <span className="badge badge-paper-only" style={badgeStyle('neutral')}>{presentation.main.length} kandidater</span>
        <span className="badge badge-ready" style={badgeStyle('good')}>{approvedReadyCount} redo</span>
        <span className="badge badge-warning" style={badgeStyle('warn')}>{reviewCount} behöver godkännas</span>
        <span className="badge badge-reject" style={badgeStyle('bad')}>{unusableCount} oanvändbara replay-resultat</span>
      </div>

      <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
        Paper-only research. Systemet får föreslå, men du godkänner manuellt.
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, color: 'var(--muted)', fontSize: 12 }}>
        <span>{previewState.loading ? 'Läser preview...' : `${previewRows.length} preview-kandidater`}</span>
        <span>{savedState.loading ? 'Läser saved...' : `${savedRows.length} sparade kandidater`}</span>
        <span>{readinessState.loading ? 'Läser readiness...' : `${readinessRows.length} readiness-kandidater`}</span>
        <span>Samma backenddata används i Lab och Paper Trading.</span>
      </div>

      <div style={{ marginTop: 14 }}>
        {presentation.main.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
              <thead>
                <tr>
                  {['Strategi', 'Symbol', 'Källa', 'Status', 'Confidence', 'Nästa steg', ''].map((label) => (
                    <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {presentation.main.map((entry) => {
                  const candidate = entry.candidate;
                  const ui = entry.ui;
                  const strategy = candidateStrategyModel(candidate);
                  const approved = ui.uiStatus === 'approved_ready';
                  const confidenceText = candidate.recommendation?.confidence ?? candidate.confidence ?? EMPTY_VALUE;
                  const statusText = approved
                    ? 'Redo'
                    : ui.uiStatus === 'candidate_ready_for_review'
                      ? 'Behöver godkännas'
                      : ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable'
                        ? 'Blockerad'
                        : 'Ej användbar';
                  const nextStep = approved
                    ? 'Redo för paper-test · Redan godkänd'
                    : ui.uiStatus === 'waiting_runtime'
                      ? 'Väntar på runtime-data'
                      : 'Behöver godkännas · Lägg till paper allowlist';
                  const key = candidateKey(candidate);
                  const open = !!expandedUnusableKeys[key];

                  return (
                    <React.Fragment key={key}>
                      <tr>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontWeight: 800, color: 'var(--text)' }}>{strategyDisplayName(strategy, '—')}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{strategy.strategyId || '—'}</div>
                        </td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>{candidate.symbol || '–'}</td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                          <span className={`badge ${sourceBadgeClass(candidate.source)}`} style={badgeStyle(candidate.source?.toLowerCase().includes('ai_agent') ? 'info' : candidate.source?.toLowerCase().includes('batch') ? 'muted' : candidate.source?.toLowerCase().includes('replay') ? 'muted' : 'neutral')}>{sourceLabel(candidate.source)}</span>
                        </td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                          <span className={`badge ${approved ? 'badge-approved' : ui.uiStatus === 'candidate_ready_for_review' ? 'badge-ready' : 'badge-warning'}`} style={badgeStyle(approved ? 'good' : ui.uiStatus === 'candidate_ready_for_review' ? 'info' : ui.uiStatus === 'blocked' || ui.uiStatus === 'runtime_not_ready' || ui.uiStatus === 'not_paper_runnable' ? 'warn' : 'neutral')}>{statusText}</span>
                        </td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>{confidenceText}</td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>{nextStep}</td>
                        <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                          <button
                            type="button"
                            className="paper-unusable-toggle"
                            onClick={() => setExpandedUnusableKeys((prev) => ({ ...prev, [key]: !prev[key] }))}
                          >
                            {open ? 'Dölj detaljer' : 'Visa detaljer'}
                          </button>
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={7} style={{ padding: '0 12px 12px 12px', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ marginTop: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
                              <div>strategyId: {strategy.strategyId || '—'} · runtime ready: {boolLabel(candidate.runtimeReady)} · paper runnable: {boolLabel(candidate.paperRunnable)}</div>
                              <div>Score: {candidate.metrics?.score ?? '–'} · Win rate: {candidate.metrics?.winRate != null ? `${candidate.metrics.winRate}%` : '–'} · PnL: {candidate.metrics?.totalPnlPct != null ? `${candidate.metrics.totalPnlPct}%` : '–'}</div>
                              <div>Blockers: {Array.isArray(candidate.blockers) ? fmtNumber(candidate.blockers.length) : EMPTY_VALUE} · Källa: {sourceLabel(candidate.source)} · Next action: {candidate.nextAction || EMPTY_VALUE}</div>
                              <div style={{ marginTop: 6, color: 'var(--muted)' }}>{candidate.explanation || candidate.recommendation?.reason || '–'}</div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            {previewState.loading || savedState.loading || readinessState.loading || approvalsState.loading
              ? 'Läser kandidatdata...'
              : 'Inga AI-/batch-/replay-kandidater hittades ännu.'}
          </div>
        )}
      </div>

      <div className="paper-unusable-section" style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface)', padding: 16 }}>
        <div className="paper-unusable-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="paper-unusable-title" style={{ fontSize: 16, fontWeight: 900 }}>Ej användbara replay-resultat</div>
            <div className="paper-unusable-subtitle" style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
              {hideUnusable ? 'Döljs bara i denna vy. Closed paper trades påverkas inte.' : 'Dessa replay-resultat saknar strategyId, har låg confidence eller är Reject. De kan inte paper-testas förrän de är mappade till en strategi.'}
            </div>
          </div>
          <div className="paper-unusable-header-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span className="badge badge-reject" style={badgeStyle('bad')}>{unusableCount} oanvändbara replay-resultat</span>
            <button
              type="button"
              className="paper-unusable-toggle"
              onClick={() => setUnusableHidden(!hideUnusable)}
            >
              {hideUnusable ? 'Visa detaljer' : 'Dölj oanvändbara'}
            </button>
            {!hideUnusable && unusableCount > 3 ? (
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
        {hideUnusable ? null : unusableExpanded ? (
          <div className="paper-unusable-list" style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            {presentation.unusable.length > 0 ? presentation.unusable.map((entry) => {
              const candidate = entry.candidate;
              const ui = entry.ui;
              const strategy = candidateStrategyModel(candidate);
              const key = candidateKey(candidate);
              const open = !!expandedUnusableKeys[key];
              return (
                <div key={key} className={`paper-unusable-row ${ui.uiStatus === 'rejected' ? 'paper-unusable-row-rejected' : ''}`} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)' }}>
                  <div className="paper-unusable-row-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <div>
                      <div className="paper-unusable-row-title" style={{ fontWeight: 800, color: 'var(--text)' }}>
                        {strategyDisplayName(strategy, '—')}
                      </div>
                      <div className="paper-unusable-row-meta" style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
                        Source: {sourceLabel(candidate.source)} · Decision: {DECISION_LABELS[candidate.recommendation?.decision] || candidate.recommendation?.decision || EMPTY_VALUE} · Next action: {candidate.nextAction || EMPTY_VALUE}
                      </div>
                    </div>
                    <div className={`badge ${ui.uiTone === 'danger' ? 'badge-reject' : ui.uiTone === 'warning' ? 'badge-warning' : 'badge-neutral'}`} style={badgeStyle(ui.uiTone === 'danger' ? 'bad' : ui.uiTone === 'warning' ? 'warn' : 'neutral')}>
                      {ui.uiLabel}
                    </div>
                  </div>

                  <div className="paper-unusable-row-pills" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    <span className="badge badge-muted" style={badgeStyle('muted')}>StrategyId: {strategy.strategyId || '—'}</span>
                    <span className={`badge ${confidenceTone(candidate)}`} style={badgeStyle(numberOrNull(candidate.recommendation?.confidence) !== null && numberOrNull(candidate.recommendation?.confidence) >= 70 ? 'good' : numberOrNull(candidate.recommendation?.confidence) !== null && numberOrNull(candidate.recommendation?.confidence) < 50 ? 'bad' : 'warn')}>Confidence {candidate.recommendation?.confidence ?? candidate.confidence ?? '–'}</span>
                    <span className="badge badge-muted" style={badgeStyle('muted')}>Score {candidate.metrics?.score ?? '–'}</span>
                  </div>

                  <div className="paper-unusable-row-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="paper-unusable-toggle"
                      onClick={() => setExpandedUnusableKeys((prev) => ({ ...prev, [key]: !open }))}
                    >
                      {open ? 'Dölj detaljer' : 'Visa detaljer'}
                    </button>
                  </div>

                  {open ? (
                    <div className="paper-unusable-row-details" style={{ marginTop: 10, color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
                      <div>{candidate.explanation || candidate.recommendation?.reason || 'Replay-resultatet saknar tillräcklig metadata för paper-test.'}</div>
                      <div>{ui.reason || 'Kan inte bli paper-test ännu.'}</div>
	                      <div>Runtime: {boolLabel(candidate.runtimeReady)} · Paper runnable: {boolLabel(candidate.paperRunnable)} · Blockers: {Array.isArray(candidate.blockers) ? fmtNumber(candidate.blockers.length) : EMPTY_VALUE}</div>
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <div className="paper-unusable-empty" style={{ color: 'var(--muted)', fontSize: 13 }}>Inga ej användbara replay-resultat just nu.</div>
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
