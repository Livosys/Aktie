// Futures Paper Strategy Approval — ren, testbar UI-logik (ingen React, ingen fetch).
//
// paper_only. Denna modul avgör ENDAST vilka approval-knappar som ska visas,
// hur filter matchar, hur dubletter blockeras och hur resultat sammanfattas.
// Den skapar aldrig en trade, lägger ingen order, rör aldrig broker/live och
// muterar aldrig vanlig Paper Trading. Muterande anrop skickar alltid en
// hård paper-only-vakt i body (alla farliga flaggor = false).

// Oföränderliga säkerhetsflaggor som följer med varje muterande anrop.
export const SAFETY_BODY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

// Endast denna fakeout-strategi får godkännas. Dess dublett listas men blockeras.
export const CANONICAL_FAKEOUT_ID = 'narrow_fakeout_reversal_v1';
export const DUPLICATE_FAKEOUT_ID = 'narrow_state_fakeout_reversal';

export const STATUS = Object.freeze({ APPROVED: 'approved', PAUSED: 'paused', REMOVED: 'removed' });
export const COMPAT = Object.freeze({ READY: 'READY', NEEDS_MAPPING: 'NEEDS_MAPPING', UNSUPPORTED: 'UNSUPPORTED', BLOCKED: 'BLOCKED' });

// Åtgärds-id → { label, endpointAction, confirm }. endpointAction är backendens verb.
export const ACTION = Object.freeze({
  ADD: 'add',
  PAUSE: 'pause',
  RESUME: 'resume',
  REMOVE: 'remove',
});

export const ACTION_META = Object.freeze({
  [ACTION.ADD]: { label: 'Lägg till', endpointAction: 'approve', tone: 'success', confirm: null },
  [ACTION.PAUSE]: { label: 'Pausa', endpointAction: 'pause', tone: 'warning', confirm: null },
  [ACTION.RESUME]: { label: 'Återuppta', endpointAction: 'resume', tone: 'success', confirm: null },
  [ACTION.REMOVE]: {
    label: 'Ta bort',
    endpointAction: 'remove',
    tone: 'danger',
    confirm: 'Ta bort strategin från Futures Paper?\n\nNya trades stoppas, men historik och resultat sparas.',
  },
});

// ── Fältplockning (tolerant mot saknade objekt) ─────────────────────────────

function safeStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

export function strategyId(strategy) {
  const c = strategy && strategy.catalog;
  return safeStr((c && c.strategyId) || (strategy && strategy.strategyId));
}

export function approvalStatus(strategy) {
  const a = strategy && strategy.approval;
  return a && a.status ? String(a.status) : null; // null = saknas
}

export function compatibility(strategy) {
  const c = strategy && strategy.compatibility;
  return (c && c.compatibility) || COMPAT.UNSUPPORTED;
}

export function isReady(strategy) {
  return compatibility(strategy) === COMPAT.READY;
}

// En dublett känns igen på backendens canonicalReplacementId (t.ex.
// narrow_state_fakeout_reversal → narrow_fakeout_reversal_v1) eller på det
// kända dublett-id:t. Dubletter får aldrig godkännas.
export function replacementId(strategy) {
  const c = strategy && strategy.compatibility;
  return safeStr(c && c.canonicalReplacementId);
}

export function isDuplicate(strategy) {
  if (replacementId(strategy)) return true;
  return strategyId(strategy) === DUPLICATE_FAKEOUT_ID;
}

export function duplicateReason(strategy) {
  if (!isDuplicate(strategy)) return null;
  const replacement = replacementId(strategy) || CANONICAL_FAKEOUT_ID;
  return `Dublett. Använd ${replacement}.`;
}

