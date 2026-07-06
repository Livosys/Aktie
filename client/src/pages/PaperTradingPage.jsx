import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PaperCandidatePanel from '../components/PaperCandidatePanel.jsx';
import TradingViewTestBlueprintPanel from '../components/TradingViewTestBlueprintPanel.jsx';
import TradingViewTestResultsPanel from '../components/TradingViewTestResultsPanel.jsx';
import tradingViewTestBlueprintFallback from '../utils/tradingview-test-blueprints.json';

const REFRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 6_500;

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
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

function getThemeMode() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function useThemeMode() {
  const [theme, setTheme] = useState(getThemeMode());

  useEffect(() => {
    const handler = () => setTheme(getThemeMode());
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  return theme;
}

function usePaperRuntime(limit = 50) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    let alive = true;
    let activeController = null;
    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout(`/api/paper-trading/runtime?limit=${encodeURIComponent(limit)}`, {
        signal: activeController.signal,
      })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: err?.message || 'paper_runtime_unavailable',
            data: prev.data || null,
          }));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (activeController) activeController.abort();
    };
  }, [limit]);

  return state;
}

function fmtTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '–';
  return date.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPct(value) {
  if (value == null || Number.isNaN(Number(value))) return '–';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function toneForResult(result) {
  const key = String(result || '').toUpperCase();
  if (key === 'WIN') return 'var(--success)';
  if (key === 'LOSS') return 'var(--danger)';
  if (key === 'OPEN') return 'var(--accent)';
  if (key === 'TIMEOUT') return 'var(--warning)';
  return 'var(--muted)';
}

function cellStyle() {
  return {
    padding: '10px 12px',
    borderBottom: '1px solid var(--border)',
    fontSize: 12,
    verticalAlign: 'top',
  };
}

function sectionStyle() {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 18,
    marginBottom: 18,
  };
}

function sectionFrameStyle(theme = null, extra = {}) {
  const isLight = (theme || getThemeMode()) === 'light';
  return {
    background: extra.background || 'var(--surface)',
    border: extra.border || '1px solid var(--border)',
    borderRadius: extra.borderRadius || 14,
    padding: extra.padding || 18,
    marginBottom: extra.marginBottom ?? 18,
    boxShadow: extra.boxShadow || (isLight ? '0 10px 24px rgba(15,23,42,0.06)' : '0 18px 40px rgba(2,6,23,0.18)'),
  };
}

function subtleToneColors(theme = null) {
  const isLight = (theme || getThemeMode()) === 'light';
  return {
    neutral: {
      border: 'var(--border)',
      bg: 'var(--surface-2)',
      fg: 'var(--text)',
    },
    success: {
      border: isLight ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.28)',
      bg: isLight ? 'var(--surface-2)' : 'rgba(34,197,94,0.12)',
      fg: isLight ? '#166534' : '#dcfce7',
    },
    danger: {
      border: isLight ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.28)',
      bg: isLight ? 'var(--surface-2)' : 'rgba(239,68,68,0.12)',
      fg: isLight ? '#b91c1c' : '#fecaca',
    },
    warning: {
      border: isLight ? 'rgba(245,158,11,0.20)' : 'rgba(245,158,11,0.30)',
      bg: isLight ? 'var(--surface-2)' : 'rgba(245,158,11,0.12)',
      fg: isLight ? '#92400e' : '#ffedd5',
    },
    info: {
      border: isLight ? 'rgba(59,130,246,0.18)' : 'rgba(56,189,248,0.28)',
      bg: isLight ? 'var(--surface-2)' : 'rgba(56,189,248,0.12)',
      fg: isLight ? '#1d4ed8' : '#dbeafe',
    },
  };
}

function mutedTextStyle(theme = null) {
  return { color: 'var(--muted)' };
}

function statusPillStyle(tone = 'neutral', theme = null, compact = false) {
  const cfg = subtleToneColors(theme)[tone] || subtleToneColors(theme).neutral;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: compact ? '4px 8px' : '6px 10px',
    borderRadius: 999,
    border: `1px solid ${cfg.border}`,
    background: cfg.bg,
    color: cfg.fg,
    fontSize: compact ? 10.5 : 11,
    fontWeight: 900,
    lineHeight: 1.2,
  };
}

function SafetyBanner({ safety }) {
  return (
    <div style={{
      ...sectionStyle(),
      display: 'flex',
      flexWrap: 'wrap',
      gap: 10,
      alignItems: 'center',
      background: 'var(--surface)',
    }}>
      <strong style={{ color: 'var(--text)' }}>Endast låtsashandel</strong>
      <span style={statusPillStyle('success')}>Inga riktiga order</span>
      <span style={statusPillStyle('neutral')}>Broker avstängd</span>
      <span style={statusPillStyle('neutral')}>Live trading avstängd</span>
      <span style={statusPillStyle('info')}>actions_allowed={String(safety?.actions_allowed === true)}</span>
      <span style={statusPillStyle('info')}>can_place_orders={String(safety?.can_place_orders === true)}</span>
    </div>
  );
}

function previewValue(value, fallback = '–') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function previewNumber(value, digits = 2, fallback = '–') {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num >= 0 ? `+${num.toFixed(digits)}` : num.toFixed(digits);
}

function previewDecision(value) {
  const text = previewValue(value);
  if (text === '–') return text;
  return text.replace(/_/g, ' ');
}

function DailySelectionPreviewPanel({ preview }) {
  const theme = useThemeMode();
  const candidates = Array.isArray(preview?.candidates) ? preview.candidates.slice(0, 3) : [];
  const selectionCount = Number(preview?.selectionCount) || 3;
  const selectedCount = Number(preview?.selectedCount) || candidates.length;
  const dateLabel = previewValue(preview?.date);
  const emptyText = previewValue(preview?.emptyStateText, 'Inga säkra kandidater just nu');
  const partialState = selectedCount > 0 && selectedCount < selectionCount;

  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Dagens 3 paper-kandidater</h2>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13 }}>
            Systemet visar 3 möjliga kandidater för framtida daglig paper trading. Inga trades skapas härifrån.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={statusPillStyle('info', theme)}>
            Preview av framtida 3-per-dag-logik
          </span>
          <span style={statusPillStyle('neutral', theme)}>
            {selectedCount}/{selectionCount}
          </span>
        </div>
      </div>

      <div style={{ ...mutedTextStyle(theme), fontSize: 12, marginBottom: 12 }}>
        Datum: {dateLabel} · Urvalet är stabilt under dagen och ändras först när datumet ändras.
      </div>

      {partialState ? (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 12, border: statusPillStyle('warning', theme).border, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, fontWeight: 700 }}>
          Det finns inte 3 säkra kandidater just nu. Systemet väntar på bättre signaler.
        </div>
      ) : null}

      {candidates.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
          {candidates.map((candidate, index) => {
            const key = candidate?.candidateId || `${previewValue(candidate?.canonicalStrategyId)}:${previewValue(candidate?.symbol)}:${index}`;
            return (
              <div
                key={key}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 16,
                  padding: 16,
                  background: 'var(--surface)',
                  boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.05)' : '0 12px 28px rgba(2,6,23,0.12)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 900, lineHeight: 1.15 }}>
                      {previewValue(candidate?.symbol)} <span style={{ ...mutedTextStyle(theme), fontWeight: 700 }}>· {previewValue(candidate?.strategyName)}</span>
                    </div>
                    <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 12 }}>
                      {previewValue(candidate?.canonicalStrategyId)}
                    </div>
                  </div>
                  <span style={statusPillStyle('info', theme)}>
                    {previewValue(candidate?.safetyLabel, 'Preview only')}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 14 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Setup / source</div>
                    <div style={{ marginTop: 4, fontWeight: 800, fontSize: 13 }}>{previewValue(candidate?.setup)}</div>
                    <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>{previewValue(candidate?.source)}</div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Confidence / score</div>
                    <div style={{ marginTop: 4, fontWeight: 800, fontSize: 13 }}>
                      Confidence: {previewValue(candidate?.confidence)}
                    </div>
                    <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>
                      Score: {previewValue(candidate?.score)}
                    </div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Win rate / pnl</div>
                    <div style={{ marginTop: 4, fontWeight: 800, fontSize: 13 }}>
                      Win rate: {previewValue(candidate?.winRate)}{candidate?.winRate != null && candidate?.winRate !== '–' ? '%' : ''}
                    </div>
                    <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>
                      PnL: {previewValue(candidate?.pnl)}
                    </div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Decision / time</div>
                    <div style={{ marginTop: 4, fontWeight: 800, fontSize: 13 }}>{previewDecision(candidate?.decision)}</div>
                    <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>{fmtTime(candidate?.latestActivityAt)}</div>
                  </div>
                </div>

                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
                  Varför: {previewValue(candidate?.reason)}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  <span style={statusPillStyle('success', theme)}>Preview only</span>
                  <span style={statusPillStyle('danger', theme)}>Ingen order</span>
                  <span style={statusPillStyle('warning', theme)}>Ingen trade skapad</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }}>
          <div style={{ fontWeight: 800 }}>{emptyText}</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme) }}>Systemet väntar på bättre signaler innan något säkert urval visas.</div>
        </div>
      )}
    </div>
  );
}

function TopStrategySelectorPanel({ preview }) {
  const theme = useThemeMode();
  const topStrategies = Array.isArray(preview?.candidates) ? preview.candidates.slice(0, 3) : [];
  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Top 3 paper candidates</h2>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13 }}>
            Runtime-baserad preview från befintlig paper trading-data. Detta är read-only och skapar inga order.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={statusPillStyle('info', theme)}>mode=paper_only</span>
          <span style={statusPillStyle('neutral', theme)}>{topStrategies.length}/3</span>
        </div>
      </div>

      <div style={{ ...mutedTextStyle(theme), fontSize: 12, marginBottom: 12 }}>
        Källa: paper runtime daily selection preview · scanned={preview?.totalScanned ?? '–'}
      </div>

      {topStrategies.length ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {topStrategies.map((row) => (
            <div key={`${row.candidateId || row.symbol || 'unknown'}:${row.canonicalStrategyId || row.strategyId || 0}`} style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 14, background: 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900, color: 'var(--text)' }}>
                    {row.strategyName || row.canonicalStrategyId || row.strategyId || 'Okänd strategi'}
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                    {previewValue(row.symbol)} · {previewValue(row.source)}
                  </div>
                </div>
                <span style={statusPillStyle(row.blockedBy ? 'warning' : 'success', theme)}>
                  {row.blockedBy ? 'Blockerad' : 'Preview'}
                </span>
              </div>
              <div style={{ marginTop: 10, color: 'var(--text)', lineHeight: 1.55, fontSize: 13 }}>
                {previewValue(row.reason, 'Read-only urval utan orderväg.')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                <span style={statusPillStyle('neutral', theme)}>symbol {previewValue(row.symbol)}</span>
                <span style={statusPillStyle('neutral', theme)}>setup {previewValue(row.setup)}</span>
                <span style={statusPillStyle('neutral', theme)}>score {previewValue(row.score)}</span>
                <span style={statusPillStyle('neutral', theme)}>confidence {previewValue(row.confidence)}</span>
              </div>
              {row.blockedBy ? (
                <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <span style={statusPillStyle('danger', theme)}>{row.blockedBy}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }}>
          <div style={{ fontWeight: 800 }}>{preview?.emptyStateText || 'Inga top 3-kandidater att visa ännu.'}</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme) }}>Systemet väntar på runtime-kandidater som passerar preview-reglerna.</div>
        </div>
      )}
    </div>
  );
}

function SummaryGrid({ runtime }) {
  const theme = useThemeMode();
  const summary = runtime?.summary || {};
  const shown = summary.returnedCount ?? 0;
  const limit = summary.limit ?? 50;
  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Paper trading runtime</h2>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4 }}>Verkliga paper-only records från runtime-filerna.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link to="/live">Till Signalpuls</Link>
          <Link to="/system">Till System</Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {[
          ['Open', summary.openCount ?? 0],
          ['Closed', summary.closedCount ?? 0],
          ['Events', summary.eventCount ?? 0],
          ['Blocked', summary.blockedCount ?? 0],
        ].map(([label, value]) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
            <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 12, color: 'var(--text)', fontSize: 13 }}>
        <strong>Visar senaste {shown}/{limit} paper records</strong>
        <span>Senaste event: {fmtTime(summary.latestEventAt)}</span>
        <span>mode=paper_only</span>
      </div>
      {shown < limit && (
        <div style={{ marginTop: 10, ...mutedTextStyle(theme), fontSize: 13 }}>
          Visar senaste {shown}/{limit} paper records. Systemet har inte skapat {limit} ännu.
        </div>
      )}
    </div>
  );
}

function DataTable({ title, subtitle, columns, rows, emptyText, rowKey }) {
  const theme = useThemeMode();
  return (
    <div style={sectionStyle()}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
        {subtitle && <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13 }}>{subtitle}</div>}
      </div>
      {rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} style={{ ...cellStyle(), ...mutedTextStyle(theme), textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={rowKey(row, index)}>
                  {columns.map((column) => (
                    <td key={column.key} style={cellStyle()}>
                      {column.render ? column.render(row) : row[column.key] ?? '–'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ ...mutedTextStyle(theme), fontSize: 13 }}>{emptyText}</div>
      )}
    </div>
  );
}

function usePaperAllowlist(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/paper-allowlist/status')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa paper allowlist-status.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function friendlyAllowlistError(err, fallback) {
  const message = String(err?.message || '').trim();
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return fallback;
  if (/^timeout_after_\d+ms$/i.test(message)) return `${fallback} (timeout)`;
  return message || fallback;
}

function friendlyTradeExplanationError(err, fallback) {
  const message = String(err?.message || '').trim();
  if (/^HTTP 404$/i.test(message)) return fallback;
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return fallback;
  if (/^timeout_after_\d+ms$/i.test(message)) return `${fallback} (timeout)`;
  return message || fallback;
}

