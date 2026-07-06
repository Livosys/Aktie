import React, { useEffect, useMemo, useState } from 'react';
import TradingViewTestBlueprintPanel from '../components/TradingViewTestBlueprintPanel.jsx';
import TradingViewTestResultsPanel from '../components/TradingViewTestResultsPanel.jsx';
import tradingViewTestBlueprintFallback from '../utils/tradingview-test-blueprints.json';

const FETCH_TIMEOUT_MS = 6500;

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

function friendlyBlueprintError(err) {
  const message = String(err?.message || '').trim();
  if (/^HTTP 404$/i.test(message)) return 'Blueprint-data saknas ännu';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Blueprint-källa inte ansluten ännu';
  if (/^timeout_after_\d+ms$/i.test(message)) return 'Blueprint-källa inte ansluten ännu (timeout)';
  return message || 'Blueprint-källa inte ansluten ännu';
}

function usePineBlueprints() {
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
  const [state, setState] = useState({ loading: true, data: emptyPayload, error: null });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/paper-trading/tradingview-test-blueprints', { signal: controller.signal })
      .catch((err) => {
        const message = String(err?.message || '').trim();
        if (/^HTTP 404$/i.test(message) || /Failed to fetch|NetworkError|Load failed/i.test(message)) {
          return tradingViewTestBlueprintFallback;
        }
        throw err;
      })
      .then((data) => {
        if (!alive) return;
        const normalized = data && typeof data === 'object'
          ? {
              ...data,
              source: data.source || (Array.isArray(data.blueprints) && data.blueprints.length ? 'api' : 'none'),
            }
          : emptyPayload;
        setState({ loading: false, data: normalized, error: null });
      })
      .catch((err) => {
        if (!alive) return;
        setState({ loading: false, data: emptyPayload, error: friendlyBlueprintError(err) });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [emptyPayload]);

  return state;
}

function Badge({ children, tone = 'neutral' }) {
  const colors = {
    neutral: 'rgba(148,163,184,0.16)',
    success: 'rgba(34,197,94,0.14)',
    warning: 'rgba(245,158,11,0.14)',
    info: 'rgba(56,189,248,0.14)',
  };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      border: '1px solid var(--border)',
      borderRadius: 999,
      padding: '5px 9px',
      background: colors[tone] || colors.neutral,
      color: 'var(--text)',
      fontSize: 12,
      fontWeight: 800,
    }}
    >
      {children}
    </span>
  );
}

function ResearchCard({ title, meta, children }) {
  return (
    <article style={{
      border: '1px solid var(--border)',
      borderRadius: 14,
      padding: 16,
      background: 'color-mix(in srgb, var(--surface) 92%, transparent)',
      minHeight: 132,
    }}
    >
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {meta}
      </div>
      <h2 style={{ margin: '6px 0 8px', fontSize: 17, letterSpacing: 0 }}>{title}</h2>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
        {children}
      </p>
    </article>
  );
}

function PipelineStep({ index, title, text }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '34px 1fr',
      gap: 10,
      alignItems: 'start',
      padding: '12px 0',
      borderTop: index === 1 ? 'none' : '1px solid var(--border)',
    }}
    >
      <div style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(56,189,248,0.14)',
        border: '1px solid rgba(56,189,248,0.3)',
        fontSize: 12,
        fontWeight: 900,
      }}
      >
        {index}
      </div>
      <div>
        <div style={{ fontWeight: 850, marginBottom: 3 }}>{title}</div>
        <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{text}</div>
      </div>
    </div>
  );
}