// ── Knapplogik ──────────────────────────────────────────────────────────────
//
// Returnerar de åtgärds-id:n som ska visas för raden, i visningsordning.
// Dubletter och ej körbara strategier har inga åtgärder (bara blockeringsorsak).
export function availableActions(strategy) {
  if (isDuplicate(strategy)) return [];
  const status = approvalStatus(strategy);
  const ready = isReady(strategy);
  const actions = [];

  // Lägg till: READY och (ingen status eller borttagen).
  if (ready && (status === null || status === STATUS.REMOVED)) {
    actions.push(ACTION.ADD);
  }
  // Pausa: godkänd.
  if (status === STATUS.APPROVED) {
    actions.push(ACTION.PAUSE);
  }
  // Återuppta: pausad.
  if (status === STATUS.PAUSED) {
    actions.push(ACTION.RESUME);
  }
  // Ta bort: godkänd eller pausad.
  if (status === STATUS.APPROVED || status === STATUS.PAUSED) {
    actions.push(ACTION.REMOVE);
  }
  return actions;
}

// ── Testprogress / "klar" ───────────────────────────────────────────────────

export function progress(strategy) {
  const t = (strategy && strategy.currentTest) || {};
  const current = numOrNull(t.currentTestClosedTrades);
  const target = numOrNull(t.currentTestTargetTrades);
  return { current, target };
}

export function isTestComplete(strategy) {
  const t = (strategy && strategy.currentTest) || {};
  if (t.currentTestStatus === 'completed') return true;
  const { current, target } = progress(strategy);
  return target != null && current != null && target > 0 && current >= target;
}

// ── Resultat per strategi (simulated_fallback) ──────────────────────────────

function numOrNull(value) {
  return value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
}

export function resultSummary(strategy) {
  const p = (strategy && strategy.historicalPerformance) || null;
  const prog = progress(strategy);
  const t = (strategy && strategy.currentTest) || {};
  const closedTrades = p ? numOrNull(p.closedTrades) : null;
  return {
    closedTrades,
    wins: p ? numOrNull(p.wins) : null,
    losses: p ? numOrNull(p.losses) : null,
    breakevenTrades: p ? numOrNull(p.breakevenTrades) : null,
    winRatePct: p && p.winRatePct !== null && p.winRatePct !== undefined ? Number(p.winRatePct) : null,
    netPnlSek: p ? numOrNull(p.netPnlSek) : null,
    avgNetPnlSek: p ? numOrNull(p.avgNetPnlSek) : null,
    profitFactor: p ? numOrNull(p.profitFactor) : null,
    profitFactorNote: p && p.profitFactorNote ? String(p.profitFactorNote) : null,
    pnlProvenance: p && p.pnlProvenance ? String(p.pnlProvenance) : null,
    progressCurrent: prog.current,
    progressTarget: prog.target,
    // Historiskt totalt separeras alltid från aktuell testomgång.
    totalHistoricalClosedTrades: numOrNull(t.totalHistoricalClosedTrades) ?? closedTrades,
    hasData: Boolean(p && closedTrades != null && closedTrades > 0),
  };
}

// Fee-provenance i klartext.
export function provenanceLabel(prov) {
  switch (prov) {
    case 'stored_net': return 'Lagrad netto';
    case 'derived_with_current_commission': return 'Härledd (nuvarande courtage)';
    case 'mixed': return 'Blandad';
    default: return '–';
  }
}

// ── Radexpansion / kompatibilitetsdetaljer ──────────────────────────────────

export function toggleExpandedStrategyId(currentId, nextId) {
  const current = safeStr(currentId);
  const next = safeStr(nextId);
  if (!next) return current;
  return current === next ? null : next;
}

const STATUS_LABELS = Object.freeze({
  verified: 'verifierad',
  missing: 'saknas',
  supported: 'stöds',
  unsupported: 'stöds inte',
  unknown: 'okänd',
});