function friendlyBlueprintError(err) {
  const message = String(err?.message || '').trim();
  if (/^HTTP 404$/i.test(message)) return 'Blueprint-data saknas ännu';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Blueprint-källa inte ansluten ännu';
  if (/^timeout_after_\d+ms$/i.test(message)) return 'Blueprint-källa inte ansluten ännu (timeout)';
  return message || 'Blueprint-källa inte ansluten ännu';
}

async function fetchTradingViewBlueprintPayload() {
  try {
    return await fetchJsonWithTimeout('/api/paper-trading/tradingview-test-blueprints');
  } catch (err) {
    const message = String(err?.message || '').trim();
    const isConnectivityIssue = /^HTTP 404$/i.test(message) || /Failed to fetch|NetworkError|Load failed/i.test(message);
    if (!isConnectivityIssue) throw err;
    return tradingViewTestBlueprintFallback;
  }
}

function friendlyLossReviewError(err, fallback) {
  return friendlyTradeExplanationError(err, fallback);
}

function useLossReviewQueue(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/loss-review-queue')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyLossReviewError(err, 'Loss review queue är tillfälligt otillgängligt.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);

  return state;
}

function usePaperAllowlistConfig(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/paper-allowlist/config')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa allowlist-config.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function usePaperMarketConfig(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/market-config')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa paper market-config.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useSafetyStatus(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/safety/status')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa safety-status.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useGateStatus(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/gate-status')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa gate-status.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useRiskPauseSummary(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/risk-pause-summary')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: err?.message || 'Kunde inte läsa risk pause summary.',
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useApprovalPreview(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/approval-preview')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa approval preview.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useTradingViewBlueprints(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const emptyPayload = useMemo(() => ({
    ok: true,
    status: 'empty',
    source: 'none',
    blueprints: [],
    summary: {
      strategies: 0,
      pineScriptPossible: 0,
      needsAttention: 0,
      directionBoth: 0,
    },
  }), []);

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchTradingViewBlueprintPayload()
      .then((data) => {
        if (!alive) return;
        const normalized = data && typeof data === 'object'
          ? {
              ...data,
              source: data.source || (Array.isArray(data.blueprints) && data.blueprints.length ? 'file' : 'none'),
            }
          : emptyPayload;
        setState({ loading: false, data: normalized, error: null });
      })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: emptyPayload,
          error: friendlyBlueprintError(err),
        });
      });
    return () => { alive = false; };
  }, [emptyPayload, refreshKey]);

  return state;
}

function useTradeExplanations(limit = 50) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;
    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout(`/api/paper-trading/trade-explanations?limit=${encodeURIComponent(limit)}`, {
        signal: activeController.signal,
      })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: friendlyTradeExplanationError(err, 'Trade explanations är tillfälligt otillgängligt.'),
            data: prev.data || null,
          }));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (activeController) activeController.abort();
    };
  }, [limit]);

  return state;
}

