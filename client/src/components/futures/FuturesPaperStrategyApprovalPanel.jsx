import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ACTION_META,
  FILTERS,
  SIM_WARNING,
  applyFilter,
  availableActions,
  buildMutationRequest,
  compatibilityLabel,
  compatibilityExplanation,
  compatibilityTone,
  duplicateReason,
  emptyOperatorCredentials,
  filterCounts,
  interpretMutationResult,
  isDuplicate,
  leaderRows,
  mutationFollowUp,
  operatorMutationPreflight,
  passwordInputType,
  passwordToggleLabel,
  provenanceLabel,
  resultSummary,
  strategyDetailFields,
  statusLabel,
  statusTone,
  strategyId as pickStrategyId,
  toggleExpandedStrategyId,
} from '../../lib/futuresPaperStrategyApproval.mjs';
import {
  resolveKnownStrategy,
  strategyModelKey,
  strategyDisplayName,
} from '../../stores/strategyStore.js';
import { fmtMoney, numberOrNull } from '../../utils/tradingFormatters.js';

// Futures Paper Strategy Approval — knappar + tabell (paper_only).
//
// Muterar ENDAST Futures Paper approval-status via de fyra endpointsen. Skapar
// aldrig en trade, lägger ingen order, rör inte broker/live och muterar aldrig
// vanlig Paper Trading eller strategiinställningar/risk. All knapplogik, filter
// och resultat-format ligger i ../../lib/futuresPaperStrategyApproval.mjs.