function statusValueLabel(value) {
  const v = safeStr(value);
  return v && STATUS_LABELS[v] ? STATUS_LABELS[v] : (v || 'saknas');
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

export function blockingReasonLabel(reason, strategy = null) {
  const r = safeStr(reason);
  const replacement = replacementId(strategy);
  switch (r) {
    case 'no_verified_signal_producer':
      return 'Ingen verifierad signalproducent når Futures Paper-scannern.';
    case 'duplicate_strategy':
      return `Den här strategin ersätts av ${replacement || CANONICAL_FAKEOUT_ID}.`;
    case 'no_safe_futures_mapping':
      return 'Strategin saknar säker mappning till MNQ/MES.';
    case 'catalog_status_paused':
      return 'Strategin är pausad i canonical katalog och kan inte godkännas.';
    case 'unverified_symbol_mapping':
      return 'Symbolmappningen är inte verifierad för Futures Paper.';
    case 'no_risk_mapping':
      return 'Stop och mål saknar säker Futures Paper-mappning.';
    case 'no_direction_mapping':
      return 'Riktningen saknar säker Futures Paper-mappning.';
    case 'unknown_strategy_id':
      return 'Strategin saknas i backendens canonical katalog.';
    default:
      return r ? `Backend blockerar: ${r}.` : 'Ingen blockeringsorsak från backend.';
  }
}

export function compatibilityExplanation(strategy) {
  const c = (strategy && strategy.compatibility) || {};
  const compat = compatibility(strategy);
  const reasons = listValue(c.blockingReasons);
  const replacement = safeStr(c.canonicalReplacementId);
  const roots = listValue(c.allowedRoots || c.roots);
  const lines = [];
  let title = compatibilityLabel(strategy);

  if (compat === COMPAT.READY) {
    title = 'Redo';
    if (c.producerStatus === 'verified') lines.push('En verifierad signalproducent finns.');
    if (c.symbolMappingStatus === 'supported') lines.push(`Strategin kan mappas till ${roots.length ? roots.join('/') : 'MNQ/MES'}.`);
    if (c.riskMappingStatus === 'supported') lines.push('Stop och mål kan översättas till Futures Paper.');
    if (lines.length === 0) lines.push('Backend markerar strategin som tekniskt kompatibel.');
    return { title, lines };
  }

  if (replacement || reasons.includes('duplicate_strategy')) {
    title = 'Dublett';
    lines.push(`Den här strategin ersätts av ${replacement || CANONICAL_FAKEOUT_ID}.`);
    lines.push('Använd den canonical strategin i stället.');
    return { title, lines };
  }

  if (reasons.includes('no_safe_futures_mapping')) {
    title = 'Ej stödd';
    const market = safeStr(strategy && strategy.catalog && strategy.catalog.market);
    if (market === 'crypto') lines.push('Strategin är byggd för crypto och saknar säker mappning till MNQ/MES.');
    else lines.push('Strategin saknar säker mappning till MNQ/MES.');
    return { title, lines };
  }

  if (reasons.includes('catalog_status_paused')) {
    title = 'Blockerad';
    lines.push('Strategin är pausad i canonical katalog och kan inte godkännas.');
    return { title, lines };
  }

  if (compat === COMPAT.NEEDS_MAPPING) title = 'Behöver Futures-anpassning';
  for (const reason of reasons) lines.push(blockingReasonLabel(reason, strategy));
  if (lines.length === 0) lines.push('Backend markerar att strategin behöver Futures-anpassning.');
  return { title, lines };
}

export function strategyDetailFields(strategy) {
  const s = strategy && typeof strategy === 'object' ? strategy : {};
  const c = s.compatibility || {};
  const catalog = s.catalog || {};
  const approval = s.approval || {};
  return [
    { label: 'compatibility', value: c.compatibility ?? null },
    { label: 'producerStatus', value: c.producerStatus ?? null },
    { label: 'producerEvidence', value: c.producerEvidence ?? null },
    { label: 'adapterStatus', value: c.adapterStatus ?? null },
    { label: 'riskMappingStatus', value: c.riskMappingStatus ?? null },
    { label: 'symbolMappingStatus', value: c.symbolMappingStatus ?? null },
    { label: 'blockingReasons', value: c.blockingReasons || [] },
    { label: 'canonicalReplacementId', value: c.canonicalReplacementId ?? null },
    { label: 'allowedRoots', value: c.allowedRoots || c.roots || [] },
    { label: 'catalog.status', value: catalog.status || catalog.catalogStatus || null },
    { label: 'catalog.signalRules', value: catalog.signalRules || catalog.signal_rules || [] },
    { label: 'approval.status', value: approval.status ?? null },
    { label: 'currentTest', value: s.currentTest || null },
    { label: 'historicalPerformance', value: s.historicalPerformance || null },
  ];
}

// ── Topplistor (leaders) ─────────────────────────────────────────────────────
// Mappar backendens leaders-block till visningsrader. Ändrar inga värden.
export const LEADER_ROWS = Object.freeze([
  { key: 'highestNetPnl', label: 'Högst nettoresultat', unit: 'money' },
  { key: 'highestWinRate', label: 'Högst win rate', unit: '%' },
  { key: 'mostWins', label: 'Flest vinster', unit: 'V' },
  { key: 'highestAverageNetPnl', label: 'Högst snitt per trade', unit: 'money' },
]);

export function leaderRows(leaders) {
  const l = leaders && typeof leaders === 'object' ? leaders : {};
  return LEADER_ROWS.map((row) => {
    const entry = l[row.key] || null;
    return {
      key: row.key,
      label: row.label,
      unit: row.unit,
      strategyId: entry ? entry.strategyId : null,
      displayName: entry ? (entry.displayName || entry.strategyId) : null,
      value: entry ? numOrNull(entry.value) : null,
      closedTrades: entry ? numOrNull(entry.closedTrades) : null,
      hasLeader: Boolean(entry && entry.strategyId),
    };
  });
}

// ── Filter ──────────────────────────────────────────────────────────────────

export const FILTERS = Object.freeze([
  { id: 'pending_approval', label: 'Väntar på godkännande' },
  { id: 'all', label: 'Alla' },
  { id: 'active', label: 'Aktiva' },
  { id: 'paused', label: 'Pausade' },
  { id: 'completed', label: 'Klara 10/10' },
  { id: 'removed', label: 'Borttagna' },
  { id: 'needs_mapping', label: 'Behöver Futures-anpassning' },
]);

export function matchesFilter(strategy, filterId) {
  const status = approvalStatus(strategy);
  switch (filterId) {
    case 'pending_approval':
      // Pending: recommended for review + not approved/paused/removed, not duplicate
      const recommended = strategy && strategy.recommendedForReview === true;
      return recommended && status === null && !isDuplicate(strategy);
    case 'all':
      return true;
    case 'active':
      return status === STATUS.APPROVED;
    case 'paused':
      return status === STATUS.PAUSED;
    case 'completed':
      return isTestComplete(strategy);
    case 'removed':
      return status === STATUS.REMOVED;
    case 'needs_mapping':
      // Ej körbar för futures (inkl. dubletter) — behöver anpassning.
      return !isReady(strategy) || isDuplicate(strategy);
    default:
      return true;
  }
}

export function applyFilter(strategies, filterId) {
  const list = Array.isArray(strategies) ? strategies : [];
  return list.filter((s) => s && !s.error && matchesFilter(s, filterId));
}

// Antal per filter (för räknare i filterknappar).
export function filterCounts(strategies) {
  const counts = {};
  for (const f of FILTERS) counts[f.id] = applyFilter(strategies, f.id).length;
  return counts;
}

// ── Etiketter ───────────────────────────────────────────────────────────────

export function statusLabel(strategy) {
  const status = approvalStatus(strategy);
  if (status === STATUS.APPROVED) return isTestComplete(strategy) ? 'Godkänd · klar' : 'Godkänd';
  if (status === STATUS.PAUSED) return 'Pausad';
  if (status === STATUS.REMOVED) return 'Borttagen';
  return 'Ej tillagd';
}

export function statusTone(strategy) {
  const status = approvalStatus(strategy);
  if (status === STATUS.APPROVED) return 'success';
  if (status === STATUS.PAUSED) return 'warning';
  if (status === STATUS.REMOVED) return 'muted';
  return 'muted';
}

export function compatibilityLabel(strategy) {
  switch (compatibility(strategy)) {
    case COMPAT.READY: return 'Redo';
    case COMPAT.NEEDS_MAPPING: return 'Behöver anpassning';
    case COMPAT.UNSUPPORTED: return 'Ej stödd';
    case COMPAT.BLOCKED: return 'Blockerad';
    default: return 'Okänd';
  }
}

export function compatibilityTone(strategy) {
  switch (compatibility(strategy)) {
    case COMPAT.READY: return 'success';
    case COMPAT.NEEDS_MAPPING: return 'warning';
    default: return 'danger';
  }
}

// ── Muterande anrop (endpoint + options; ingen fetch här) ───────────────────

export function mutationEndpoint(id, actionId) {
  const meta = ACTION_META[actionId];
  if (!meta) throw new Error(`unknown_action:${actionId}`);
  const safeId = encodeURIComponent(String(id || '').trim());
  return `/api/futures-paper/strategies/${safeId}/${meta.endpointAction}`;
}

export function isFuturesPaperMutationEndpoint(url) {
  return /^\/api\/futures-paper\/strategies\/[^/]+\/(approve|pause|resume|remove)$/.test(String(url || ''));
}

function base64Encode(value) {
  const raw = String(value);
  if (typeof btoa === 'function') return btoa(raw);
  if (typeof Buffer !== 'undefined') return Buffer.from(raw, 'utf8').toString('base64');
  throw new Error('base64_encoder_unavailable');
}

export function emptyOperatorCredentials() {
  return { username: '', password: '' };
}

export function passwordInputType(passwordVisible) {
  return passwordVisible ? 'text' : 'password';
}

export function passwordToggleLabel(passwordVisible) {
  return passwordVisible ? 'Dölj lösenord' : 'Visa lösenord';
}

export function buildBasicAuthHeader(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : {};
  const username = safeStr(c.username);
  const password = c.password === null || c.password === undefined ? null : String(c.password);
  if (!username || password === null || password === '') return null;
  return `Basic ${base64Encode(`${username}:${password}`)}`;
}

export function operatorMutationPreflight(credentials) {
  return {
    ok: true,
    authRequired: false,
    message: null,
    technicalDetail: null,
  };
}

export function buildMutationRequest(id, actionId, operatorCredentials = null) {
  const url = mutationEndpoint(id, actionId);
  const headers = { 'Content-Type': 'application/json' };
  return {
    url,
    options: {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ ...SAFETY_BODY }),
    },
  };
}