function useTradeExplanationLookup(trade, enabled) {
  const [state, setState] = useState({ loading: false, data: null, error: null });

  useEffect(() => {
    if (!enabled || !trade) {
      setState({ loading: false, data: null, error: null });
      return;
    }

    const params = tradeLookupParams(trade);
    if (!params) {
      setState({ loading: false, data: null, error: null });
      return;
    }

    let alive = true;
    const controller = new AbortController();
    setState({ loading: true, data: null, error: null });

    fetchJsonWithTimeout(`/api/paper-trading/trade-explanations?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!alive) return;
        setState({ loading: false, data, error: null });
      })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyTradeExplanationError(err, 'Trade explanations är tillfälligt otillgängligt.'),
        });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [enabled, trade?.tradeId, trade?.symbol, trade?.strategy_id, trade?.strategyId, trade?.canonicalStrategyId, trade?.resolvedStrategyId, trade?.opened_at, trade?.openedAt, trade?.closed_at, trade?.closedAt]);

  return state;
}

function useExitProfileComparison(limit = 131) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    let activeController = null;
    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout(`/api/paper-trading/exit-profile-comparison?limit=${encodeURIComponent(limit)}`, {
        signal: activeController.signal,
      })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: friendlyTradeExplanationError(err, 'Exit profile comparison är tillfälligt otillgängligt.'),
            data: prev.data || null,
          }));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (activeController) activeController.abort();
    };
  }, [limit]);

  return state;
}

function explanationValue(value, fallback = 'unknown') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  return text || fallback;
}

function tradeLookupKey(trade) {
  if (!trade) return null;
  if (trade.tradeId) return trade.tradeId;
  const symbol = previewValue(trade.symbol, 'unknown');
  const strategyId = previewValue(trade.strategy_id || trade.strategyId || trade.canonicalStrategyId || trade.resolvedStrategyId, 'unknown');
  const openedAt = previewValue(trade.opened_at || trade.openedAt, 'unknown');
  return `${symbol}:${strategyId}:${openedAt}`;
}

function tradeLookupParams(trade) {
  if (!trade) return null;
  const params = new URLSearchParams();
  if (trade.tradeId) params.set('tradeId', trade.tradeId);
  if (trade.symbol) params.set('symbol', trade.symbol);
  const strategyId = trade.strategy_id || trade.strategyId || trade.canonicalStrategyId || trade.resolvedStrategyId;
  if (strategyId) params.set('strategyId', strategyId);
  if (trade.opened_at || trade.openedAt) params.set('openedAt', trade.opened_at || trade.openedAt);
  if (trade.closed_at || trade.closedAt) params.set('closedAt', trade.closed_at || trade.closedAt);
  return params;
}

function explanationBadgeStyle(tone = 'neutral', compact = false, theme = null) {
  const cfg = subtleToneColors(theme)[tone] || subtleToneColors(theme).neutral;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: compact ? '4px 8px' : '6px 10px',
    borderRadius: 999,
    border: `1px solid ${cfg.border}`,
    background: cfg.bg,
    color: cfg.fg,
    fontSize: compact ? 10.5 : 11,
    fontWeight: 900,
    lineHeight: 1.2,
  };
}

function ClosedTradeExplanationPanel({ explanation, trade, theme }) {
  const missingFields = Array.isArray(explanation?.diagnosis?.missingFields) ? explanation.diagnosis.missingFields : [];
  const nearbyEvents = Array.isArray(explanation?.nearbyEvents) ? explanation.nearbyEvents : [];
  const entry = explanation?.entry || {};
  const exit = explanation?.exit || {};
  const diagnosis = explanation?.diagnosis || {};
  const stats = explanation?.tradeStats || diagnosis?.tradeStats || {};
  const tradeLabel = trade?.symbol ? `${trade.symbol} · ${trade.strategy_id || trade.strategyId || 'unknown'}` : 'unknown';
  const mfePct = stats.mfePct == null ? '–' : `${stats.mfePct >= 0 ? '+' : ''}${Number(stats.mfePct).toFixed(2)}%`;
  const maePct = stats.maePct == null ? '–' : `${stats.maePct >= 0 ? '+' : ''}${Number(stats.maePct).toFixed(2)}%`;
  const exitProfile = explanationValue(exit.exitProfile, 'unknown');
  const exitSource = explanationValue(exit.exitSource, 'unknown');
  const durationLabel = explanationValue(exit.durationLabel || trade?.durationLabel || trade?.duration_label, 'unknown');
  const exitEngineVersion = explanationValue(exit.exitEngineVersion, 'unknown');
  const entryQualityDecision = explanationValue(diagnosis.entryQualityGateDecision, 'pass');

  return (
    <div style={{
      marginTop: 10,
      padding: 16,
      borderRadius: 16,
      border: '1px solid var(--border)',
      background: 'var(--surface)',
      boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.06)' : '0 18px 40px rgba(2,6,23,0.20)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>Varför traden öppnades och stängdes</div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>{tradeLabel}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={explanationBadgeStyle(trade?.result === 'WIN' ? 'success' : trade?.result === 'LOSS' ? 'danger' : 'warning', false, theme)}>
            Result: {explanationValue(trade?.result)}
          </span>
          <span style={explanationBadgeStyle('info', false, theme)}>
            Exit type: {explanationValue(exit.exitType)}
          </span>
          <span style={explanationBadgeStyle(exitSource === 'exit_engine_v1' ? 'info' : 'neutral', false, theme)}>
            Exit source: {exitSource}
          </span>
          <span style={explanationBadgeStyle('neutral', false, theme)}>
            Profile: {exitProfile}
          </span>
          <span style={explanationBadgeStyle('neutral', false, theme)}>
            Safety: paper_only
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 14 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Entry</div>
          <div style={{ marginTop: 6, fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>{explanationValue(entry.explanation, 'Saknas i loggning')}</div>
          <div style={{ marginTop: 8, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
            Reason: {explanationValue(entry.reason)}
            <br />
            Status: {explanationValue(entry.status)}
            <br />
            Bias: {explanationValue(entry.bias)}
            <br />
            Confidence: {entry.confidence == null ? 'unknown' : entry.confidence}
            <br />
            Gate stage: {explanationValue(entry.gateStage)}
            <br />
            Setup: {explanationValue(entry.setup)}
            <br />
            Entry quality: {entryQualityDecision}
          </div>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Exit</div>
          <div style={{ marginTop: 6, fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>{explanationValue(exit.explanation, 'Exakt exitReason saknas i loggning')}</div>
          <div style={{ marginTop: 8, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
            Reason: {explanationValue(exit.reason)}
            <br />
            Reason code: {explanationValue(exit.exitReasonCode)}
            <br />
            Exit type: {explanationValue(exit.exitType)}
            <br />
            Source: {explanationValue(exit.exitSource)}
            <br />
            Engine version: {exitEngineVersion}
            <br />
            Duration: {durationLabel}
            <br />
            Original stop/target: {explanationValue(exit.originalStopPct)} / {explanationValue(exit.originalTargetPct)}
            <br />
            Effective stop: {explanationValue(exit.effectiveStopPct)}
            <br />
            Trailing stop: {explanationValue(exit.trailingStopPct)}
            <br />
            Break-even aktiv: {String(exit.breakEvenActivated === true)}
            <br />
            Break-even threshold: {explanationValue(exit.breakEvenThresholdPct)}
          </div>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Diagnosis</div>
          <div style={{ marginTop: 6, fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>{explanationValue(diagnosis.summary)}</div>
          <div style={{ marginTop: 8, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
            Why: {explanationValue(diagnosis.whyWinOrLoss)}
            <br />
            Lesson: {explanationValue(diagnosis.lesson)}
            <br />
            Possible issue: {explanationValue(diagnosis.possibleIssue)}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Signal strength</div>
          <div style={{ marginTop: 6, fontWeight: 900, color: 'var(--text)' }}>{entry.signalStrength == null ? 'saknas i äldre loggning' : entry.signalStrength}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>MFE</div>
          <div style={{ marginTop: 6, fontWeight: 900, color: 'var(--text)' }}>{mfePct === '–' ? 'saknas i äldre loggning' : mfePct}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>MAE</div>
          <div style={{ marginTop: 6, fontWeight: 900, color: 'var(--text)' }}>{maePct === '–' ? 'saknas i äldre loggning' : maePct}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Entry quality notes</div>
          <div style={{ marginTop: 6, fontWeight: 900, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
            {entry.wouldBlockLateEntry ? 'late entry · caution · 2m confirmation saknas' : entry.wouldRequire2mConfirmation ? '2m confirmation saknas' : 'ingen extra entry-blockering'}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Learned</div>
          <div style={{ marginTop: 6, fontWeight: 900, color: 'var(--text)' }}>{explanationValue(diagnosis.lesson, 'saknas i äldre loggning')}</div>
        </div>
      </div>

      <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
        <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Nearby events</div>
        {nearbyEvents.length ? (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {nearbyEvents.slice(0, 8).map((event) => (
              <div key={event.eventId || `${event.type}-${event.timestamp}`} style={{ padding: 10, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, lineHeight: 1.45 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ color: 'var(--text)' }}>{explanationValue(event.type)}</strong>
                  <span style={{ color: 'var(--muted)' }}>{fmtTime(event.timestamp)}</span>
                </div>
                <div style={{ color: 'var(--text)', marginTop: 4 }}>
                  {event.reason ? `${event.reason}` : 'Saknas i loggning'}
                </div>
                <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                  Offset: {event.offsetMinutes == null ? 'unknown' : `${event.offsetMinutes} min`} · Match: {explanationValue(event.match)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>Inga närliggande events hittades eller så saknas tidskoppling i loggen.</div>
        )}
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {missingFields.length ? missingFields.map((field) => (
          <span key={field} style={explanationBadgeStyle('warning', true, theme)}>
            saknas i loggning: {field}
          </span>
        )) : (
          <span style={explanationBadgeStyle('success', true, theme)}>fullständig loggning</span>
        )}
      </div>
    </div>
  );
}

function gateTone(status) {
  const key = String(status || 'unknown').toLowerCase();
  if (key === 'pass') return 'success';
  if (key === 'warn') return 'warning';
  if (key === 'fail') return 'danger';
  return 'neutral';
}

function gateLabel(value) {
  const key = String(value || 'unknown').toLowerCase();
  if (key === 'pass') return 'pass';
  if (key === 'warn') return 'warn';
  if (key === 'fail') return 'fail';
  return 'unknown';
}

function EntryQualityGatePanel({ gate, theme }) {
  if (!gate) return null;
  const checks = gate.checks || {};
  const recommendations = Array.isArray(gate.recommendations) ? gate.recommendations : [];
  const missingFields = Array.isArray(gate.missingFields) ? gate.missingFields : [];
  const statusTone = gateTone(gate.entryQuality);
  const score = Number.isFinite(Number(gate.score)) ? Number(gate.score) : 0;

  const cards = [
    { key: 'lateEntry', label: 'Sen entry', data: checks.lateEntry },
    { key: 'twoMinuteConfirmation', label: '2m-bekräftelse', data: checks.twoMinuteConfirmation },
    { key: 'stopFit', label: 'Stop loss-passform', data: checks.stopFit },
    { key: 'choppyMarket', label: 'Choppy marknad', data: checks.choppyMarket },
  ];

  return (
    <div style={{
      marginTop: 12,
      padding: 16,
      borderRadius: 16,
      border: '1px solid var(--border)',
      background: 'var(--surface)',
      boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.05)' : '0 18px 40px rgba(2,6,23,0.18)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>Entry Quality Gate</div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            Detta är analys, inte automatisk ändring. Rekommendationen bör testas i replay/paper innan den används. Originalstrategin ändras inte.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={explanationBadgeStyle(statusTone, false, theme)}>
            Entry quality: {gateLabel(gate.entryQuality)}
          </span>
          <span style={explanationBadgeStyle('info', false, theme)}>
            Score: {score}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
        {cards.map((card) => {
          const data = card.data || {};
          const status = gateLabel(data.status);
          const evidence = data.evidence || {};
          const reason = data.reason || 'Data saknas för att bedöma detta steg.';
          const missing = Array.isArray(data.missingFields) ? data.missingFields : [];
          return (
            <div key={card.key} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <div style={{ fontWeight: 900, color: 'var(--text)', fontSize: 13 }}>{card.label}</div>
                <span style={explanationBadgeStyle(gateTone(status), true, theme)}>{status}</span>
              </div>
              <div style={{ marginTop: 8, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
                {reason}
              </div>
              <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11, lineHeight: 1.45 }}>
                {data.status === 'unknown' || !reason ? 'Data saknas.' : ''}
                {evidence.entryReason || evidence.exitReason || evidence.maxFavorablePct != null || evidence.maxAdversePct != null || evidence.nearbyBlockedCount != null
                  ? `Evidence: ${[
                    evidence.entryReason ? `entryReason=${evidence.entryReason}` : null,
                    evidence.statusAtEntry ? `statusAtEntry=${evidence.statusAtEntry}` : null,
                    evidence.maxFavorablePct != null ? `MFE=${previewValue(evidence.maxFavorablePct)}` : null,
                    evidence.maxAdversePct != null ? `MAE=${previewValue(evidence.maxAdversePct)}` : null,
                    evidence.exitReason ? `exitReason=${evidence.exitReason}` : null,
                    evidence.nearbyBlockedCount != null ? `nearbyBlocked=${evidence.nearbyBlockedCount}` : null,
                  ].filter(Boolean).join(' · ')}`
                  : 'Data saknas.'}
              </div>
              {missing.length ? (
                <div style={{ marginTop: 8, ...mutedTextStyle(theme), fontSize: 11 }}>
                  Saknade fält: {missing.join(', ')}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
        Rekommendationerna nedan är säkra testspår för replay eller paper-test. De ändrar inte runtime eller originalstrategin.
      </div>

      {missingFields.length ? (
        <div style={{ marginTop: 12, ...mutedTextStyle(theme), fontSize: 12 }}>
          Data saknas: {missingFields.join(', ')}
        </div>
      ) : null}

      {recommendations.length ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {recommendations.map((recommendation) => (
            <div key={`${recommendation.type}-${recommendation.title}`} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 12, background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 900, color: 'var(--text)', fontSize: 13 }}>{recommendation.title}</div>
                <span style={explanationBadgeStyle('neutral', true, theme)}>{recommendation.type}</span>
              </div>
              <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
                {recommendation.description}
              </div>
              <div style={{ marginTop: 6, ...mutedTextStyle(theme), fontSize: 11 }}>
                safeActionOnly={String(recommendation.safeActionOnly === true)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExitProfileComparisonPanel({ comparison, theme }) {
  if (!comparison) return null;
  const baseline = comparison.baseline || {};
  const profiles = Array.isArray(comparison.profiles) ? comparison.profiles : [];
  const note = comparison.comparison_note || 'Read-only replay jämförelse.';

  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Exit profile comparison</h2>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>{note}</div>
        </div>
        <span style={statusPillStyle('info', theme)}>{profiles.length} profiler</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Trades</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.trades, baseline.simulated_trades ?? 0)}</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Median duration</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.median_duration_label, '–')}</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Winrate</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.winrate)}%</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Median PnL</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.median_pnl_pct)}%</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Avg PnL</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.avg_pnl_pct)}%</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Max adverse</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 900, color: 'var(--text)' }}>{previewValue(baseline.max_adverse_excursion_pct)}%</div>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 12 }}>Baseline</div>
        </div>
      </div>

      <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, lineHeight: 1.55 }}>
        Den här rapporten är bara replay/read-only. Baseline visas som utgångsläge och profilerna nedan jämförs mot den.
      </div>

      <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
        {profiles.map((profile) => {
          const better = profile.recommendation === 'Bättre än baseline';
          const worse = profile.recommendation === 'Sämre än baseline';
          const risky = profile.recommendation === 'Lovande men högre risk';
          const tone = profile.degraded ? 'warning' : better ? 'success' : worse ? 'danger' : risky ? 'warning' : 'neutral';
          const counts = [
            `target ${previewValue(profile.target_hit_count, 0)}`,
            `stop ${previewValue(profile.stop_hit_count, 0)}`,
            `trailing ${previewValue(profile.trailing_stop_count, 0)}`,
            `break-even ${previewValue(profile.break_even_count, 0)}`,
            `momentum ${previewValue(profile.momentum_fade_count, 0)}`,
            `timeout ${previewValue(profile.timeout_count, 0)}`,
          ].join(' · ');
          const statusText = profile.degraded ? `degraded${profile.degraded_reason ? `: ${profile.degraded_reason}` : ''}` : profile.data_status || 'ok';
          const deltas = profile.delta_vs_baseline || {};
          const formula = profile.volatility_formula || profile.stop_formula || profile.exit_formula || profile.description || '–';
          return (
            <div key={profile.id} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 900, color: 'var(--text)', fontSize: 15 }}>{profile.label}</div>
                  <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>{profile.description}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={statusPillStyle(tone, theme)}>{profile.recommendation || '–'}</span>
                  <span style={statusPillStyle('neutral', theme)}>{statusText}</span>
                </div>
              </div>

              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                <MetricCard label="Trades" value={previewValue(profile.simulated_trades, 0)} tone="neutral" note={`Skippade: ${previewValue(profile.trades_skipped, 0)}`} />
                <MetricCard label="Median duration" value={previewValue(profile.median_duration_label, '–')} tone="neutral" note={profile.degraded ? 'degraded' : null} />
                <MetricCard label="Winrate" value={`${previewValue(profile.winrate, 2)}%`} tone="neutral" note={`Δ ${previewNumber(deltas.winrate, 2)} pp`} />
                <MetricCard label="Median PnL" value={`${previewValue(profile.median_pnl_pct, 4)}%`} tone="neutral" note={`Δ ${previewNumber(deltas.median_pnl_pct, 4)}%`} />
                <MetricCard label="Avg PnL" value={`${previewValue(profile.avg_pnl_pct, 4)}%`} tone="neutral" note={`Δ ${previewNumber(deltas.avg_pnl_pct, 4)}%`} />
                <MetricCard label="Max adverse" value={`${previewValue(profile.max_adverse_excursion_pct, 4)}%`} tone="neutral" note={`Baseline ${previewValue(baseline.max_adverse_excursion_pct, 4)}%`} />
              </div>

              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span style={statusPillStyle('neutral', theme)}>target_hit {previewValue(profile.target_hit_count, 0)}</span>
                <span style={statusPillStyle('neutral', theme)}>stop_hit {previewValue(profile.stop_hit_count, 0)}</span>
                <span style={statusPillStyle('neutral', theme)}>trailing_stop {previewValue(profile.trailing_stop_count, 0)}</span>
                <span style={statusPillStyle('neutral', theme)}>break_even {previewValue(profile.break_even_count, 0)}</span>
                <span style={statusPillStyle('neutral', theme)}>momentum_fade {previewValue(profile.momentum_fade_count, 0)}</span>
                <span style={statusPillStyle('neutral', theme)}>timeout {previewValue(profile.timeout_count, 0)}</span>
              </div>

              <div style={{ marginTop: 10, color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
                {counts}
                <br />
                Formula: {formula}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function issueTone(issueType, count = 0) {
  const key = String(issueType || 'unknown');
  if (count >= 4) return 'danger';
  if (key === 'missing_logging_fields') return 'info';
  if (key === 'stop_loss_hit') return 'warning';
  if (key === 'unknown') return 'neutral';
  return 'warning';
}

function LossReviewQueuePanel({ review, loading, error, theme, previewState, onPreviewGroup }) {
  if (loading && !review) {
    return (
      <div style={sectionStyle()}>
        <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--text)' }}>Förlustanalys och testförslag</div>
        <div style={{ marginTop: 6, ...mutedTextStyle(theme), fontSize: 13 }}>Läser förlustanalyskö...</div>
      </div>
    );
  }

  if (error && !review) {
    return (
      <div style={sectionStyle()}>
        <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--text)' }}>Förlustanalys och testförslag</div>
        <div style={{ marginTop: 6, color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      </div>
    );
  }

  if (!review) return null;
  const groups = Array.isArray(review.groups) ? review.groups : [];
  const summary = review.summary || {};
  const safety = review.safety || {};

  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--text)' }}>Förlustanalys och testförslag</div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Trade explanations och Entry Quality Gate grupperas här till säkra testspår för replay eller paper-test.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={statusPillStyle('neutral', theme)}>mode={previewValue(safety.mode || 'paper_only')}</span>
          <span style={statusPillStyle('danger', theme)}>{previewValue(summary.totalLosses, 0)} losses</span>
          <span style={statusPillStyle('info', theme)}>{previewValue(summary.topIssue, 'unknown') || 'unknown'}</span>
        </div>
      </div>

      <div style={{ marginTop: 8, ...mutedTextStyle(theme), fontSize: 13, lineHeight: 1.5 }}>
        Detta är analys och testförslag. Originalstrategin ändras inte.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 14 }}>
        {[
          ['Closed', summary.totalClosed ?? 0],
          ['Losses', summary.totalLosses ?? 0],
          ['Reviewed', summary.reviewedLosses ?? 0],
          ['Top issue', summary.topIssue || 'unknown'],
          ['Top strategy', summary.topStrategyIssue || 'unknown'],
        ].map(([label, value]) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
            <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 900, marginTop: 6, color: 'var(--text)' }}>{previewValue(value, 'unknown')}</div>
          </div>
        ))}
      </div>

      {groups.length ? (
        <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
          {groups.map((group) => {
            const preview = previewState?.groupId === group.id ? previewState.data?.preview || previewState.data?.group?.preview || null : null;
            const previewBusy = previewState?.loadingGroupId === group.id;
            const previewError = previewState?.groupId === group.id ? previewState.error : null;
            const tone = issueTone(group.issueType, group.count);
            const lastExample = Array.isArray(group.examples) && group.examples[0] ? group.examples[0] : null;
            return (
              <div key={group.id} style={{
                border: '1px solid var(--border)',
                borderRadius: 16,
                padding: 14,
                background: 'var(--surface)',
                boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.05)' : '0 18px 40px rgba(2,6,23,0.18)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 900, color: 'var(--text)' }}>{group.issueLabel || group.issueType}</div>
                    <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.45 }}>
                      Strategi: {previewValue(group.strategyId)} · Setup: {previewValue(group.setup)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span style={statusPillStyle(tone, theme)}>{previewValue(group.count, 0)} lossar</span>
                    <span style={statusPillStyle('info', theme)}>Snitt PnL {group.avgPnlPct == null ? '–' : `${group.avgPnlPct >= 0 ? '+' : ''}${group.avgPnlPct.toFixed(2)}%`}</span>
                    <button
                      type="button"
                      onClick={() => onPreviewGroup(group.id)}
                      style={{
                        ...statusPillStyle('success', theme),
                        cursor: 'pointer',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {previewBusy ? 'Bygger preview...' : 'Förhandsvisa test'}
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Genomsnittlig confidence</div>
                    <div style={{ marginTop: 4, fontWeight: 900, color: 'var(--text)' }}>{group.avgConfidence == null ? '–' : group.avgConfidence.toFixed(2)}</div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Genomsnittlig förlust</div>
                    <div style={{ marginTop: 4, fontWeight: 900, color: 'var(--text)' }}>{group.avgPnlPct == null ? '–' : `${group.avgPnlPct >= 0 ? '+' : ''}${group.avgPnlPct.toFixed(2)}%`}</div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Symbols</div>
                    <div style={{ marginTop: 4, fontWeight: 800, color: 'var(--text)', fontSize: 12, lineHeight: 1.45 }}>{(group.symbols || []).join(', ') || '–'}</div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
                    <div style={{ ...mutedTextStyle(theme), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Bias / entry</div>
                    <div style={{ marginTop: 4, fontWeight: 800, color: 'var(--text)', fontSize: 12, lineHeight: 1.45 }}>
                      Bias: {Object.entries(group.biasCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || '–'}
                      <br />
                      Status: {Object.entries(group.statusAtEntryCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || '–'}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Diagnosis</strong>
                  {group.diagnosis}
                </div>

                <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Rekommenderat test</strong>
                  {group.recommendation?.description || '–'}
                  {group.recommendation?.proposedVariant?.name ? (
                    <div style={{ marginTop: 6, color: 'var(--muted)' }}>
                      Variant: {group.recommendation.proposedVariant.name}
                    </div>
                  ) : null}
                </div>

                {lastExample ? (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Exempel</strong>
                    {lastExample.symbol} · {fmtTime(lastExample.openedAt)} · PnL {previewValue(lastExample.pnlPct, '–')}
                    <br />
                    {lastExample.explanation}
                  </div>
                ) : null}

                {preview ? (
                  <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface)', color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Testpreview</strong>
                    {preview.reason}
                    <br />
                    Queue: {preview.queue_item?.strategy_id || '–'} · {preview.queue_item?.test_type || '–'} · {preview.queue_item?.source || '–'}
                    <br />
                    Safety: paper_only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false · broker_enabled=false
                  </div>
                ) : previewError ? (
                  <div style={{ marginTop: 12, border: '1px solid rgba(239,68,68,0.24)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', color: 'var(--danger)', fontSize: 12, lineHeight: 1.55 }}>
                    {previewError}
                  </div>
                ) : previewBusy ? (
                  <div style={{ marginTop: 12, ...mutedTextStyle(theme), fontSize: 12 }}>Bygger preview för denna grupp...</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }}>
          Inga loss-grupper hittades ännu.
        </div>
      )}
    </div>
  );
}

function usePaperApprovals(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/approvals')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa approvals.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function mostCommonReason(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = row?.blockedReason || row?.reasonSv || row?.reason;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) { best = reason; bestCount = count; }
  }
  return best ? { reason: best, count: bestCount } : null;
}

function MetricCard({ label, value, tone = 'neutral', note }) {
  const theme = useThemeMode();
  const colors = { good: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', neutral: 'var(--text)' };
  return (
    <div className={`allowlist-metric allowlist-metric-${tone}`} style={{ flex: '1 1 160px', minWidth: 160, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.04)' : 'none' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', ...mutedTextStyle(theme) }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: colors[tone] || colors.neutral, marginTop: 2 }}>{value}</div>
      {note ? <div style={{ fontSize: 11, ...mutedTextStyle(theme), marginTop: 2, lineHeight: 1.4 }}>{note}</div> : null}
    </div>
  );
}

async function postPaperRiskReviewResume(payload) {
  async function parseErrorMessage(res, rawBody) {
    if (!res) return '';
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const json = rawBody ? JSON.parse(rawBody) : null;
        return String(json?.error || json?.message || '').trim();
      } catch (_) {
        return '';
      }
    }
    return String(rawBody || '').trim();
  }

  try {
    const res = await fetch('/api/paper-trading/risk-review/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const rawBody = await res.text().catch(() => '');
    const data = rawBody ? (() => {
      try { return JSON.parse(rawBody); } catch (_) { return null; }
    })() : null;
    if (!res.ok || !data || data.ok === false) {
      const serverMessage = await parseErrorMessage(res, rawBody);
      throw new Error(serverMessage || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    const message = String(err?.message || '').trim();
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      throw new Error('Kunde inte nå backend. Kontrollera att API:t är omstartat och att sidan är uppdaterad.');
    }
    throw new Error(message || 'Kunde inte återuppta paper testing.');
  }
}

function RiskPauseSummaryPanel({ riskPauseSummary, gateStatus, runtime, onRefresh }) {
  const theme = useThemeMode();
  const [resumeAck, setResumeAck] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeMessage, setResumeMessage] = useState(null);

  const summary = riskPauseSummary?.summary || riskPauseSummary || {};
  const riskReview = summary.risk_review || {};
  const gatePipeline = gateStatus?.pipeline || {};
  const last60m = gatePipeline?.last60m || {};
  const latestEvent = summary.latest_risk_pause_event || runtime?.recentEvents?.find?.((row) => String(row?.type || '').toUpperCase() === 'RISK_PAUSE_TRIGGERED') || null;
  const active = summary.pause_trading === true || summary.active === true;
  const reviewActive = riskReview.active === true;
  const canResume = active && !reviewActive;
  const reasonText = summary.pause_reason || (Array.isArray(summary.pause_reasons) ? summary.pause_reasons.join(', ') : null) || '–';
  const latestEventText = latestEvent?.timestamp
    ? `${fmtTime(latestEvent.timestamp)} · ${latestEvent.symbol || '–'} · ${latestEvent.strategy_id || latestEvent.strategy_name || '–'}`
    : '–';
  const consecutiveText = `${summary.consecutive_losses ?? '–'} / ${summary.max_consecutive_losses ?? '–'}`;
  const latestAuditEvent = riskReview.latestAuditEvent || null;
  const latestAuditEventText = latestAuditEvent?.timestamp
    ? `${fmtTime(latestAuditEvent.timestamp)} · ${latestAuditEvent.type || '–'}`
    : '–';

  async function handleResume() {
    if (!resumeAck || resumeBusy) return;
    setResumeBusy(true);
    setResumeMessage(null);
    try {
      const result = await postPaperRiskReviewResume({
        confirmPaperOnly: true,
        reason: 'Manual risk review accepted. Resume paper testing.',
      });
      setResumeMessage({ type: 'ok', text: result.message || 'Paper testing återupptagen efter manuell risk review.' });
      setResumeAck(false);
      onRefresh?.();
    } catch (err) {
      setResumeMessage({ type: 'error', text: err?.message || 'Kunde inte återuppta paper testing.' });
    } finally {
      setResumeBusy(false);
    }
  }

  return (
    <div style={{ ...sectionStyle(), marginTop: 12, marginBottom: 12, background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>Risk pause</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Read-only diagnos för varför nya paper trades inte öppnas när riskmotorn pausar entry-loopen.
          </div>
        </div>
        <span style={statusPillStyle(active && !reviewActive ? 'danger' : 'success', theme)}>
          {active && !reviewActive ? 'Pausad' : reviewActive ? 'Återupptagen' : 'Inte aktiv'}
        </span>
      </div>

      {active && !reviewActive ? (
        <div style={{ marginTop: 12, padding: 16, borderRadius: 16, border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)', color: 'var(--text)', lineHeight: 1.6 }}>
          <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 4 }}>Paper trading är pausad</div>
          <div style={{ fontSize: 13 }}>Riskmotorn har pausat nya paper trades efter förlustsvit.</div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Orsak: <strong>{reasonText}</strong>
            <br />
            Förlustsvit: <strong>{consecutiveText}</strong>
            <br />
            Senaste risk-pause-event: <strong>{latestEventText}</strong>
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Scanner och gates kan fortfarande hitta kandidater, men nya paper trades öppnas inte.
          </div>
        </div>
      ) : null}

      {active && reviewActive ? (
        <div style={{ marginTop: 12, padding: 16, borderRadius: 16, border: '1px solid rgba(34,197,94,0.28)', background: 'rgba(34,197,94,0.10)', color: 'var(--text)', lineHeight: 1.6 }}>
          <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 4 }}>Paper testing återupptagen efter manuell risk review</div>
          <div style={{ fontSize: 13 }}>
            Den underliggande risk-pausen finns kvar, men en paper-only override är aktiv under en tidsbegränsad review-period.
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Orsak: <strong>{reasonText}</strong>
            <br />
            Förlustsvit: <strong>{consecutiveText}</strong>
            <br />
            Override giltig till: <strong>{fmtTime(riskReview.expiresAt)}</strong>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        <MetricCard
          label="Consecutive losses"
          value={consecutiveText}
          tone={active ? 'warn' : 'neutral'}
          note={`pause_after_consecutive_losses=${String(summary.pause_after_consecutive_losses !== false)}`}
        />
        <MetricCard
          label="Pause reason"
          value={reasonText}
          tone={active ? 'warn' : 'neutral'}
          note="consecutive_losses_limit"
        />
        <MetricCard
          label="Senaste risk pause"
          value={latestEvent?.timestamp ? fmtTime(latestEvent.timestamp) : '–'}
          tone="neutral"
          note={latestEventText}
        />
        <MetricCard
          label="Manuell review"
          value={reviewActive ? 'Aktiv' : '–'}
          tone={reviewActive ? 'good' : 'neutral'}
          note={reviewActive ? `expires ${fmtTime(riskReview.expiresAt)}` : 'Ingen override aktiv'}
        />
        <MetricCard
          label="Senaste audit-event"
          value={latestAuditEvent?.type || '–'}
          tone={reviewActive ? 'good' : 'neutral'}
          note={latestAuditEventText}
        />
        <MetricCard
          label="GATE_ALLOWED 60m"
          value={last60m.gateAllowedLast60m ?? '–'}
          tone="neutral"
        />
        <MetricCard
          label="TRADE_OPENED 60m"
          value={last60m.tradesOpenedLast60m ?? 0}
          tone="neutral"
        />
      </div>

      <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
        <strong>Förklaring:</strong> Scanner och market gate hittar kandidater, men risk-pausen stoppar nya paper entries tills förlustsviten bryts eller risk review görs.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <span style={statusPillStyle('neutral', theme)}>Read-only</span>
        <span style={statusPillStyle('neutral', theme)}>Ingen reset här</span>
        <span style={statusPillStyle('neutral', theme)}>Ingen live trading</span>
        <span style={statusPillStyle('neutral', theme)}>Inga riktiga order</span>
        {active && !reviewActive ? <span style={statusPillStyle('warning', theme)}>Manuell review krävs</span> : null}
      </div>

      {resumeMessage ? (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface)', color: resumeMessage.type === 'ok' ? 'var(--success)' : 'var(--danger)', fontSize: 13, lineHeight: 1.5 }}>
          {resumeMessage.text}
        </div>
      ) : null}

      {canResume ? (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ fontWeight: 900, color: 'var(--text)' }}>Återuppta paper testing</div>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
            För att fortsätta krävs manuell risk review. Det påverkar bara paper trading och lägger ingen riktig order.
          </div>
          <label style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={resumeAck}
              onChange={(e) => setResumeAck(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>Jag bekräftar att detta endast gäller paper trading och inte live trading.</span>
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={!resumeAck || resumeBusy}
              onClick={handleResume}
              style={{
                appearance: 'none',
                cursor: (!resumeAck || resumeBusy) ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: (!resumeAck || resumeBusy) ? 'var(--surface-2)' : 'var(--surface)',
                color: 'var(--text)',
                padding: '10px 14px',
                fontSize: 13,
                fontWeight: 900,
                opacity: (!resumeAck || resumeBusy) ? 0.65 : 1,
              }}
            >
              {resumeBusy ? 'Återupptar...' : 'Återuppta paper testing efter risk review'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WhyNoTradesPanel({ runtime, allowlist, riskPauseSummary, gateStatus, onRefresh }) {
  const theme = useThemeMode();
  const summary = runtime?.summary || {};
  const open = Number(summary.openCount) || 0;
  const closed = Number(summary.closedCount) || 0;
  const blocked = Number(summary.blockedCount) || 0;
  const blockedCandidates = Array.isArray(runtime?.blockedCandidates) ? runtime.blockedCandidates : [];
  const approved = allowlist?.totalApproved;
  const ready = allowlist?.readyForPaperRuntime;
  const runtimeActive = runtime?.safety?.mode === 'paper_only' || runtime?.status === 'ok';
  const topReason = mostCommonReason(blockedCandidates);
  const reasonIsAllowlist = !!(topReason && /allowlist/i.test(topReason.reason));

  let conclusion;
  if (open > 0) {
    conclusion = `Det finns ${open} öppna paper trades just nu.`;
  } else if (closed > 0) {
    conclusion = `Inga öppna paper trades just nu, men ${closed} stängda finns i historiken.`;
  } else if (blocked > 0 && reasonIsAllowlist) {
    conclusion = 'Systemet ser signaler, men de stoppas innan en paper trade skapas eftersom de kommer från strategier som inte är godkända i allowlist. Endast de godkända strategierna får skapa låtsasaffärer.';
  } else if (blocked > 0) {
    conclusion = 'Systemet ser signaler, men de stoppas innan en paper trade skapas av testregler, status (Vänta / Jaga inte) eller saknad mappning. De allowlist-godkända strategierna har inte gett en signal som passerat reglerna.';
  } else {
    conclusion = 'Inga paper-events ännu i det här fönstret. Systemet är i testläge och väntar på signaler.';
  }

  return (
    <div style={sectionStyle()}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Varför finns inga paper trades?</div>
      <div style={{ fontSize: 12, ...mutedTextStyle(theme), marginBottom: 12 }}>Read-only diagnos. Inga riktiga order, inga actions härifrån.</div>
      <RiskPauseSummaryPanel riskPauseSummary={riskPauseSummary} gateStatus={gateStatus} runtime={runtime} onRefresh={onRefresh} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <MetricCard label="Runtime" value={runtimeActive ? 'Aktiv' : 'Avvaktar'} tone={runtimeActive ? 'good' : 'warn'} note="paper_only, read-only" />
        <MetricCard label="Öppna trades" value={open} tone="neutral" />
        <MetricCard label="Stängda trades" value={closed} tone="neutral" />
        <MetricCard label="Blockerade events" value={blocked} tone={blocked > 0 ? 'warn' : 'neutral'} />
        <MetricCard label="Godkända strategier" value={approved == null ? '–' : approved} tone="neutral" note={ready == null ? null : `${ready} redo för runtime`} />
        <MetricCard label="Senaste event" value={fmtTime(summary.latestEventAt)} tone="neutral" />
        <MetricCard label="Vanligaste orsak" value={topReason ? `${topReason.count}×` : '–'} tone={blocked > 0 ? 'warn' : 'neutral'} note={topReason ? topReason.reason : 'Ingen blockering i fönstret'} />
      </div>
      <div style={{ ...sectionStyle(), marginTop: 12, marginBottom: 0, background: 'var(--surface-2)' }}>
        <strong>Slutsats:</strong> {conclusion}
      </div>
    </div>
  );
}

function countReasons(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = String(
      row?.blockedReason
      || row?.reasonSv
      || row?.reason
      || row?.exitReasonCode
      || row?.result
      || row?.status
      || '',
    ).trim();
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function bestStrategyFromPerformance(performance) {
  const rows = Array.isArray(performance?.strategies) ? performance.strategies : [];
  const ranked = rows.filter((row) => Number.isFinite(Number(row?.netPnlPct)) || Number.isFinite(Number(row?.winRatePct)));
  if (!ranked.length) return { best: null, worst: null };
  const best = ranked.slice().sort((a, b) => {
    const an = Number(a?.netPnlPct);
    const bn = Number(b?.netPnlPct);
    if (Number.isFinite(bn) && Number.isFinite(an) && bn !== an) return bn - an;
    const aw = Number(a?.winRatePct);
    const bw = Number(b?.winRatePct);
    if (Number.isFinite(bw) && Number.isFinite(aw) && bw !== aw) return bw - aw;
    return Number(b?.closedTrades || 0) - Number(a?.closedTrades || 0);
  })[0] || null;
  const worst = ranked.slice().sort((a, b) => {
    const an = Number(a?.netPnlPct);
    const bn = Number(b?.netPnlPct);
    if (Number.isFinite(bn) && Number.isFinite(an) && bn !== an) return an - bn;
    const aw = Number(a?.winRatePct);
    const bw = Number(b?.winRatePct);
    if (Number.isFinite(bw) && Number.isFinite(aw) && bw !== aw) return aw - bw;
    return Number(a?.closedTrades || 0) - Number(b?.closedTrades || 0);
  })[0] || null;
  return { best, worst };
}

function PaperControlRoomPanel({ runtime, safetyStatus, gateStatus, approvalPreview, allowlist }) {
  const theme = useThemeMode();
  const summary = runtime?.summary || {};
  const strategyPerformance = runtime?.strategyPerformance || {};
  const perfSummary = strategyPerformance?.summary || {};
  const dailySelectionPreview = runtime?.dailySelectionPreview || {};
  const closedTrades = Array.isArray(runtime?.closedTrades) ? runtime.closedTrades : [];
  const recentEvents = Array.isArray(runtime?.recentEvents) ? runtime.recentEvents : [];
  const blockedCandidates = Array.isArray(runtime?.blockedCandidates) ? runtime.blockedCandidates : [];
  const { best, worst } = bestStrategyFromPerformance(strategyPerformance);
  const latestTrade = closedTrades[0] || null;
  const latestEvent = recentEvents[0] || null;
  const approvedStrategyIds = Array.isArray(allowlist?.approvedStrategyIds) && allowlist.approvedStrategyIds.length
    ? allowlist.approvedStrategyIds
    : Array.isArray(approvalPreview?.approvedStrategyIds)
      ? approvalPreview.approvedStrategyIds
      : [];
  const previewCandidates = Array.isArray(dailySelectionPreview?.candidates) ? dailySelectionPreview.candidates : [];
  const gatePipeline = gateStatus?.pipeline || {};
  const nearMissLearning = gateStatus?.nearMissLearning || {};
  const safety = safetyStatus?.status && typeof safetyStatus.status === 'object'
    ? safetyStatus.status
    : (runtime?.safety || {});
  const blockers = useMemo(() => {
    const blockedEvents = recentEvents.filter((row) => {
      const type = String(row?.type || '').toUpperCase();
      const status = String(row?.status || '').toLowerCase();
      return Boolean(
        row?.blockedReason
        || ['blocked', 'skipped', 'caution'].includes(status)
        || ['GATE_BLOCKED', 'TRADE_SKIPPED', 'MARKET_CLOSED', 'RISK_BLOCKED', 'RISK_PAUSE_TRIGGERED', 'SAFETY_BLOCKED', 'GATE_OBSERVE_ONLY'].includes(type),
      );
    });
    const counts = countReasons([...blockedCandidates, ...blockedEvents]);
    const categories = [
      { key: 'market_session', label: 'market/session', match: /marknaden är stängd|market closed/i },
      { key: 'mapping', label: 'strategy mapping', match: /inte kopplad till katalogstrategi|runtime-mapping kunde inte läsas|strategyId/i },
      { key: 'crypto_volume', label: 'crypto volume gate', match: /Svag volym i crypto|normal volym i crypto/i },
      { key: 'observe_only', label: 'observe-only', match: /EMA i crypto är pausad|observe only/i },
      { key: 'risk_pause', label: 'risk pause', match: /consecutive_losses_limit|Systempaus/i },
      { key: 'wait_status', label: 'wait-status', match: /status var Vänta|status var Jaga inte/i },
    ];
    const categorized = categories
      .map((category) => ({
        ...category,
        count: counts.filter((row) => category.match.test(row.reason)).reduce((sum, row) => sum + row.count, 0),
      }))
      .filter((row) => row.count > 0);
    return {
      exactTop: counts.slice(0, 8),
      categories: categorized,
    };
  }, [blockedCandidates, recentEvents]);
  const latestTradeLabel = latestTrade
    ? `${latestTrade.symbol || '–'} · ${latestTrade.strategy_id || 'unknown'} · ${latestTrade.result || '–'}`
    : '–';
  const latestEventLabel = latestEvent
    ? `${latestEvent.type || '–'} · ${latestEvent.symbol || '–'} · ${latestEvent.reasonSv || latestEvent.blockedReason || latestEvent.result || '–'}`
    : '–';
  const closedCount = Number(summary.closedCount || 0);
  const staleHours = summary.latestEventAt ? (Date.now() - new Date(summary.latestEventAt).getTime()) / 36e5 : null;
  const sampleNote = closedCount < 30
    ? `Learning-data är fortfarande liten (${closedCount} closed trades).`
    : 'Learning-data är tillräcklig för att ge stabil riktning.';
  const freshnessNote = Number.isFinite(staleHours)
    ? (staleHours > 6
      ? 'Runtime-data är äldre än 6 timmar.'
      : 'Runtime-data är färsk.')
    : 'Runtime-datafärskhet kan inte bedömas ännu.';
  const recommendation = blockers.categories.length
    ? `Systemet är säkert. Nya paper trades stoppas främst av ${blockers.categories.slice(0, 4).map((row) => row.label).join(', ')}. Nästa tekniska steg är att jämföra runtime, gate-status och approval-preview i Paper Trading. Ingen live trading-risk finns eftersom live trading är avstängt.`
    : 'Systemet är säkert och paper-only. När marknad och gate öppnar ska nya paper-trades kunna passera om kandidat, mapping och risk tillåter det.';

  return (
    <div style={{
      ...sectionStyle(),
      borderColor: 'rgba(56, 189, 248, 0.22)',
      background: 'linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24 }}>Paper Control Room</h2>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>
            Samlad read-only översikt för safety, runtime, gates, approval-preview, learning och nästa rekommenderade steg.
          </div>
        </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <span style={statusPillStyle('success', theme)}>Paper only</span>
        <span style={statusPillStyle('neutral', theme)}>Live off</span>
        <span style={statusPillStyle('neutral', theme)}>Broker off</span>
        <span style={statusPillStyle('neutral', theme)}>Real orders blocked</span>
        <span style={statusPillStyle(nearMissLearning.enabled ? 'info' : 'neutral', theme)}>
          Near-miss {nearMissLearning.enabled ? 'aktiv' : 'av'}
        </span>
      </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 14 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Safety</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>Paper only</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            actions_allowed={String(safety?.actions_allowed === true)}<br />
            can_place_orders={String(safety?.can_place_orders === true)}<br />
            live_trading_enabled={String(safety?.live_trading_enabled === true)}<br />
            broker_enabled={String(safety?.broker_enabled === true)}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Runtime</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{summary.openCount ?? 0} open · {summary.closedCount ?? 0} closed</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            blocked={summary.blockedCount ?? 0}<br />
            latestEventAt={fmtTime(summary.latestEventAt)}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Top candidates</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{previewCandidates.length} preview</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            selected={dailySelectionPreview?.selectedCount ?? '–'} / {dailySelectionPreview?.selectionCount ?? 3}<br />
            scanned={dailySelectionPreview?.totalScanned ?? '–'}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Latest trade</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{latestTradeLabel}</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            opened={fmtTime(latestTrade?.opened_at)}<br />
            closed={fmtTime(latestTrade?.closed_at)}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Latest event</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{latestEvent?.type || '–'}</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            {latestEventLabel}
            <br />
            {fmtTime(latestEvent?.timestamp)}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Approved strategies</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{approvedStrategyIds.length} godkända</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            preview accepted={approvalPreview?.accepted ?? '–'} · blocked={approvalPreview?.blocked ?? '–'}
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {approvedStrategyIds.slice(0, 8).map((id) => (
              <span key={id} style={statusPillStyle('info', theme, true)}>{id}</span>
            ))}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Runtime summary</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{runtime?.status || '–'}</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            allowlist={allowlist?.totalApproved ?? approvedStrategyIds.length}<br />
            blockers={blockedCandidates.length}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface)' }}>
          <div style={{ ...mutedTextStyle(theme), fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Learning</div>
          <div style={{ marginTop: 8, fontWeight: 900, color: 'var(--text)' }}>{previewValue(perfSummary.winRatePct, '–')}% win rate</div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>
            net pnl={previewNumber(perfSummary.netPnlPct, 2)}<br />
            avg pnl={previewNumber(perfSummary.avgTradePct ?? perfSummary.avgPnlPct, 2)}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 14 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontWeight: 900, color: 'var(--text)' }}>Varför öppnas inga nya trades?</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {blockers.categories.length ? blockers.categories.slice(0, 6).map((row) => (
              <div key={row.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: 'var(--text)' }}>
                <span>{row.label}</span>
                <strong>{row.count}</strong>
              </div>
            )) : (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Inga blockerande orsaker hittades i senaste fönstret.</div>
            )}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontWeight: 900, color: 'var(--text)' }}>Exakta toppblockers</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {blockers.exactTop.length ? blockers.exactTop.slice(0, 10).map((row) => (
              <div key={row.reason} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>
                <strong>{row.count}x</strong> {row.reason}
              </div>
            )) : (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Inga blockeringsskäl i senaste fönstret.</div>
            )}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontWeight: 900, color: 'var(--text)' }}>Pipeline / gate</div>
          <div style={{ marginTop: 8, display: 'grid', gap: 8, fontSize: 12, color: 'var(--text)' }}>
            <div>scannerCandidatesToday: <strong>{gatePipeline.scannerCandidatesToday ?? '–'}</strong></div>
            <div>qualifiesPassedToday: <strong>{gatePipeline.qualifiesPassedToday ?? '–'}</strong></div>
            <div>marketGateAllowedToday: <strong>{gatePipeline.marketGateAllowedToday ?? '–'}</strong></div>
            <div>marketGateNearMissLearningToday: <strong>{gatePipeline.marketGateNearMissLearningToday ?? '–'}</strong></div>
            <div>tradesOpenedToday: <strong>{gatePipeline.tradesOpenedToday ?? '–'}</strong></div>
            <div>last60m candidates: <strong>{gatePipeline?.last60m?.candidatesLast60m ?? '–'}</strong></div>
            <div>last60m trades opened: <strong>{gatePipeline?.last60m?.tradesOpenedLast60m ?? '–'}</strong></div>
            <div>nearMissLearning entries: <strong>{nearMissLearning.entries ?? '–'}</strong></div>
            <div>nearMissLearning margin: <strong>{nearMissLearning.margin ?? '–'}</strong></div>
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--surface-2)' }}>
          <div style={{ fontWeight: 900, color: 'var(--text)' }}>Learning / strategy summary</div>
          <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, color: 'var(--text)' }}>
            {best ? (
              <>
                Bäst: <strong>{best.strategy_name || best.strategy_id || '–'}</strong> ({previewValue(best.winRatePct)}% win rate, {previewNumber(best.netPnlPct, 2)} net pnl)
                <br />
              </>
            ) : null}
            {worst ? (
              <>
                Svagast: <strong>{worst.strategy_name || worst.strategy_id || '–'}</strong> ({previewValue(worst.winRatePct)}% win rate, {previewNumber(worst.netPnlPct, 2)} net pnl)
                <br />
              </>
            ) : null}
            {sampleNote}
            <br />
            {freshnessNote}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>
        <strong>Rekommenderat nästa steg:</strong> {recommendation}
      </div>
    </div>
  );
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function allowlistTone(status) {
  const key = String(status || 'pending').toLowerCase();
  if (key === 'approved') return 'approved';
  if (key === 'max_nått' || key === 'blocked') return 'blocked';
  if (key === 'pending') return 'warning';
  return 'neutral';
}

async function postPaperMarketConfig(patch) {
  try {
    const res = await fetch('/api/paper-trading/market-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(friendlyAllowlistError(err, 'Kunde inte spara paper market-config.'));
  }
}

function PaperMarketsPanel({ refreshKey, onRefresh }) {
  const theme = useThemeMode();
  const [stateKey, setStateKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const configState = usePaperMarketConfig(refreshKey + stateKey);
  const config = configState.data || {};
  const cryptoEnabled = config.cryptoPaperEnabled !== false;
  const equityEnabled = config.equityPaperEnabled !== false;
  const nearMissEnabled = config.nearMissLearningEnabled !== false;
  const nearMissMargin = Number.isFinite(Number(config.nearMissLearningMargin))
    ? Number(config.nearMissLearningMargin)
    : 5;

  function ask(market, nextValue, label) {
    setMessage(null);
    setConfirm({ market, nextValue, label });
  }

  async function runAction() {
    if (!confirm) return;
    setBusy(true);
    const patch = confirm.market === 'crypto'
      ? { cryptoPaperEnabled: confirm.nextValue }
      : { equityPaperEnabled: confirm.nextValue };
    setConfirm(null);
    setMessage(null);
    try {
      const result = await postPaperMarketConfig(patch);
      setMessage({
        type: 'ok',
        text: result.changed === false
          ? 'Inställningen var redan satt till samma värde.'
          : 'Paper market-inställning uppdaterad. Endast nya paper trades påverkas.',
      });
      setStateKey((value) => value + 1);
      onRefresh?.();
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'Kunde inte uppdatera paper market.' });
    } finally {
      setBusy(false);
    }
  }

  const toggleButton = (active, tone) => ({
    appearance: 'none',
    cursor: active ? 'default' : 'pointer',
    border: `1px solid ${active ? 'var(--border)' : 'var(--border)'}`,
    borderRadius: 999,
    background: active ? 'var(--surface)' : 'var(--surface-2)',
    color: tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)',
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 800,
    minWidth: 56,
    opacity: active ? 1 : 0.92,
  });

  const rowStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    padding: '12px 0',
    borderTop: '1px solid var(--border)',
  };

  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Paper markets</h2>
          <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 13, lineHeight: 1.5 }}>
            Styr bara vilka signaler som får skapa nya paper trades. Inga riktiga order kan läggas.
          </div>
        </div>
        <span style={statusPillStyle('info', theme)}>Endast nya paper trades</span>
      </div>

      <div style={rowStyle}>
        <div>
          <div style={{ fontWeight: 800, color: 'var(--text)' }}>Krypto paper</div>
          <div style={{ ...mutedTextStyle(theme), fontSize: 12, marginTop: 3 }}>
            {cryptoEnabled
              ? 'Crypto-signaler kan skapa nya paper trades.'
              : 'Crypto-signaler blockeras från nya paper trades.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={statusPillStyle(cryptoEnabled ? 'success' : 'danger', theme, true)}>
            {cryptoEnabled ? 'På' : 'Av'}
          </span>
          <button type="button" disabled={busy || cryptoEnabled} style={toggleButton(cryptoEnabled, 'success')} onClick={() => ask('crypto', true, 'Krypto paper')}>
            På
          </button>
          <button type="button" disabled={busy || !cryptoEnabled} style={toggleButton(!cryptoEnabled, 'danger')} onClick={() => ask('crypto', false, 'Krypto paper')}>
            Av
          </button>
        </div>
      </div>

      <div style={rowStyle}>
        <div>
          <div style={{ fontWeight: 800, color: 'var(--text)' }}>Aktier/QQQ paper</div>
          <div style={{ ...mutedTextStyle(theme), fontSize: 12, marginTop: 3 }}>
            {equityEnabled
              ? 'Aktie/ETF/QQQ-signaler kan skapa nya paper trades.'
              : 'Aktie/QQQ-signaler blockeras från nya paper trades.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={statusPillStyle(equityEnabled ? 'success' : 'danger', theme, true)}>
            {equityEnabled ? 'På' : 'Av'}
          </span>
          <button type="button" disabled={busy || equityEnabled} style={toggleButton(equityEnabled, 'success')} onClick={() => ask('equity', true, 'Aktier/QQQ paper')}>
            På
          </button>
          <button type="button" disabled={busy || !equityEnabled} style={toggleButton(!equityEnabled, 'danger')} onClick={() => ask('equity', false, 'Aktier/QQQ paper')}>
            Av
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
        <strong>Near-miss learning</strong>
        <div style={{ marginTop: 4 }}>
          {nearMissEnabled
            ? `Aktiv för paper-only learning, margin ${nearMissMargin} poäng från gate-tröskeln.`
            : 'Avstängt.'}
        </div>
        <div style={{ marginTop: 4, color: 'var(--muted)' }}>
          Detta kan bara skapa låtsastrades i paper-only-läget. Inga riktiga order, broker eller live trading påverkas.
        </div>
      </div>

      <div style={{ marginTop: 12, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
        Crypto = symbol som slutar på <code>USDT</code>. Övriga symboler, inklusive <code>QQQ</code>, hanteras som aktier/ETF för paper runtime-universet.
      </div>

      {configState.error ? (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', color: 'var(--danger)', fontSize: 13 }}>
          {configState.error}
        </div>
      ) : null}

      {message ? (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', color: message.type === 'ok' ? 'var(--success)' : 'var(--danger)', fontSize: 13 }}>
          {message.text}
        </div>
      ) : null}

      {confirm ? (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', color: 'var(--text)' }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Bekräfta ändring</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            Detta påverkar bara nya paper trades. Befintliga trades och historik påverkas inte.
            <br />
            {confirm.label}: {confirm.nextValue ? 'slå på' : 'slå av'}?
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" disabled={busy} style={toggleButton(true, confirm.nextValue ? 'success' : 'danger')} onClick={runAction}>
              Bekräfta
            </button>
            <button type="button" disabled={busy} style={toggleButton(true, 'neutral')} onClick={() => setConfirm(null)}>
              Avbryt
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function postApproval(action, strategyId) {
  try {
    const res = await fetch(`/api/automation/approvals/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ strategyId, reason: 'manual_ui_admin' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(friendlyAllowlistError(err, 'Kunde inte uppdatera approvals.'));
  }
}

async function postPaperAllowlistConfig(maxApproved) {
  try {
    const res = await fetch('/api/automation/paper-allowlist/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ maxApproved, reason: 'manual_ui_config' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(friendlyAllowlistError(err, 'Kunde inte spara allowlist-config.'));
  }
}

function PaperAllowlistManager({ runtime, allowlist, refreshKey, onRefresh }) {
  const theme = useThemeMode();
  const [approvals, setApprovals] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState(null);   // { type: 'ok' | 'error', text }
  const [confirm, setConfirm] = useState(null);    // { kind, action, id, name, maxApproved }
  const [draftMaxApproved, setDraftMaxApproved] = useState('4');

  const approvalsState = usePaperApprovals(refreshKey);
  const configState = usePaperAllowlistConfig(refreshKey);

  useEffect(() => {
    setApprovals(approvalsState.data);
    setConfig(configState.data);
    setLoading(Boolean(approvalsState.loading || configState.loading));
  }, [approvalsState.data, approvalsState.loading, configState.data, configState.loading]);

  useEffect(() => {
    if (configState.data && configState.data.maxApproved != null) {
      setDraftMaxApproved(String(configState.data.maxApproved));
    }
  }, [configState.data]);

  const safe = approvals?.safety || config?.safety || {};
  const paperOnly = (safe.mode || 'paper_only') === 'paper_only'
    && safe.actions_allowed !== true && safe.can_place_orders !== true && safe.live_trading_enabled !== true;

  const approvedIds = Array.isArray(approvals?.approvedStrategyIds) ? approvals.approvedStrategyIds : [];
  const maxApproved = num(config?.maxApproved ?? approvals?.maxApproved);
  const hardMaxApproved = num(config?.hardMaxApproved ?? approvals?.hardMaxApproved) || 10;
  const minApproved = num(config?.minApproved ?? approvals?.minApproved) || 1;
  const approvedCount = approvedIds.length;
  const slotFree = maxApproved > 0 && approvedCount < maxApproved;

  const strategies = Array.isArray(runtime?.strategies) ? runtime.strategies : [];
  const stratById = new Map(strategies.map((s) => [s.strategy_id, s]));
  const allowRows = Array.isArray(allowlist?.allowlist) ? allowlist.allowlist : [];
  const allowMap = new Map(allowRows.map((r) => [r.id, r]));

  const approvedRows = approvedIds.map((id) => {
    const s = stratById.get(id) || {};
    const a = allowMap.get(id) || {};
    return {
      id,
      name: a.name || s.strategy_name || id,
      runtimeReady: a.paperRuntimeReady === true,
      events: num(s.openCount) + num(s.closedCount) + num(s.blockedCount),
      latestAt: s.latestEventAt || '',
      allowlistStatus: 'approved',
    };
  });

  const nonApproved = strategies
    .filter((s) => !approvedIds.includes(s.strategy_id))
    .map((s) => ({
      id: s.strategy_id,
      name: s.strategy_name || s.strategy_id,
      blockedCount: num(s.blockedCount),
      latestAt: s.latestEventAt || '',
      reason: s.latestBlockedReason || '',
      allowlistStatus: /max/i.test(s.latestBlockedReason || '') ? 'max_nått' : /allowlist|reject|block/i.test(s.latestBlockedReason || '') ? 'blocked' : 'pending',
    }))
    .sort((a, b) => b.blockedCount - a.blockedCount);

  function ask(action, id, name) { setMessage(null); setConfirm({ kind: 'strategy', action, id, name }); }

  function askConfigSave() {
    setMessage(null);
    setConfirm({ kind: 'config', maxApproved: num(draftMaxApproved) });
  }

  async function runAction() {
    if (!confirm) return;
    if (confirm.kind === 'config') {
      setBusyId('config');
      setConfirm(null);
      setMessage(null);
      try {
        const result = await postPaperAllowlistConfig(confirm.maxApproved);
        setMessage({
          type: 'ok',
          text: result.changed === false
            ? 'Max antal godkända var redan satt till samma värde.'
            : `Max antal godkända uppdaterat till ${result.maxApproved}. Inga trades skapades.`,
        });
        onRefresh();
      } catch (err) {
        setMessage({ type: 'error', text: err?.message || 'Kunde inte spara maxgränsen.' });
      } finally {
        setBusyId('');
      }
      return;
    }

    const { action, id } = confirm;
    setBusyId(id);
    setConfirm(null);
    setMessage(null);
    try {
      await postApproval(action, id);
      setMessage({
        type: 'ok',
        text: action === 'approve'
          ? 'Strategin är nu godkänd för paper trading. Inga riktiga order kan läggas.'
          : 'Strategin är borttagen från paper allowlist. Inga riktiga order påverkas.',
      });
      onRefresh();
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'Åtgärden misslyckades.' });
    } finally {
      setBusyId('');
    }
  }

  const btnStyle = (disabled, tone) => ({
    appearance: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.72 : 1,
    border: '1px solid var(--border)',
    background: tone === 'danger'
      ? 'var(--surface-2)'
      : tone === 'ok'
        ? 'var(--surface-2)'
        : 'var(--surface-2)',
    color: tone === 'danger'
      ? 'var(--danger)'
      : tone === 'ok'
        ? 'var(--success)'
        : 'var(--text)',
    fontWeight: 700,
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 8,
  });

  return (
    <div className="allowlist-panel" style={sectionStyle()}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Paper Allowlist Manager</div>
      <div style={{ fontSize: 12, ...mutedTextStyle(theme), lineHeight: 1.5, marginBottom: 10 }}>
        Paper allowlist styrs manuellt av dig. Systemet får inte automatiskt lägga till eller ta bort strategier — det får bara visa rekommendationer. Detta gäller endast låtsashandel/paper trading; inga riktiga order kan läggas.
      </div>

      <div className="allowlist-metrics" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <MetricCard label="Godkända" value={`${approvedCount} / ${maxApproved || '–'}`} tone={slotFree ? 'good' : 'warn'} note={slotFree ? 'Plats finns' : 'Max nått'} />
        <MetricCard label="Max antal godkända" value={maxApproved || '–'} tone="neutral" note={`Manuell config, min ${minApproved}, max ${hardMaxApproved}`} />
        <MetricCard label="Säkerhetsläge" value={paperOnly ? 'paper_only' : 'OKÄND'} tone={paperOnly ? 'good' : 'bad'} note="actions_allowed=false" />
      </div>

      <div style={{ ...sectionStyle(), marginTop: 12, marginBottom: 12, background: 'var(--surface-2)' }}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Styr maxgränsen manuellt</div>
        <div style={{ fontSize: 12, ...mutedTextStyle(theme), marginBottom: 10 }}>
          Paper allowlist styrs manuellt av dig. Systemet får inte automatiskt lägga till eller ta bort strategier. Detta ändrar bara hur många strategier som får vara godkända för låtsashandel. Det skapar inga trades.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <span style={{ fontSize: 11, ...mutedTextStyle(theme), textTransform: 'uppercase', letterSpacing: '0.08em' }}>Nuvarande maxApproved</span>
            <select
              value={draftMaxApproved}
              onChange={(e) => setDraftMaxApproved(e.target.value)}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--surface)',
                color: 'var(--text)',
                padding: '10px 12px',
                fontSize: 14,
              }}
            >
              {Array.from({ length: hardMaxApproved }, (_, index) => index + minApproved).map((value) => (
                <option key={value} value={String(value)}>{value}</option>
              ))}
            </select>
          </label>
          <div style={{ fontSize: 12, ...mutedTextStyle(theme) }}>
            Max tillåtet: {hardMaxApproved}. Senast sparat: {num(config?.maxApproved ?? approvals?.maxApproved) || '–'}.
          </div>
          <button
            type="button"
            disabled={busyId === 'config' || num(draftMaxApproved) === maxApproved}
            style={btnStyle(busyId === 'config' || num(draftMaxApproved) === maxApproved, 'ok')}
            onClick={askConfigSave}
          >
            Spara max
          </button>
        </div>
      </div>

      {message ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: message.type === 'ok' ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.22)', background: 'var(--surface-2)', color: message.type === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
          {message.text}
        </div>
      ) : null}

      {confirm ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(56,189,248,0.22)', background: 'var(--surface-2)' }}>
          <div style={{ marginBottom: 8 }}>
            {confirm.kind === 'config'
              ? `Detta ändrar bara hur många strategier som får vara godkända för låtsashandel. Det skapar inga trades.`
              : confirm.action === 'approve'
                ? `Detta godkänner ${confirm.name} för låtsashandel. Den får bara skapa paper trades om övriga regler godkänner. Inga riktiga order kan läggas.`
                : `Detta tar bara bort ${confirm.name} från paper allowlist. Inga riktiga order påverkas.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={btnStyle(false, confirm.kind === 'config' ? 'ok' : (confirm.action === 'approve' ? 'ok' : 'danger'))} onClick={runAction}>Bekräfta</button>
            <button type="button" style={btnStyle(false, 'neutral')} onClick={() => setConfirm(null)}>Avbryt</button>
          </div>
        </div>
      ) : null}

      {loading ? <div style={mutedTextStyle(theme)}>Hämtar allowlist...</div> : null}

      {approvalsState.error ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(239,68,68,0.22)', background: 'var(--surface-2)', color: 'var(--danger)' }}>
          {approvalsState.error}
        </div>
      ) : null}

      {configState.error ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(239,68,68,0.22)', background: 'var(--surface-2)', color: 'var(--danger)' }}>
          {configState.error}
        </div>
      ) : null}

      {config?.warning ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(245, 158, 11, 0.22)', background: 'var(--surface-2)', color: 'var(--warning)' }}>
          Allowlist-config saknade eller var trasig. Fallback {maxApproved || 4} används tills den sparas igen.
        </div>
      ) : null}

      {!paperOnly && !loading ? (
        <div style={{ ...sectionStyle(), borderColor: 'rgba(239,68,68,0.22)', background: 'var(--surface-2)', color: 'var(--danger)' }}>
          Säkerhetsläget kunde inte bekräftas som paper_only — åtgärder är dolda.
        </div>
      ) : null}

      {paperOnly ? (
        <>
          <div style={{ fontWeight: 800, marginTop: 6, marginBottom: 6 }}>Godkända strategier ({approvedCount})</div>
          {approvedRows.length > 0 ? (
            <div style={{ overflowX: 'auto', marginBottom: 14 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr>{['Strategy id', 'Namn', 'Runtime ready', 'Events (fönster)', 'Senaste aktivitet', ''].map((l) => <th key={l} style={{ ...cellStyle(), ...mutedTextStyle(theme) }}>{l}</th>)}</tr></thead>
                <tbody>
                  {approvedRows.map((r) => (
                    <tr key={r.id} className={`allowlist-row allowlist-row-approved allowlist-row-${allowlistTone(r.allowlistStatus)}`}>
                      <td style={cellStyle()}>{r.id}</td>
                      <td style={cellStyle()}>{r.name}</td>
                      <td style={cellStyle()}>{r.runtimeReady ? 'Ja' : 'Nej'}</td>
                      <td style={cellStyle()}>{r.events}</td>
                      <td style={cellStyle()}>{r.latestAt ? fmtTime(r.latestAt) : '–'}</td>
                      <td style={cellStyle()}>
                        <button type="button" disabled={busyId === r.id} style={btnStyle(busyId === r.id, 'danger')} onClick={() => ask('reject', r.id, r.name)}>Ta bort från paper allowlist</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ ...mutedTextStyle(theme), marginBottom: 14 }}>Inga godkända strategier ännu.</div>}

          <div style={{ fontWeight: 800, marginBottom: 6 }}>Icke-godkända strategier med aktivitet</div>
          <div style={{ fontSize: 11.5, ...mutedTextStyle(theme), marginBottom: 6 }}>
            Sorterade efter antal blockeringar. {slotFree ? '' : 'Max antal godkända är nått — ta bort en strategi först eller höj maxgränsen. '}Om godkännande nekas visas exakt orsak från servern (t.ex. svag strategi eller maxgräns).
          </div>
          {nonApproved.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead><tr>{['Strategy id', 'Namn', 'Blockeringar', 'Senaste orsak', 'Senaste aktivitet', ''].map((l) => <th key={l} style={{ ...cellStyle(), ...mutedTextStyle(theme) }}>{l}</th>)}</tr></thead>
                <tbody>
                  {nonApproved.map((r) => (
                    <tr key={r.id} className={`allowlist-row allowlist-row-${allowlistTone(r.allowlistStatus)}`}>
                      <td style={cellStyle()}>{r.id}</td>
                      <td style={cellStyle()}>{r.name}</td>
                      <td style={cellStyle()}>{r.blockedCount}</td>
                      <td style={{ ...cellStyle(), maxWidth: 280 }}>{r.reason || '–'}</td>
                      <td style={cellStyle()}>{r.latestAt ? fmtTime(r.latestAt) : '–'}</td>
                      <td style={cellStyle()}>
                        {slotFree ? (
                          <button type="button" disabled={busyId === r.id} style={btnStyle(busyId === r.id, 'ok')} onClick={() => ask('approve', r.id, r.name)}>Lägg till i paper allowlist</button>
                        ) : (
                          <span title="Max antal godkända är nått. Ta bort en strategi först eller höj maxgränsen." style={{ ...btnStyle(true, 'ok'), display: 'inline-block' }}>Max nått</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={mutedTextStyle(theme)}>Inga icke-godkända strategier med aktivitet i fönstret.</div>}
        </>
      ) : null}
    </div>
  );
}

// ── Read-only truth panels (observability only — no trading behaviour) ─────────
// Both panels read additive, read-only endpoints. They never place orders, never
// touch the gate (PAPER_ENTRY_QUALITY_GATE_ENABLED), never change exit behaviour.

function useStrategyPipelineTruth(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/strategy-pipeline-truth')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (alive) setState({ loading: false, data: null, error: String(err?.message || err) }); });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function useShortExitTruth(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/short-exit-truth')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (alive) setState({ loading: false, data: null, error: String(err?.message || err) }); });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function fmtDurSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  if (n < 60) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function chainStopTone(code) {
  if (code === 'trades_ok') return 'success';
  if (code === 'proposed_not_approved' || code === 'approved_not_allowlisted') return 'neutral';
  if (code === 'allowlist_block' || code === 'no_matching_signal_subtype' || code === 'market_closed') return 'warning';
  if (code === 'missing_data' || code === 'unknown') return 'danger';
  return 'info';
}

function approvalTone(status) {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

function pipelineStrategyColumns(theme, primaryWindow = '7d') {
  return [
    { key: 'strategyId', label: 'strategyId', render: (row) => <span style={{ fontWeight: 700 }}>{row.strategyId}</span> },
    { key: 'name', label: 'Namn' },
    {
      key: 'approvalStatus',
      label: 'Status',
      render: (row) => <span style={statusPillStyle(approvalTone(row.approvalStatus), theme, true)}>{row.approvalStatus}</span>,
    },
    { key: 'hasDetector', label: 'Katalog/detector', render: (row) => (row.hasDetector ? 'ja' : 'nej') },
    { key: 'listedInApprovals', label: 'I approvals.json', render: (row) => (row.listedInApprovals ? 'ja' : 'nej') },
    { key: 'paperEnabled', label: 'Paper-enabled / allowlist', render: (row) => (row.paperEnabled ? 'ja' : 'nej') },
    { key: 'signals', label: 'Signaler 24h/3d/7d', render: (row) => `${row.signals?.['24h'] ?? 0} / ${row.signals?.['3d'] ?? 0} / ${row.signals?.['7d'] ?? 0}` },
    { key: 'candidates', label: 'Kandidater 24h/3d/7d', render: (row) => `${row.candidates?.['24h'] ?? 0} / ${row.candidates?.['3d'] ?? 0} / ${row.candidates?.['7d'] ?? 0}` },
    { key: 'paperTrades', label: 'Trades 24h/3d/7d', render: (row) => `${row.paperTrades?.['24h'] ?? 0} / ${row.paperTrades?.['3d'] ?? 0} / ${row.paperTrades?.['7d'] ?? 0}` },
    { key: 'commonBlockerReason', label: 'Vanligaste blocker', render: (row) => row.commonBlockerReason || '–' },
    {
      key: 'chainStop',
      label: `Stannar (${primaryWindow})`,
      render: (row) => (
        <span title={row.chainStopSv} style={statusPillStyle(chainStopTone(row.chainStop), theme, true)}>{row.chainStop}</span>
      ),
    },
  ];
}

function StrategyPipelineTruthPanel({ pipeline, loading, error }) {
  const theme = useThemeMode();
  if (loading && !pipeline) {
    return <div style={sectionStyle()}>Hämtar strategy pipeline truth...</div>;
  }
  if (error && !pipeline) {
    return (
      <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.22)', background: 'var(--surface-2)' }}>
        <strong>Varför gör strategier inte paper trades?</strong>
        <div style={{ marginTop: 4, color: 'var(--warning)', fontSize: 13 }}>Tillfälligt otillgängligt: {error}</div>
      </div>
    );
  }
  if (!pipeline?.ok) return null;
  const counts = pipeline.counts || {};
  const groups = pipeline.groups || {};
  const primary = pipeline.primaryWindow || '7d';
  const columns = pipelineStrategyColumns(theme, primary);
  const zeroColumns = [
    { key: 'strategyId', label: 'strategyId', render: (row) => <span style={{ fontWeight: 700 }}>{row.strategyId}</span> },
    { key: 'name', label: 'Namn' },
    { key: 'approvalStatus', label: 'Status', render: (row) => <span style={statusPillStyle(approvalTone(row.approvalStatus), theme, true)}>{row.approvalStatus}</span> },
    { key: 'signals7d', label: 'Signaler 7d', render: (row) => row.signals7d ?? 0 },
    { key: 'chainStop', label: 'Stannar', render: (row) => <span title={row.chainStopSv} style={statusPillStyle(chainStopTone(row.chainStop), theme, true)}>{row.chainStop}</span> },
    { key: 'chainStopSv', label: 'Förklaring', render: (row) => <span style={{ ...mutedTextStyle(theme), fontSize: 12 }}>{row.chainStopSv}</span> },
  ];
  return (
    <div style={sectionStyle()}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Varför gör strategier inte paper trades?</h3>
        <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>
          Godkänd betyder inte alltid att strategin är körbar i paper runtime.<br />
          Denna vy visar var strategin stannar. Read-only — inga trades påverkas.
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <MetricCard label="Strategier" value={counts.strategies ?? 0} />
        <MetricCard label="Godkända" value={counts.approved ?? 0} tone="good" />
        <MetricCard label="Godkända som tradar" value={counts.approvedTrading ?? 0} tone="good" />
        <MetricCard label="Godkända utan trades" value={counts.approvedNotTrading ?? 0} tone="warn" />
        <MetricCard label="Rejected" value={counts.rejected ?? 0} tone="bad" />
        <MetricCard label="Föreslagna" value={counts.proposed ?? 0} />
      </div>
      <DataTable
        title="Godkända som tradar"
        subtitle="Godkänd allowlist + faktiska paper trades i 7d-fönstret."
        rows={groups.approvedTrading || []}
        emptyText="Ingen godkänd strategi har tradat i 7d-fönstret."
        rowKey={(row) => `at-${row.strategyId}`}
        columns={columns}
      />
      <DataTable
        title="Godkända som inte tradar"
        subtitle="Godkända men 0 paper trades — kolumnen Stannar visar var kedjan bryts."
        rows={groups.approvedNotTrading || []}
        emptyText="Alla godkända strategier tradar i 7d-fönstret."
        rowKey={(row) => `ant-${row.strategyId}`}
        columns={columns}
      />
      <DataTable
        title="Rejected som emitterar men blockas"
        subtitle="Ej godkända strategier som ändå genererar signaler och stoppas av allowlisten."
        rows={groups.rejectedButEmitting || []}
        emptyText="Inga ej-godkända strategier emitterar signaler i 7d-fönstret."
        rowKey={(row) => `rbe-${row.strategyId}`}
        columns={columns}
      />
      <DataTable
        title="Strategier med 0 trades och varför"
        subtitle="Alla strategier utan paper trades i 7d-fönstret, med klassificerad stopp-punkt."
        rows={groups.zeroTradesWhy || []}
        emptyText="Inga strategier saknar trades i 7d-fönstret."
        rowKey={(row) => `ztw-${row.strategyId}`}
        columns={zeroColumns}
      />
    </div>
  );
}

function shortExitStatColumns(theme) {
  return [
    { key: 'label', label: 'Grupp', render: (row) => <span style={{ fontWeight: 700 }}>{row.label}</span> },
    { key: 'count', label: 'Trades', render: (row) => row.s?.count ?? 0 },
    { key: 'medianDurationSec', label: 'Median duration', render: (row) => fmtDurSec(row.s?.medianDurationSec) },
    { key: 'pctUnder5min', label: '% under 5 min', render: (row) => `${row.s?.pctUnder5min ?? 0}%` },
    { key: 'targetHits', label: 'Target hits', render: (row) => row.s?.targetHits ?? 0 },
    { key: 'tightenedStop', label: 'tightened_stop', render: (row) => row.s?.tightenedStop ?? 0 },
    { key: 'momentumFade', label: 'momentum_fade', render: (row) => row.s?.momentumFade ?? 0 },
    { key: 'defaultExits', label: 'default', render: (row) => row.s?.defaultExits ?? 0 },
  ];
}

function ShortExitTruthPanel({ shortExit, loading, error }) {
  const theme = useThemeMode();
  const [windowKey, setWindowKey] = useState('7d');
  if (loading && !shortExit) {
    return <div style={sectionStyle()}>Hämtar short exit truth...</div>;
  }
  if (error && !shortExit) {
    return (
      <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.22)', background: 'var(--surface-2)' }}>
        <strong>Varför stängs trades snabbt?</strong>
        <div style={{ marginTop: 4, color: 'var(--warning)', fontSize: 13 }}>Tillfälligt otillgängligt: {error}</div>
      </div>
    );
  }
  if (!shortExit?.ok) return null;
  const windowOptions = Object.keys(shortExit.windows || { '24h': 0, '3d': 0, '7d': 0 });
  const w = shortExit.windows?.[windowKey] || {};
  const overall = w.overall || { count: 0 };
  const exitReasonTop = Array.isArray(overall.exitReasonTop) ? overall.exitReasonTop : [];
  const strategyRows = Object.entries(w.byStrategy || {}).map(([label, s]) => ({ label, s }));
  const setupRows = Object.entries(w.bySetup || {}).map(([label, s]) => ({ label, s }));
  const statusRows = Object.entries(w.byStatus || {}).map(([label, s]) => ({ label, s }));
  const statColumns = shortExitStatColumns(theme);
  return (
    <div style={sectionStyle()}>
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18 }}>Varför stängs trades snabbt?</h3>
          <div style={{ ...mutedTextStyle(theme), marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>
            Detta ändrar inte exit. Det visar bara varför trades stängdes.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {windowOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setWindowKey(opt)}
              style={{
                ...statusPillStyle(opt === windowKey ? 'info' : 'neutral', theme, true),
                cursor: 'pointer',
                border: opt === windowKey ? '1px solid rgba(56,189,248,0.30)' : '1px solid var(--border)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <MetricCard label="Total trades" value={overall.count ?? 0} />
        <MetricCard label="Median duration" value={fmtDurSec(overall.medianDurationSec)} />
        <MetricCard label="% under 5 min" value={`${overall.pctUnder5min ?? 0}%`} tone={(overall.pctUnder5min ?? 0) >= 50 ? 'warn' : 'neutral'} />
        <MetricCard label="Target hits" value={overall.targetHits ?? 0} tone="good" />
        <MetricCard label="tightened_stop" value={overall.tightenedStop ?? 0} />
        <MetricCard label="momentum_fade" value={overall.momentumFade ?? 0} />
        <MetricCard label="default exits" value={overall.defaultExits ?? 0} />
      </div>
      <DataTable
        title="exitReasonCode-topplista"
        subtitle={`Fönster: ${windowKey}. Andel av stängda trades per exit-reason.`}
        rows={exitReasonTop}
        emptyText="Inga stängda trades i detta fönster."
        rowKey={(row, index) => `er-${row.code}-${index}`}
        columns={[
          { key: 'code', label: 'exitReasonCode', render: (row) => <span style={{ fontWeight: 700 }}>{row.code}</span> },
          { key: 'count', label: 'Antal' },
          { key: 'pct', label: 'Andel', render: (row) => `${row.pct ?? 0}%` },
        ]}
      />
      <DataTable
        title="Per strategi"
        subtitle="trend_continuation / narrow_breakout / narrow_state_expansion_long."
        rows={strategyRows}
        emptyText="Ingen strategidata i detta fönster."
        rowKey={(row) => `ses-${row.label}`}
        columns={statColumns}
      />
      <DataTable
        title="Per setup / status"
        subtitle="REGULAR_PULLBACK / NARROW_WAIT m.fl. samt statusAtEntry (caution/watch)."
        rows={[...setupRows, ...statusRows]}
        emptyText="Ingen setup-data i detta fönster."
        rowKey={(row) => `set-${row.label}`}
        columns={statColumns}
      />
    </div>
  );
}

export default function PaperTradingPage() {
  const theme = useThemeMode();
  const [refreshKey, setRefreshKey] = useState(0);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const safetyState = useSafetyStatus(refreshKey);
  const gateStatusState = useGateStatus(refreshKey);
  const riskPauseSummaryState = useRiskPauseSummary(refreshKey);
  const approvalPreviewState = useApprovalPreview(refreshKey);
  const tradingViewBlueprintState = useTradingViewBlueprints(refreshKey);
  const runtimeState = usePaperRuntime(50);
  const explanationsState = useTradeExplanations(50);
  const exitComparisonState = useExitProfileComparison(131);
  const lossReviewState = useLossReviewQueue(refreshKey);
  const allowlistState = usePaperAllowlist(refreshKey);
  const strategyPipelineTruthState = useStrategyPipelineTruth(refreshKey);
  const shortExitTruthState = useShortExitTruth(refreshKey);
  const [expandedTradeKey, setExpandedTradeKey] = useState(null);
  const [lossReviewPreview, setLossReviewPreview] = useState({ loadingGroupId: null, groupId: null, data: null, error: null });
  const runtime = runtimeState.data;
  const summary = runtime?.summary || {};
  const explanationsByKey = useMemo(() => {
    const map = new Map();
    const items = Array.isArray(explanationsState.data?.items) ? explanationsState.data.items : [];
    items.forEach((item) => {
      const key = tradeLookupKey(item);
      if (key) map.set(key, item);
    });
    return map;
  }, [explanationsState.data]);
  const warnings = useMemo(() => {
    const list = [];
    if (runtimeState.error) list.push(`Paper runtime tillfälligt otillgängligt: ${runtimeState.error}`);
    if (explanationsState.error) list.push(`Trade explanations tillfälligt otillgängligt: ${explanationsState.error}`);
    if (exitComparisonState.error) list.push(`Exit profile comparison tillfälligt otillgängligt: ${exitComparisonState.error}`);
    if (lossReviewState.error) list.push(`Loss review queue tillfälligt otillgängligt: ${lossReviewState.error}`);
    if (runtime?.status === 'degraded') list.push(`Degraded read-only data: ${(runtime.warnings || []).join(', ') || 'okänd källa'}`);
    return list;
  }, [explanationsState.error, exitComparisonState.error, lossReviewState.error, runtimeState.error, runtime]);

  const openTrades = runtime?.openTrades || [];
  const closedTrades = runtime?.closedTrades || [];
  const blockedCandidates = runtime?.blockedCandidates || [];
  const recentEvents = runtime?.recentEvents || [];
  const strategies = runtime?.strategies || [];
  const dailySelectionPreview = runtime?.dailySelectionPreview || null;
  const selectedClosedTrade = useMemo(() => {
    if (!expandedTradeKey) return null;
    return closedTrades.find((row) => {
      const key = tradeLookupKey(row);
      return key === expandedTradeKey;
    }) || null;
  }, [closedTrades, expandedTradeKey]);
  const closedTradeExplanation = expandedTradeKey ? explanationsByKey.get(expandedTradeKey) || null : null;
  const selectedLookup = useTradeExplanationLookup(
    selectedClosedTrade,
    Boolean(expandedTradeKey && selectedClosedTrade && !closedTradeExplanation),
  );
  const selectedLookupData = selectedLookup.data;
  const selectedLookupExplanation = selectedLookupData?.found ? selectedLookupData.tradeExplanation : null;
  const selectedLookupDiagnosis = selectedLookupData?.found === false ? selectedLookupData.diagnosis : null;
  const activeClosedTradeExplanation = closedTradeExplanation || selectedLookupExplanation || null;

  async function loadLossReviewPreview(groupId) {
    const id = String(groupId || '').trim();
    if (!id) return;
    setLossReviewPreview({ loadingGroupId: id, groupId: id, data: null, error: null });
    try {
      const data = await fetchJsonWithTimeout(`/api/paper-trading/loss-review-queue/${encodeURIComponent(id)}/test-preview`);
      if (!data?.ok) throw new Error(data?.error || 'Kunde inte bygga loss-review preview.');
      setLossReviewPreview({ loadingGroupId: null, groupId: id, data, error: null });
    } catch (err) {
      setLossReviewPreview({
        loadingGroupId: null,
        groupId: id,
        data: null,
        error: friendlyLossReviewError(err, 'Loss review preview är tillfälligt otillgängligt.'),
      });
    }
  }

  return (
    <div className="page-wrap">
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">Paper trading</div>
          <div className="hero-sub">Read-only runtimevy för paper-only-systemet.</div>
        </div>
      </div>

      <PaperControlRoomPanel
        runtime={runtime}
        safetyStatus={safetyState.data}
        gateStatus={gateStatusState.data}
        approvalPreview={approvalPreviewState.data}
        allowlist={allowlistState.data}
      />

      <SafetyBanner safety={runtime?.safety || runtime} />

      <TopStrategySelectorPanel preview={dailySelectionPreview} />

      <PaperMarketsPanel refreshKey={marketRefreshKey} onRefresh={() => setMarketRefreshKey((t) => t + 1)} />

      <DailySelectionPreviewPanel preview={dailySelectionPreview} />

      <WhyNoTradesPanel
        runtime={runtime}
        allowlist={allowlistState.data}
        riskPauseSummary={riskPauseSummaryState.data}
        gateStatus={gateStatusState.data}
        onRefresh={() => setRefreshKey((t) => t + 1)}
      />

      <StrategyPipelineTruthPanel
        pipeline={strategyPipelineTruthState.data}
        loading={strategyPipelineTruthState.loading}
        error={strategyPipelineTruthState.error}
      />

      <PaperAllowlistManager runtime={runtime} allowlist={allowlistState.data} refreshKey={refreshKey} onRefresh={() => setRefreshKey((t) => t + 1)} />

      {tradingViewBlueprintState.loading && !tradingViewBlueprintState.data ? (
        <div style={sectionStyle()}>Hämtar TradingView Test Blueprint...</div>
      ) : null}

      {tradingViewBlueprintState.error ? (
        <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.22)', background: 'var(--surface-2)' }}>
          <div style={{ color: 'var(--warning)', fontWeight: 700 }}>{tradingViewBlueprintState.error}</div>
        </div>
      ) : null}

      <TradingViewTestBlueprintPanel data={tradingViewBlueprintState.data} theme={theme} />

      <TradingViewTestResultsPanel theme={theme} />

      <PaperCandidatePanel mode="paper" />

      {runtimeState.loading && !runtime ? (
        <div style={sectionStyle()}>Hämtar paper runtime...</div>
      ) : null}

      {warnings.length ? (
        <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.22)', background: 'var(--surface-2)' }}>
          {warnings.map((warning) => (
            <div key={warning} style={{ color: 'var(--warning)', marginBottom: 6 }}>{warning}</div>
          ))}
        </div>
      ) : null}

      <SummaryGrid runtime={runtime} />

      <ExitProfileComparisonPanel comparison={exitComparisonState.data} theme={theme} />

      <ShortExitTruthPanel
        shortExit={shortExitTruthState.data}
        loading={shortExitTruthState.loading}
        error={shortExitTruthState.error}
      />

      <DataTable
        title="Open paper trades"
        subtitle="Aktiva paper-only positioner från state.json"
        rows={openTrades}
        emptyText="Inga öppna paper trades just nu."
        rowKey={(row, index) => row.tradeId || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'setup', label: 'Setup' },
          { key: 'direction', label: 'Direction' },
          { key: 'source', label: 'Source' },
          { key: 'opened_at', label: 'Opened', render: (row) => fmtTime(row.opened_at) },
          { key: 'paperOnly', label: 'paperOnly', render: (row) => String(row.paperOnly === true) },
        ]}
      />

      <DataTable
        title="Closed paper trades"
        subtitle={`Senaste closed trades. Total closed i runtime: ${summary.closedCount ?? 0}`}
        rows={closedTrades}
        emptyText="Inga stängda paper trades ännu."
        rowKey={(row, index) => tradeLookupKey(row) || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'setup', label: 'Setup' },
          { key: 'result', label: 'Result', render: (row) => <span style={{ color: toneForResult(row.result), fontWeight: 700 }}>{row.result || '–'}</span> },
          { key: 'pnlPct', label: 'PnL %', render: (row) => <span style={{ color: toneForResult(row.result) }}>{fmtPct(row.pnlPct)}</span> },
          { key: 'opened_at', label: 'Opened', render: (row) => fmtTime(row.opened_at) },
          { key: 'closed_at', label: 'Closed', render: (row) => fmtTime(row.closed_at) },
          { key: 'source', label: 'Source' },
          { key: 'paperOnly', label: 'paperOnly', render: (row) => String(row.paperOnly === true) },
          {
            key: 'why',
            label: 'Why',
            render: (row) => {
              const key = tradeLookupKey(row);
              const isOpen = expandedTradeKey === key;
              return (
                <button
                  type="button"
                  onClick={() => setExpandedTradeKey(isOpen ? null : key)}
                  style={{
                    ...explanationBadgeStyle(isOpen ? 'info' : 'neutral'),
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    border: isOpen ? '1px solid rgba(56,189,248,0.22)' : '1px solid var(--border)',
                  }}
                >
                  {isOpen ? 'Dölj' : 'Visa varför'}
                </button>
              );
            },
          },
        ]}
      />
      <LossReviewQueuePanel
        review={lossReviewState.data}
        loading={lossReviewState.loading}
        error={lossReviewState.error}
        theme={theme}
        previewState={lossReviewPreview}
        onPreviewGroup={loadLossReviewPreview}
      />
      {expandedTradeKey ? (
        <div style={{ marginTop: -10, marginBottom: 18 }}>
          {activeClosedTradeExplanation ? (
            <>
              <ClosedTradeExplanationPanel explanation={activeClosedTradeExplanation} trade={selectedClosedTrade} theme={theme} />
              <EntryQualityGatePanel gate={activeClosedTradeExplanation.entryQualityGate} theme={theme} />
            </>
          ) : selectedLookup.loading ? (
            <div style={{ ...sectionStyle(), borderColor: 'rgba(56,189,248,0.18)', background: 'var(--surface-2)' }}>
              <strong>Hämtar förklaring...</strong>
              <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 13 }}>
                Läser read-only historik för att matcha traden mot loggen.
              </div>
            </div>
          ) : selectedLookup.error ? (
            <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.18)', background: 'var(--surface-2)' }}>
              <strong>Trade explanations tillfälligt otillgängligt</strong>
              <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 13 }}>
                {selectedLookup.error}
              </div>
            </div>
          ) : selectedLookupDiagnosis ? (
            <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.18)', background: 'var(--surface-2)' }}>
              <strong>Förklaring saknas för denna trade eftersom äldre logg saknar matchande ID/tid.</strong>
              <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 13, lineHeight: 1.5 }}>
                Orsak: {explanationValue(selectedLookupDiagnosis.reason)}
                <br />
                Sökt symbol: {explanationValue(selectedLookupDiagnosis.searchedSymbol)}
                <br />
                Sökt strategyId: {explanationValue(selectedLookupDiagnosis.searchedStrategyId)}
                <br />
                Sökt openedAt: {explanationValue(selectedLookupDiagnosis.searchedOpenedAt)}
                <br />
                Tillgänglig närmaste match: {selectedLookupDiagnosis.availableClosestMatch ? `${selectedLookupDiagnosis.availableClosestMatch.symbol} · ${selectedLookupDiagnosis.availableClosestMatch.strategyId || 'unknown'} · ${fmtTime(selectedLookupDiagnosis.availableClosestMatch.openedAt)}` : 'ingen'}
              </div>
            </div>
          ) : (
            <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.18)', background: 'var(--surface-2)' }}>
              <strong>Saknas i loggning</strong>
              <div style={{ marginTop: 4, ...mutedTextStyle(theme), fontSize: 13 }}>
                Trade-explanation kunde inte matchas mot historiken. Kontrollera tradeId eller symbol + strategyId + openedAt.
              </div>
            </div>
          )}
        </div>
      ) : null}

      <DataTable
        title="Blocked candidates"
        subtitle="Signaler som stoppades innan paper trade skapades"
        rows={blockedCandidates}
        emptyText="Inga blocked candidates i senaste runtime-fönstret."
        rowKey={(row, index) => row.eventId || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'gateStage', label: 'Gate stage' },
          { key: 'blockedReason', label: 'Blocked reason' },
          { key: 'timestamp', label: 'Timestamp', render: (row) => fmtTime(row.timestamp) },
          { key: 'source', label: 'Source' },
        ]}
      />

      <DataTable
        title="Latest paper events"
        subtitle="Senaste paper-only runtime-events"
        rows={recentEvents}
        emptyText="Inga paper events ännu."
        rowKey={(row, index) => row.eventId || `${row.symbol}-${index}`}
        columns={[
          { key: 'type', label: 'Event type' },
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'timestamp', label: 'Timestamp', render: (row) => fmtTime(row.timestamp) },
          { key: 'reason', label: 'Reason / result', render: (row) => row.blockedReason || row.result || row.status || '–' },
          { key: 'source', label: 'Source' },
        ]}
      />

      <DataTable
        title="Strategy summary"
        subtitle="Aggregerat per canonical strategy_id"
        rows={strategies}
        emptyText="Inga strategier i runtime-fönstret ännu."
        rowKey={(row, index) => row.strategy_id || `strategy-${index}`}
        columns={[
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'openCount', label: 'Open' },
          { key: 'closedCount', label: 'Closed' },
          { key: 'blockedCount', label: 'Blocked' },
          { key: 'latestEventType', label: 'Latest event' },
          { key: 'latestEventAt', label: 'Latest at', render: (row) => fmtTime(row.latestEventAt) },
        ]}
      />
    </div>
  );
}
