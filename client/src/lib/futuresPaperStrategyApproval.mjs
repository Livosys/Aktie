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
  const current = Number(t.currentTestClosedTrades) || 0;
  const target = Number(t.currentTestTargetTrades) || 10;
  return { current, target };
}

export function isTestComplete(strategy) {
  const t = (strategy && strategy.currentTest) || {};
  if (t.currentTestStatus === 'completed') return true;
  const { current, target } = progress(strategy);
  return target > 0 && current >= target;
}

// ── Resultat per strategi (simulated_fallback) ──────────────────────────────

function numOrNull(value) {
  return value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
}

export function resultSummary(strategy) {
  const p = (strategy && strategy.historicalPerformance) || null;
  const prog = progress(strategy);
  const t = (strategy && strategy.currentTest) || {};
  return {
    closedTrades: p ? Number(p.closedTrades) || 0 : 0,
    wins: p ? Number(p.wins) || 0 : 0,
    losses: p ? Number(p.losses) || 0 : 0,
    breakevenTrades: p ? Number(p.breakevenTrades) || 0 : 0,
    winRatePct: p && p.winRatePct !== null && p.winRatePct !== undefined ? Number(p.winRatePct) : null,
    netPnlSek: p ? Number(p.netPnlSek) || 0 : 0,
    avgNetPnlSek: p ? numOrNull(p.avgNetPnlSek) : null,
    profitFactor: p ? numOrNull(p.profitFactor) : null,
    profitFactorNote: p && p.profitFactorNote ? String(p.profitFactorNote) : null,
    pnlProvenance: p && p.pnlProvenance ? String(p.pnlProvenance) : null,
    progressCurrent: prog.current,
    progressTarget: prog.target,
    // Historiskt totalt separeras alltid från aktuell testomgång.
    totalHistoricalClosedTrades: numOrNull(t.totalHistoricalClosedTrades) ?? (p ? Number(p.closedTrades) || 0 : 0),
    hasData: Boolean(p && Number(p.closedTrades) > 0),
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

// ── Topplistor (leaders) ─────────────────────────────────────────────────────
// Mappar backendens leaders-block till visningsrader. Ändrar inga värden.
export const LEADER_ROWS = Object.freeze([
  { key: 'highestNetPnl', label: 'Högst nettoresultat', unit: 'kr' },
  { key: 'highestWinRate', label: 'Högst win rate', unit: '%' },
  { key: 'mostWins', label: 'Flest vinster', unit: 'V' },
  { key: 'highestAverageNetPnl', label: 'Högst snitt per trade', unit: 'kr' },
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

export function buildMutationRequest(id, actionId) {
  return {
    url: mutationEndpoint(id, actionId),
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ...SAFETY_BODY }),
    },
  };
}

// Tolkar backendsvar → { ok, changed, status, message }. Ändrar ALDRIG status
// optimistiskt: vi litar bara på serverns status och hämtar om listan efteråt.
export function interpretMutationResult(res, data, err) {
  if (err) {
    return { ok: false, changed: false, status: null, message: err.message || 'network_error' };
  }
  const body = data && typeof data === 'object' ? data : {};
  const httpOk = res && typeof res.ok === 'boolean' ? res.ok : true;
  const ok = httpOk && body.ok !== false;
  if (!ok) {
    return {
      ok: false,
      changed: false,
      status: body.status || null,
      message: mutationErrorMessage(body),
    };
  }
  return {
    ok: true,
    changed: body.changed === true,
    status: safeStr(body.status),
    message: null,
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

export function mutationErrorMessage(body) {
  const b = body && typeof body === 'object' ? body : {};
  const reason = safeStr(b.reason) || safeStr(b.error);
  if (reason && ERROR_MESSAGES[reason]) return ERROR_MESSAGES[reason];
  if (reason) return `Åtgärden misslyckades: ${reason}`;
  return 'Åtgärden misslyckades. Serverns senaste status behålls.';
}

export const SIM_WARNING =
  'Resultaten bygger på simulated_fallback och är inte verklig marknadsprestanda.';