// Tolkar backendsvar → { ok, changed, status, message }. Ändrar ALDRIG status
// optimistiskt: vi litar bara på serverns status och hämtar om listan efteråt.
export function interpretMutationResult(res, data, err) {
  const httpStatus = res && Number(res.status) ? Number(res.status) : null;
  if (err) {
    const name = safeStr(err.name) || 'Error';
    return {
      ok: false,
      changed: false,
      status: null,
      httpStatus: null,
      reason: null,
      message: 'Kunde inte nå servern. Kontrollera anslutningen.',
      technicalDetail: `Network error: ${name}`,
      authRequired: false,
      forbidden: false,
      networkError: true,
    };
  }
  const body = data && typeof data === 'object' ? data : {};
  const httpOk = res && typeof res.ok === 'boolean' ? res.ok : true;
  const ok = httpOk && body.ok !== false;
  if (!ok) {
    const reason = sanitizeCredentialText(safeStr(body.reason) || safeStr(body.error) || '');
    return {
      ok: false,
      changed: false,
      status: body.status || null,
      httpStatus,
      reason,
      message: mutationErrorMessage(body, httpStatus),
      technicalDetail: mutationTechnicalDetail(httpStatus, body),
      authRequired: httpStatus === 401,
      forbidden: httpStatus === 403,
      networkError: false,
    };
  }
  return {
    ok: true,
    changed: body.changed === true,
    status: safeStr(body.status),
    httpStatus,
    reason: safeStr(body.reason),
    message: null,
    technicalDetail: null,
    authRequired: false,
    forbidden: false,
    networkError: false,
  };
}

