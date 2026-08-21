import React, { useEffect, useMemo, useState } from 'react';
import {
  resolveKnownStrategy,
  strategyDisplayName,
} from '../../stores/strategyStore.js';
import { uiFactorySafeText } from '../../services/uiTerminologyService.js';

// Read-only "Teknisk info" (steg A + B) för Futures Paper.
// Ingen edit, ingen apply, ingen aktivering/inaktivering, ingen risk, ingen order.
// Läser bara /api/futures-paper/technical/strategies och renderar canonical data.

const FETCH_TIMEOUT_MS = 8000;

const SIM_BANNER =
  'Alla nuvarande Futures Paper-affärer använder simulerad prisdata. Resultaten ska därför ' +
  'inte tolkas som verklig strategi-prestanda.';

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Säker rendering av godtyckliga värden (null/undefined/array/object/primitiv).
function renderValue(value, emptyLabel = '—') {
  if (value === null || value === undefined || value === '') return emptyLabel;
  if (Array.isArray(value)) {
    if (value.length === 0) return emptyLabel;
    return uiFactorySafeText(value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', '));
  }
  if (typeof value === 'object') {
    try {
      return uiFactorySafeText(JSON.stringify(value));
    } catch (err) {
      return emptyLabel;
    }
  }
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  return uiFactorySafeText(value);
}

function fmtNum(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return Number(value);
}

const card = {
  background: 'var(--surface, #fff)',
  border: '1px solid var(--border, #e2e2e2)',
  borderRadius: 'var(--r)',
  padding: 'var(--s5)',
  marginBottom: 'var(--s5)',
};

const badgeBase = {
  display: 'inline-block',
  fontFamily: 'var(--data)',
  fontSize: 9.5,
  fontWeight: 400,
  padding: '2px 8px',
  borderRadius: 'var(--r-badge)',
  border: '1px solid var(--border, #ddd)',
  lineHeight: 1.6,
  textTransform: 'uppercase',
  letterSpacing: '.09em',
};

function Badge({ tone, children }) {
  const tones = {
    success: { color: 'var(--success, #1a7f37)', borderColor: 'var(--success, #1a7f37)' },
    warning: { color: 'var(--warning, #9a6700)', borderColor: 'var(--warning, #9a6700)' },
    danger: { color: 'var(--danger, #cf222e)', borderColor: 'var(--danger, #cf222e)' },
    muted: { color: 'var(--muted, #6b7280)' },
  };
  return <span style={{ ...badgeBase, ...(tones[tone] || tones.muted) }}>{children}</span>;
}

function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['active', 'fullyautomatic'].includes(s)) return 'success';
  if (['partial', 'partlyautomatic', 'experimental', 'unknown'].includes(s)) return 'warning';
  if (['paused', 'disabled', 'pausedorblocked', 'not_connected'].includes(s)) return 'danger';
  return 'muted';
}