const LIST_URL = '/api/futures-paper/strategies';
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data && (data.error || data.reason)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMutation(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function displaySafetyValue(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

async function parseResponseBody(res) {
  if (!res) return null;
  const contentType = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '');
  if (contentType.includes('application/json')) {
    return res.json().catch(() => null);
  }
  const text = await res.text().catch(() => '');
  const trimmed = String(text || '').trim();
  return trimmed ? { error: trimmed } : null;
}

const card = {
  background: 'var(--surface, #fff)',
  border: '1px solid var(--border, #e2e2e2)',
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
};

const badgeBase = {
  display: 'inline-block',
  fontSize: 12,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--border, #ddd)',
  lineHeight: 1.6,
  whiteSpace: 'nowrap',
};

const TONES = {
  success: { color: 'var(--success, #1a7f37)', borderColor: 'var(--success, #1a7f37)' },
  warning: { color: 'var(--warning, #9a6700)', borderColor: 'var(--warning, #9a6700)' },
  danger: { color: 'var(--danger, #cf222e)', borderColor: 'var(--danger, #cf222e)' },
  muted: { color: 'var(--muted, #6b7280)' },
};

function Badge({ tone, children }) {
  return <span style={{ ...badgeBase, ...(TONES[tone] || TONES.muted) }}>{children}</span>;
}

const table = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--border, #e2e2e2)', color: 'var(--muted, #6b7280)', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', borderBottom: '1px solid var(--border, #eee)', verticalAlign: 'top', wordBreak: 'break-word' };

// Actionknapp per ton, tydlig i både light och dark mode.
function actionButtonStyle(tone, disabled) {
  const t = TONES[tone] || TONES.muted;
  return {
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    background: 'transparent',
    border: `1px solid ${t.borderColor || t.color}`,
    color: t.color,
    borderRadius: 8,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
}

function fmtCount(value) {
  const n = numberOrNull(value);
  if (n === null) return '–';
  return n.toLocaleString('sv-SE', { maximumFractionDigits: 0 });
}

function approvalStrategyModel(strategy = {}) {
  const id = pickStrategyId(strategy);
  return resolveKnownStrategy({ ...(strategy.catalog || {}), strategyId: id });
}

function approvalRowKey(strategy = {}, index = 0) {
  const model = approvalStrategyModel(strategy);
  return strategyModelKey(model, [
    strategy.catalog?.displayName,
    strategy.catalog?.strategyName,
    strategy.catalog?.name,
    strategy.catalog?.family,
    strategy.catalog?.market,
    `approval-row-${index}`,
  ].filter(Boolean).join('|'));
}

function formatDetailValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
  if (value === null || value === undefined || value === '') return 'saknas';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ReadyInfoCard() {
  return (
    <div style={{ ...card, borderColor: 'var(--accent, #3b82f6)' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        Redo betyder tekniskt kompatibel med Futures Paper — inte att strategin är lönsam.
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted,#6b7280)', marginBottom: 6 }}>
        För att vara Redo måste strategin ha:
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--muted,#6b7280)' }}>
        <li>canonical strategy ID</li>
        <li>verifierad signalproducent eller end-to-end-bevis</li>
        <li>säker MNQ/MES-mappning</li>
        <li>giltig riktning</li>
        <li>stop/target-mappning</li>
        <li>ingen blockerande dublett eller pausstatus</li>
      </ul>
    </div>
  );
}

function StrategyDetails({ strategy }) {
  const explanation = compatibilityExplanation(strategy);
  const fields = strategyDetailFields(strategy);
  return (
    <div style={{ padding: 12, border: '1px solid var(--border,#e2e2e2)', borderRadius: 8, background: 'var(--surface-2,#fafafa)' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{explanation.title}</div>
      <div style={{ display: 'grid', gap: 3, marginBottom: 12, color: 'var(--muted,#6b7280)', fontSize: 13 }}>
        {explanation.lines.map((line) => <div key={line}>{line}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(280px, 1fr)', gap: '4px 12px', fontSize: 12 }}>
        {fields.map((field) => (
          <React.Fragment key={field.label}>
            <div style={{ fontFamily: 'var(--mono, monospace)', color: 'var(--muted,#6b7280)' }}>{field.label}</div>
            <div style={{ fontFamily: 'var(--mono, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {formatDetailValue(field.value)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function ProgressCell({ strategy }) {
  const r = resultSummary(strategy);
  const current = r.progressCurrent;
  const target = r.progressTarget;
  const hasProgress = current != null && target != null;
  const pct = hasProgress && target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--muted,#6b7280)' }}>Aktuell omgång</div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{fmtCount(current)}/{fmtCount(target)}</div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--border, #e2e2e2)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--success, #1a7f37)' : 'var(--accent, #3b82f6)' }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted,#6b7280)', marginTop: 4 }}>
        Historiskt totalt: {fmtCount(r.totalHistoricalClosedTrades)} trades
      </div>
    </div>
  );
}

function ResultCell({ strategy, currency }) {
  const r = resultSummary(strategy);
  if (!r.hasData) {
    return <span style={{ color: 'var(--muted, #6b7280)' }}>Inga avslutade trades</span>;
  }
  const net = numberOrNull(r.netPnlSek);
  const netTone = net !== null && net > 0 ? 'success' : net !== null && net < 0 ? 'danger' : 'muted';
  const pf = r.profitFactor === null ? (r.profitFactorNote === 'no_losing_trades' ? 'inga förluster' : '–') : r.profitFactor;
  return (
    <div style={{ display: 'grid', gap: 2, minWidth: 180 }}>
      <div>
        {fmtCount(r.closedTrades)} avslut · <span style={{ color: TONES.success.color }}>{fmtCount(r.wins)}V</span> / <span style={{ color: TONES.danger.color }}>{fmtCount(r.losses)}F</span>
        {r.breakevenTrades > 0 ? <span style={{ color: 'var(--muted,#6b7280)' }}> / {fmtCount(r.breakevenTrades)}BE</span> : null}
      </div>
      <div style={{ color: 'var(--muted, #6b7280)' }}>Win rate: {r.winRatePct === null ? '–' : `${r.winRatePct}%`}</div>
      <div style={{ fontWeight: 700, color: TONES[netTone].color }}>Netto: {fmtMoney(r.netPnlSek, currency, 2)}</div>
      <div style={{ color: 'var(--muted, #6b7280)', fontSize: 12 }}>
        Snitt/trade: {r.avgNetPnlSek === null ? '–' : fmtMoney(r.avgNetPnlSek, currency, 2)} · PF: {pf}
      </div>
      <div style={{ color: 'var(--muted, #6b7280)', fontSize: 11 }}>
        PnL-källa: {provenanceLabel(r.pnlProvenance)}
      </div>
    </div>
  );
}

function LeadersCard({ leaders, currency }) {
  const rows = leaderRows(leaders);
  return (
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>Topplistor</div>
      <div style={{ fontSize: 11, color: 'var(--warning, #9a6700)', marginBottom: 10 }}>
        Bygger på simulated_fallback — inte verklig marknadsprestanda.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {rows.map((row) => (
          <div key={row.key} style={{ border: '1px solid var(--border, #e2e2e2)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted,#6b7280)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{row.label}</div>
            {row.hasLeader ? (
              <>
                <div style={{ fontWeight: 700, marginTop: 4 }}>{strategyDisplayName(resolveKnownStrategy(row), '—')}</div>
                <div style={{ fontSize: 13 }}>
                  {row.unit === 'money' ? fmtMoney(row.value, currency, 2) : `${row.value ?? '–'}${row.unit === '%' ? '%' : (row.unit === 'V' ? ' vinster' : '')}`}
                  <span style={{ color: 'var(--muted,#6b7280)' }}> · {fmtCount(row.closedTrades)} trades</span>
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--muted,#6b7280)', marginTop: 4 }}>Ingen (för få trades)</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FuturesPaperStrategyApprovalPanel({ currency = 'USD' } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [filter, setFilter] = useState('pending_approval');
  const [busyId, setBusyId] = useState(null);
  const [rowMessage, setRowMessage] = useState({ id: null, tone: 'muted', text: null, detail: null });
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetchJson(LIST_URL);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err && err.message ? err.message : 'unavailable', data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const strategies = useMemo(() => {
    const list = state.data && Array.isArray(state.data.strategies) ? state.data.strategies : [];
    return list;
  }, [state.data]);

  const counts = useMemo(() => filterCounts(strategies), [strategies]);
  const visible = useMemo(() => applyFilter(strategies, filter), [strategies, filter]);

  const degraded = Boolean(state.data && state.data.degraded);
  const safety = state.data || {};

  const runSessionMutation = useCallback(async (strategy = null, actionId = null) => {
    const id = pickStrategyId(strategy);
    if (!id || !actionId) {
      setRowMessage({ id: null, tone: 'danger', text: 'Välj en strategiåtgärd först.', detail: null });
      return;
    }
    const meta = ACTION_META[actionId];
    setBusyId(id);
    setRowMessage({ id: null, tone: 'muted', text: null, detail: null });
    if (meta && meta.confirm) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(meta.confirm)) {
        setBusyId(null);
        return;
      }
    }
    const { url, options } = buildMutationRequest(id, actionId);
    let res = null; let data = null; let err = null;
    try {
      res = await fetchMutation(url, options);
      data = await parseResponseBody(res);
      const result = interpretMutationResult(res, data, null);
      if (!result.ok) {
        // Ingen optimistisk statusändring — behåll serverns senaste status, visa fel.
        setRowMessage({ id, tone: 'danger', text: result.message, detail: result.technicalDetail });
        return;
      }
      // Lyckad mutation → hämta ALLTID om listan (serverns verkliga status vinner).
      const followUp = mutationFollowUp(result);
      if (followUp.refetch) await load();
      setRowMessage({ id, tone: 'success', text: result.changed ? 'Uppdaterad.' : 'Ingen ändring (redan i det läget).' });
    } catch (e) {
      err = e;
      const result = interpretMutationResult(res, data, err);
      if (res && res.ok && data && data.ok !== false) {
        setRowMessage({ id, tone: 'warning', text: 'Åtgärd klar, men listan kunde inte hämtas om.' });
      } else {
        setRowMessage({ id, tone: 'danger', text: result.message, detail: result.technicalDetail });
      }
    } finally {
      setBusyId(null);
    }
  }, [load]);

  return (
    <div>
      {/* Simulated_fallback-varning (alltid synlig) */}
      <div style={{ ...card, borderColor: 'var(--warning, #9a6700)', background: 'var(--surface-2, #fff8e6)' }}>
        <strong>⚠︎ Paper-only.</strong> {SIM_WARNING}
        <div style={{ fontSize: 12, color: 'var(--muted, #6b7280)', marginTop: 4 }}>
          Knapparna ändrar endast Futures Paper approval-status. Ingen order, ingen broker, ingen live.
          mode={displaySafetyValue(safety.mode)} · actions_allowed={displaySafetyValue(safety.actions_allowed)} ·
          can_place_orders={displaySafetyValue(safety.can_place_orders)} · live_trading_enabled={displaySafetyValue(safety.live_trading_enabled)} ·
          broker_enabled={displaySafetyValue(safety.broker_enabled)}
        </div>
      </div>

      <ReadyInfoCard />

      {degraded ? (
        <div style={{ ...card, borderColor: 'var(--danger, #cf222e)' }}>
          <strong style={{ color: 'var(--danger, #cf222e)' }}>Approval-status körs i degraderat läge. Ändringar är tillfälligt blockerade.</strong>
          {' '}Godkännandelistan kunde inte läsas normalt — visar senaste kända status.
        </div>
      ) : null}

      {!state.loading && !state.error && state.data ? <LeadersCard leaders={state.data.leaders} currency={currency} /> : null}

      {/* Filter */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              style={{
                cursor: 'pointer',
                border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border, #ddd)'}`,
                background: active ? 'var(--accent, #3b82f6)' : 'transparent',
                color: active ? '#fff' : 'var(--text, inherit)',
                borderRadius: 999,
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {f.label} <span style={{ opacity: 0.75 }}>({counts[f.id] ?? 0})</span>
            </button>
          );
        })}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Futures Paper — strategigodkännande</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ color: 'var(--muted, #6b7280)', fontSize: 12 }}>
              Read-only status + paper-only mutationer · separat futures-lager
            </span>
            <button
              type="button"
              onClick={load}
              disabled={state.loading}
              style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '4px 10px', fontSize: 12, color: 'inherit' }}
            >
              Uppdatera
            </button>
          </div>
        </div>

        {state.loading ? (
          <div style={{ padding: 16, color: 'var(--muted, #6b7280)' }}>Laddar strategier…</div>
        ) : state.error ? (
          <div style={{ padding: 16, color: 'var(--danger, #cf222e)' }}>
            Kunde inte hämta strategier: {String(state.error)}
            {' '}(kontrollera att backend-endpointsen är driftsatta).
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted, #6b7280)' }}>Inga strategier matchar filtret.</div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Detaljer</th>
                  <th style={th}>Strategi</th>
                  <th style={th}>Strategy ID</th>
                  <th style={th}>Futures-kompatibilitet</th>
                  <th style={th}>Godkännandestatus</th>
                  <th style={th}>Progress</th>
                  <th style={th}>Resultat</th>
                  <th style={{ ...th, textAlign: 'right' }}>Åtgärd</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s, index) => {
                  const id = pickStrategyId(s);
                  const rowKey = approvalRowKey(s, index);
                  const strategy = approvalStrategyModel(s);
                  const dup = isDuplicate(s);
                  const actions = availableActions(s);
                  const busy = id ? busyId === id : false;
                  const msg = rowMessage.id === id ? rowMessage : null;
                  const catalog = s.catalog || {};
                  const expanded = expandedId === rowKey;
                  return (
                    <React.Fragment key={rowKey}>
                      <tr>
                        <td style={td}>
                          <button
                            type="button"
                            onClick={() => setExpandedId((current) => toggleExpandedStrategyId(current, rowKey))}
                            style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--border,#ddd)', borderRadius: 8, padding: '4px 8px', fontSize: 12, fontWeight: 700, color: 'inherit', whiteSpace: 'nowrap' }}
                            aria-expanded={expanded}
                          >
                            {expanded ? 'Dölj detaljer' : 'Visa varför'}
                          </button>
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>
                          {strategyDisplayName(strategy, '—')}
                          {strategy.strategyFamily ? <div style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted,#6b7280)' }}>{strategy.strategyFamily}</div> : null}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>{id || '—'}</td>
                        <td style={td}>
                          <Badge tone={compatibilityTone(s)}>{compatibilityLabel(s)}</Badge>
                        </td>
                        <td style={td}>
                          <Badge tone={statusTone(s)}>{statusLabel(s)}</Badge>
                        </td>
                        <td style={td}><ProgressCell strategy={s} /></td>
                        <td style={td}><ResultCell strategy={s} currency={currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {dup ? (
                            <Badge tone="warning">{duplicateReason(s)}</Badge>
                          ) : actions.length === 0 ? (
                            <span style={{ color: 'var(--muted, #6b7280)', fontSize: 12 }}>
                              {statusLabel(s) === 'Borttagen' ? 'Borttagen' : 'Behöver Futures-anpassning'}
                            </span>
                          ) : (
                            <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                              {actions.map((actionId) => {
                                const meta = ACTION_META[actionId];
                                return (
                                  <button
                                    key={actionId}
                                    type="button"
                                    disabled={busy || degraded || !id}
                                    onClick={() => runSessionMutation(s, actionId)}
                                    style={actionButtonStyle(meta.tone, busy || degraded)}
                                    title={degraded ? 'Blockerat i degraderat läge' : meta.label}
                                  >
                                    {busy ? '…' : meta.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {msg && msg.text ? (
                            <div style={{ marginTop: 4, fontSize: 12, color: TONES[msg.tone] ? TONES[msg.tone].color : 'var(--muted,#6b7280)' }}>
                              {msg.text}
                              {msg.detail ? (
                                <div style={{ marginTop: 2, color: 'var(--muted,#6b7280)', fontFamily: 'var(--mono, monospace)' }}>
                                  Teknisk detalj: {msg.detail}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td style={{ ...td, borderBottom: '1px solid var(--border,#eee)' }} colSpan={8}>
                            <StrategyDetails strategy={s} />
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