const ERROR_MESSAGES = Object.freeze({
  duplicate_strategy: 'Dublett — kan inte godkännas. Använd narrow_fakeout_reversal_v1.',
  not_approvable_needs_mapping: 'Strategin behöver Futures-anpassning innan den kan läggas till.',
  not_approvable_unsupported: 'Strategin stöds inte för Futures Paper.',
  not_approvable_blocked: 'Strategin är blockerad i katalogen.',
  unknown_strategy_id: 'Okänt strategy-id.',
  not_in_futures_approval_store: 'Strategin finns inte i Futures-godkännandelistan.',
  cannot_pause_removed: 'Kan inte pausa en borttagen strategi.',
  futures_approval_state_degraded: 'Godkännandelistan är i degraderat läge — försök igen senare.',
  futures_strategy_approval_is_paper_only: 'Blockerat: endast paper-only tillåts.',
});

export function mutationErrorMessage(body, httpStatus = null) {
  const b = body && typeof body === 'object' ? body : {};
  const reason = sanitizeCredentialText(safeStr(b.reason) || safeStr(b.error) || '');
  if (httpStatus === 401) return 'Sessionen har gått ut. Logga in igen.';
  if (httpStatus === 403) return 'Du har inte behörighet att ändra strategier.';
  if (httpStatus === 503) return 'Approval-status är degraded. Ändringar är tillfälligt blockerade.';
  if ((httpStatus === 409 || httpStatus === 422) && reason) return ERROR_MESSAGES[reason] || `Backend blockerar åtgärden: ${reason}`;
  if (reason && ERROR_MESSAGES[reason]) return ERROR_MESSAGES[reason];
  if (reason) return `Åtgärden misslyckades: ${reason}`;
  return 'Åtgärden misslyckades. Serverns senaste status behålls.';
}