// En rad i parameter-tabellen: standard / ändring / används / källa.
function ParamRow({ label, param }) {
  const p = param && typeof param === 'object' ? param : {};
  const hasOverride = p.override !== null && p.override !== undefined;
  const effectiveMissing = p.effective === null || p.effective === undefined;
  return (
    <tr>
      <td style={tdKey}>{label}</td>
      <td style={td}>{renderValue(p.default)}</td>
      <td style={td}>
        {hasOverride ? (
          <Badge tone="warning">{renderValue(p.override)}</Badge>
        ) : (
          <span style={{ color: 'var(--muted, #6b7280)' }}>Ingen ändring</span>
        )}
      </td>
      <td style={td}>
        {effectiveMissing ? (
          <span style={{ color: 'var(--muted, #6b7280)' }}>Kan inte verifieras</span>
        ) : (
          <strong>{renderValue(p.effective)}</strong>
        )}
      </td>
      <td style={{ ...td, color: 'var(--muted, #6b7280)', fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>
        {renderValue(p.source, '–')}
      </td>
    </tr>
  );
}

const table = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--border, #e2e2e2)', color: 'var(--muted, #6b7280)', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', borderBottom: '1px solid var(--border, #eee)', verticalAlign: 'top', wordBreak: 'break-word' };
const tdKey = { ...td, fontWeight: 600, whiteSpace: 'normal', maxWidth: 260 };

function ParamGroup({ title, params }) {
  const entries = Object.entries(params || {}).filter(([, v]) => v && typeof v === 'object' && 'effective' in v);
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--s4)' }}>
      <div style={{ fontWeight: 600, marginBottom: 'var(--s2)' }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Parameter</th>
              <th style={th}>Standard</th>
              <th style={th}>Ändring</th>
              <th style={th}>Används</th>
              <th style={th}>Källa</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, param]) => (
              <ParamRow key={key} label={key} param={param} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StrategyDetails(strategy) {
  const details = strategy && strategy.details ? strategy.details : null;
  if (!details) {
    return <div style={{ color: 'var(--muted, #6b7280)', padding: 8 }}>Inga strukturerade detaljer tillgängliga.</div>;
  }
  const numeric = details.entryAndIndicators && details.entryAndIndicators.numericIndicatorParameters;
  return (
    <div style={{ padding: '8px 4px 4px' }}>
      <ParamGroup title="Ingång och indikatorer" params={details.entryAndIndicators} />
      {numeric && numeric.available === false ? (
        <div style={{ marginTop: 8, color: 'var(--muted, #6b7280)', fontStyle: 'italic', fontSize: 13 }}>
          {renderValue(numeric.note)}
        </div>
      ) : null}
      <ParamGroup title="Risk och avslut" params={details.riskAndExit} />
      <ParamGroup title="Session och data" params={details.sessionAndData} />
    </div>
  );
}

function SimulationSettings({ settings }) {
  if (!settings) return null;
  const contracts = Array.isArray(settings.contracts) ? settings.contracts : [];
  return (
    <div style={card}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Simulerings- och kontraktsinställningar</div>
      <div style={{ color: 'var(--muted, #6b7280)', fontSize: 13, marginBottom: 10 }}>
        {renderValue(settings.note || 'Simulerings- och kontraktsinställningar, inte strategiinställningar.')}
        {' '}
        Växelkurs: <strong>{renderValue(settings.fxUsdSek)}</strong>{' · '}
        Prisdata: <Badge tone="warning">{renderValue(settings.feedSource)}</Badge>{' · '}
        Riktig marknadsdata: <strong>{settings.isRealMarketData ? 'Ja' : 'Nej'}</strong>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Kontrakt</th>
              <th style={th}>Punktvärde USD</th>
              <th style={th}>Courtage/sida USD</th>
              <th style={th}>Tur och retur USD</th>
              <th style={th}>Tur och retur SEK</th>
              <th style={th}>Prisdata</th>
              <th style={th}>Baspris</th>
              <th style={th}>Maxrörelse %</th>
              <th style={th}>Steg %</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c, index) => (
              <tr key={c.root || c.name || c.localSymbol || `contract-${index}`}>
                <td style={tdKey}>{renderValue(c.root)} <span style={{ color: 'var(--muted,#6b7280)', fontWeight: 400 }}>{renderValue(c.name, '')}</span></td>
                <td style={td}>{renderValue(c.pointValueUsd)}</td>
                <td style={td}>{renderValue(c.commissionPerSideUsd)}</td>
                <td style={td}>{renderValue(c.roundTripCommissionUsd)}</td>
                <td style={td}>{renderValue(c.roundTripCommissionSek)}</td>
                <td style={td}><Badge tone="warning">{renderValue(c.feedSource)}</Badge></td>
                <td style={td}>{renderValue(c.basePrice)}</td>
                <td style={td}>{renderValue(c.maxDriftPct)}</td>
                <td style={td}>{renderValue(c.stepPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FuturesTechnicalInfoPanel() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    fetchJson('/api/futures-paper/technical/strategies')
      .then((data) => { if (alive) setState({ loading: false, error: null, data }); })
      .catch((err) => { if (alive) setState({ loading: false, error: err && err.message ? err.message : 'unavailable', data: null }); });
    return () => { alive = false; };
  }, []);

  const strategies = useMemo(() => {
    const list = state.data && Array.isArray(state.data.strategies) ? state.data.strategies : [];
    return list;
  }, [state.data]);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div>
      <div style={{
        ...card,
        borderColor: 'var(--warning, #9a6700)',
        background: 'var(--surface-2, #fff8e6)',
      }}>
        <strong>Säker testdata.</strong> {SIM_BANNER}
      </div>

      <SimulationSettings settings={state.data && state.data.simulationAndContractSettings} />

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--s2)' }}>
          <div style={{ fontWeight: 600 }}>Strategikatalog</div>
          <div style={{ color: 'var(--muted, #6b7280)', fontSize: 12 }}>
            Läsvy · källa: strategikatalog
            {state.data && state.data.configHashSchemaVersion != null
              ? ` · profilversion ${state.data.configHashSchemaVersion}` : ''}
          </div>
        </div>

        {state.loading ? (
          <div style={{ padding: 16, color: 'var(--muted, #6b7280)' }}>Laddar strategier…</div>
        ) : state.error ? (
          <div style={{ padding: 16, color: 'var(--danger, #cf222e)' }}>
            Kunde inte hämta teknisk info: {renderValue(state.error, 'okänt fel')}
          </div>
        ) : strategies.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted, #6b7280)' }}>Inga strategier i katalogen.</div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 'var(--s4)' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}></th>
                  <th style={th}>Strategi</th>
                  <th style={th}>Intern nyckel</th>
                  <th style={th}>Familj</th>
                  <th style={th}>Riktning</th>
                  <th style={th}>Aktiv</th>
                  <th style={th}>Katalogstatus</th>
                  <th style={th}>Motorläge</th>
                  <th style={th}>Tidsramar</th>
                  <th style={th}>SL %</th>
                  <th style={th}>TP (R)</th>
                  <th style={th}>Tid min</th>
                  <th style={th}>Signalregler</th>
                  <th style={th}>Profilnyckel</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((s, index) => {
                  const strategy = resolveKnownStrategy(s || {});
                  const id = strategy.strategyId || s?.id || s?.displayName || `strategy-${index}`;
                  const isOpen = expanded.has(id);
                  if (s && s.error) {
                    return (
                      <tr key={id}>
                        <td style={td}></td>
                        <td style={td} colSpan={13}>
                          <Badge tone="danger">Fel</Badge> {strategyDisplayName(strategy, '—')} — {renderValue(s.errorMessage, 'kunde inte byggas')}
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <React.Fragment key={id}>
                      <tr>
                        <td style={td}>
                          <button
                            type="button"
                            onClick={() => toggle(id)}
                            aria-expanded={isOpen}
                            style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--border,#ddd)', borderRadius: 'var(--r-sm)', padding: '0 8px', color: 'inherit' }}
                          >
                            {isOpen ? '−' : '+'}
                          </button>
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>{strategyDisplayName(strategy, '—')}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>{renderValue(strategy.strategyId)}</td>
                        <td style={td}>{renderValue(strategy.strategyFamily)}</td>
                        <td style={td}>{renderValue(s.direction)}</td>
                        <td style={td}>{s.active ? <Badge tone="success">Ja</Badge> : <Badge tone="muted">Nej</Badge>}</td>
                        <td style={td}><Badge tone={statusTone(s.catalogStatus)}>{renderValue(s.catalogStatus)}</Badge></td>
                        <td style={td}><Badge tone={statusTone(s.runtimeStatus)}>{renderValue(s.runtimeStatus)}</Badge></td>
                        <td style={td}>{renderValue(s.defaultTimeframes)}</td>
                        <td style={td}>{renderValue(fmtNum(s.defaultStopLossPct))}</td>
                        <td style={td}>{renderValue(fmtNum(s.defaultTakeProfitR))}</td>
                        <td style={td}>{renderValue(fmtNum(s.defaultHoldingTimeMin))}</td>
                        <td style={td}>{Array.isArray(s.signalRules) ? s.signalRules.length : 0}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono, monospace)', fontSize: 11 }}>
                          {s.configHash ? String(s.configHash).slice(0, 12) + '…' : '—'}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td style={{ ...td, background: 'var(--surface-2, #fafafa)' }} colSpan={14}>
                            <div style={{ marginBottom: 6, color: 'var(--muted,#6b7280)', fontSize: 12 }}>
                              Datakälla vid körning: <Badge tone="warning">{renderValue(s.dataSource)}</Badge>{' · '}
                              Symboler: {renderValue(s.supportedSymbols, s.supportedSymbolsNote || '—')}
                            </div>
                            {StrategyDetails(s)}
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
