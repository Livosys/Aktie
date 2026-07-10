import React, { useEffect, useMemo, useState } from 'react';

// Read-only "Teknisk info" (steg A + B) för Futures Paper.
// Ingen edit, ingen apply, ingen aktivering/inaktivering, ingen risk, ingen order.
// Läser bara /api/futures-paper/technical/strategies och renderar canonical data.

const FETCH_TIMEOUT_MS = 8000;

const SIM_BANNER =
  'Alla nuvarande Futures Paper-affärer använder simulated_fallback. Det är en genererad ' +
  'paper-only prisfeed och inte riktig marknadsdata. Resultaten ska därför inte tolkas som ' +
  'verklig strategi-prestanda.';

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
function renderValue(value, emptyLabel = 'Ej tillgängligt') {
  if (value === null || value === undefined || value === '') return emptyLabel;
  if (Array.isArray(value)) {
    if (value.length === 0) return emptyLabel;
    return value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return emptyLabel;
    }
  }
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  return String(value);
}

function fmtNum(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value);
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

// En rad i parameter-tabellen: default / override / effective / source.
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
          <span style={{ color: 'var(--muted, #6b7280)' }}>Ingen override</span>
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
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Parameter</th>
              <th style={th}>Default</th>
              <th style={th}>Override</th>
              <th style={th}>Effective</th>
              <th style={th}>Source</th>
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
      <ParamGroup title="Entry och indikatorer" params={details.entryAndIndicators} />
      {numeric && numeric.available === false ? (
        <div style={{ marginTop: 8, color: 'var(--muted, #6b7280)', fontStyle: 'italic', fontSize: 13 }}>
          {numeric.note}
        </div>
      ) : null}
      <ParamGroup title="Risk och exit" params={details.riskAndExit} />
      <ParamGroup title="Session och data" params={details.sessionAndData} />
    </div>
  );
}

function SimulationSettings({ settings }) {
  if (!settings) return null;
  const contracts = Array.isArray(settings.contracts) ? settings.contracts : [];
  return (
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Simulations- och kontraktsinställningar</div>
      <div style={{ color: 'var(--muted, #6b7280)', fontSize: 13, marginBottom: 10 }}>
        {settings.note || 'Simulations- och kontraktsinställningar, inte strategiinställningar.'}
        {' '}
        fxUsdSek: <strong>{renderValue(settings.fxUsdSek)}</strong>{' · '}
        Feed: <Badge tone="warning">{renderValue(settings.feedSource)}</Badge>{' · '}
        Riktig marknadsdata: <strong>{settings.isRealMarketData ? 'Ja' : 'Nej'}</strong>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Kontrakt</th>
              <th style={th}>Point value USD</th>
              <th style={th}>Courtage/side USD</th>
              <th style={th}>Round-trip USD</th>
              <th style={th}>Round-trip SEK</th>
              <th style={th}>Feed</th>
              <th style={th}>Base price</th>
              <th style={th}>Max drift %</th>
              <th style={th}>Step %</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.root || Math.random()}>
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
        <strong>⚠︎ Paper-only, simulerad feed.</strong> {SIM_BANNER}
      </div>

      <SimulationSettings settings={state.data && state.data.simulationAndContractSettings} />

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Strategikatalog</div>
          <div style={{ color: 'var(--muted, #6b7280)', fontSize: 12 }}>
            Read-only · canonical: daytradingStrategyCatalogService
            {state.data && state.data.configHashSchemaVersion != null
              ? ` · configHash-schema v${state.data.configHashSchemaVersion}` : ''}
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
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}></th>
                  <th style={th}>Strategi</th>
                  <th style={th}>Strategy ID</th>
                  <th style={th}>Family</th>
                  <th style={th}>Riktning</th>
                  <th style={th}>Aktiv</th>
                  <th style={th}>Katalogstatus</th>
                  <th style={th}>Runtime</th>
                  <th style={th}>Timeframes</th>
                  <th style={th}>SL %</th>
                  <th style={th}>TP (R)</th>
                  <th style={th}>Hold min</th>
                  <th style={th}>Signal rules</th>
                  <th style={th}>Config hash</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((s) => {
                  const id = s && s.strategyId ? s.strategyId : Math.random().toString(36);
                  const isOpen = expanded.has(id);
                  if (s && s.error) {
                    return (
                      <tr key={id}>
                        <td style={td}></td>
                        <td style={td} colSpan={13}>
                          <Badge tone="danger">Fel</Badge> {renderValue(s.displayName || s.strategyId)} — {renderValue(s.errorMessage, 'kunde inte byggas')}
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
                            style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--border,#ddd)', borderRadius: 6, padding: '0 8px', color: 'inherit' }}
                          >
                            {isOpen ? '−' : '+'}
                          </button>
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>{renderValue(s.displayName)}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>{renderValue(s.strategyId)}</td>
                        <td style={td}>{renderValue(s.family)}</td>
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
                          {s.configHash ? String(s.configHash).slice(0, 12) + '…' : 'Ej tillgängligt'}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td style={{ ...td, background: 'var(--surface-2, #fafafa)' }} colSpan={14}>
                            <div style={{ marginBottom: 6, color: 'var(--muted,#6b7280)', fontSize: 12 }}>
                              Datakälla vid körning: <Badge tone="warning">{renderValue(s.dataSource)}</Badge>{' · '}
                              Symboler: {renderValue(s.supportedSymbols, s.supportedSymbolsNote || 'Ej tillgängligt i runtime')}
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