export function sanitizeCredentialText(value) {
  return String(value || '')
    .replace(/Basic\s+[A-Za-z0-9+/=._~-]+/gi, 'Basic [redacted]')
    .replace(/(authorization\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(username\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

export function mutationTechnicalDetail(httpStatus, body) {
  const b = body && typeof body === 'object' ? body : {};
  const parts = [];
  if (httpStatus) parts.push(`HTTP ${httpStatus}`);
  const status = safeStr(b.status);
  const reason = safeStr(b.reason) || safeStr(b.error);
  if (status) parts.push(`status=${status}`);
  if (reason) parts.push(`reason=${reason}`);
  if (Array.isArray(b.blockingReasons) && b.blockingReasons.length) {
    parts.push(`blockingReasons=${b.blockingReasons.map(String).join(',')}`);
  }
  if (safeStr(b.canonicalReplacementId)) parts.push(`canonicalReplacementId=${safeStr(b.canonicalReplacementId)}`);
  return sanitizeCredentialText(parts.join(' · ') || 'Ingen teknisk detalj från backend.');
}

export function mutationFollowUp(result) {
  return {
    refetch: Boolean(result && result.ok),
    optimisticStatus: null,
  };
}

export const SIM_WARNING =
  'Resultaten bygger på simulated_fallback och är inte verklig marknadsprestanda.';