export default function PinescriptPage() {
  const theme = useThemeMode();
  const blueprintState = usePineBlueprints();

  return (
    <main className="page" style={{ maxWidth: 1180, margin: '0 auto', padding: '32px 24px 56px' }}>
      <section style={{
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: 22,
        marginBottom: 18,
        background: 'var(--surface)',
      }}
      >
        <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Automatisk research-loop
        </div>
        <h1 style={{ margin: '6px 0 8px', fontSize: 32, letterSpacing: 0 }}>PineScript</h1>
        <p style={{ margin: 0, maxWidth: 760, color: 'var(--muted)', lineHeight: 1.6 }}>
          Trading OS ska själv skapa strategi- och Pine-versioner, köra replay/batch/backtest,
          läsa resultat och förbättra svaga versioner. PineScript är export, visualisering
          och validering - inte execution eller orderflöde.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          <Badge tone="success">mode=paper_only</Badge>
          <Badge>actions_allowed=false</Badge>
          <Badge>can_place_orders=false</Badge>
          <Badge>live_trading_enabled=false</Badge>
          <Badge>broker_enabled=false</Badge>
          <Badge tone="info">Read-only</Badge>
        </div>
      </section>

      <section style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
        gap: 16,
        marginBottom: 18,
      }}
      >
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 18,
          padding: 20,
          background: 'var(--surface)',
        }}
        >
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Pipeline
          </div>
          <h2 style={{ margin: '6px 0 10px', fontSize: 22, letterSpacing: 0 }}>
            AI utvecklar, Trading OS testar
          </h2>
          <PipelineStep
            index={1}
            title="AI skapar version"
            text="Systemet tar fram strategi- och PineScript-varianter från befintliga regler, signaler och learning."
          />
          <PipelineStep
            index={2}
            title="Replay, batch och backtest körs automatiskt"
            text="Trading OS mäter versionerna i den interna testmotorn innan något markeras som lovande."
          />
          <PipelineStep
            index={3}
            title="Resultat analyseras"
            text="AI-score väger winrate, profit factor, net profit %, max drawdown, antal trades, stabilitet och risk/reward."
          />
          <PipelineStep
            index={4}
            title="Svaga versioner förbättras"
            text="Om score är för lågt skapas en ny version och testloopen upprepas."
          />
          <PipelineStep
            index={5}
            title="Lovande först vid 70-80+ AI-score"
            text="70-80+ betyder samlad AI-score av 100, inte bara winrate. Strategin ska vara robust över perioder, symboler och timeframes."
          />
        </div>

        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 18,
          padding: 20,
          background: 'var(--surface)',
        }}
        >
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Roll
          </div>
          <h2 style={{ margin: '6px 0 10px', fontSize: 22, letterSpacing: 0 }}>
            PineScript är inte testmotorn
          </h2>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
            TradingView/PineScript används som export- och valideringsyta. Den automatiska
            research-loopen körs i Trading OS, där resultat och learning kan jämföras innan
            en version anses stark nog.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <Badge tone="info">Systemet testar själv</Badge>
            <Badge>Ingen TradingView-forwarding</Badge>
            <Badge>Ingen broker</Badge>
            <Badge>Ingen riskändring</Badge>
          </div>
        </div>
      </section>

      <section style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
        marginBottom: 18,
      }}
      >
        <ResearchCard title="AI skapar versioner" meta="Steg 1">
          Nya strategi- och Pine-versioner ska genereras från befintlig strategi-logik,
          replay-resultat och learning.
        </ResearchCard>
        <ResearchCard title="Systemet testar" meta="Steg 2">
          Batch, replay och backtest ska köras av Trading OS. Användaren ska inte behöva
          testa manuellt i TradingView.
        </ResearchCard>
        <ResearchCard title="AI förbättrar" meta="Steg 3">
          Svaga versioner ska få justerade regler, filter eller risk/reward-antaganden och
          sedan testas igen.
        </ResearchCard>
        <ResearchCard title="70-80+ AI-score krävs" meta="Gate">
          En strategi blir lovande först när total score är hög nog och stabil över flera
          marknader, timeframes och perioder.
        </ResearchCard>
      </section>

      {blueprintState.loading && !blueprintState.data ? (
        <section style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 18, marginBottom: 18, background: 'var(--surface)' }}>
          Hämtar PineScript-blueprints...
        </section>
      ) : null}

      {blueprintState.error ? (
        <section style={{ border: '1px solid rgba(245,158,11,0.28)', borderRadius: 14, padding: 18, marginBottom: 18, background: 'var(--surface)' }}>
          <strong style={{ color: 'var(--warning)' }}>{blueprintState.error}</strong>
          <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 13 }}>
            Visar fallback-data om sådan finns. Ingen backend- eller execution-väg ändras.
          </div>
        </section>
      ) : null}

      <TradingViewTestBlueprintPanel data={blueprintState.data} theme={theme} />
      <TradingViewTestResultsPanel theme={theme} />
    </main>
  );
}
