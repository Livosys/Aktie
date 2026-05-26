import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';

// ── Preset: enkla namn mappade till interna ID:n ──────────────────────────────

const FRIENDLY_PRESETS = [
  { id: 'stocks_conservative',    name: 'Enkel & säker',       desc: 'Färre trades, mindre risk.' },
  { id: 'index_etf_normal',       name: 'Balanserad',           desc: 'Lagom många trades och normal risk.' },
  { id: 'crypto_vwap_aggressive', name: 'Aggressiv',            desc: 'Fler trades, högre risk.' },
  { id: 'crypto_vwap_v3_safe',    name: 'Krypto VWAP',         desc: 'Testar krypto med VWAP-regler.' },
  { id: 'leveraged_etf_safe',     name: 'Trendjagare',          desc: 'Letar efter stark riktning.' },
  { id: 'crypto_narrow_state',    name: 'Narrow State',         desc: 'Letar efter lugna lägen före rörelse.' },
  { id: 'mixed_market_defensive', name: 'Defensiv blandning',   desc: 'Blandar krypto, aktier och index försiktigt.' },
  { id: 'ema_off_vwap_only',      name: 'Bara VWAP',            desc: 'Testar enbart VWAP-signaler, utan EMA.' },
  { id: 'narrow_state_only',      name: 'Bara Narrow State',    desc: 'Testar enbart lugna lägen.' },
  { id: 'exit_engine_test',       name: 'Exit-test',            desc: 'Testar exitstrategier speciellt.' },
];

function presetLabel(id) {
  return FRIENDLY_PRESETS.find(p => p.id === id)?.name || id;
}
function presetDesc(id) {
  return FRIENDLY_PRESETS.find(p => p.id === id)?.desc || '';
}

// ── Metodbeskrivningar ────────────────────────────────────────────────────────

const METHOD_INFO = {
  ema_filter: {
    icon: '📉', name: 'EMA trendlinje',
    desc: 'Kollar om priset följer trenden.',
    on:  'Systemet filtrerar bort signaler som går mot trenden.',
    off: 'EMA-trenden påverkar inte testet alls.',
  },
  narrow_state: {
    icon: '🤫', name: 'Lugnt läge',
    desc: 'Letar efter när marknaden är lugn före en rörelse.',
    on:  'Systemet kan hitta tighta/lugna lägen och poängsätta dem.',
    off: 'Narrow State ignoreras helt.',
  },
  vwap_reclaim: {
    icon: '⬆️', name: 'VWAP återtag',
    desc: 'Kollar om priset tar tillbaka en viktig dagsnivå.',
    on:  'Systemet letar efter återtag av VWAP.',
    off: 'VWAP reclaim ignoreras.',
  },
  vwap_rejection: {
    icon: '⬇️', name: 'VWAP avvisning',
    desc: 'Kollar om priset nekas vid en viktig dagsnivå.',
    on:  'Systemet letar efter avvisningar vid VWAP.',
    off: 'VWAP rejection ignoreras.',
  },
  market_compass: {
    icon: '🧭', name: 'Marknadskompassen',
    desc: 'Kollar om marknaden pekar åt rätt håll.',
    on:  'Signaler som går mot kompassen blockeras.',
    off: 'Kompassen påverkar inte testet.',
  },
  market_gate: {
    icon: '🚦', name: 'Marknadsfilter',
    desc: 'Stoppar svaga signaler innan de testas.',
    on:  'Bara tillräckligt starka signaler får gå vidare.',
    off: 'Fler signaler släpps igenom — också svagare.',
  },
  ai_agent: {
    icon: '🤖', name: 'AI-analys',
    desc: 'AI läser signalen och kan höja eller sänka poäng.',
    on:  'AI-agenten kan justera confidence uppåt eller nedåt.',
    off: 'AI-analys påverkar inte testet.',
  },
  memory: {
    icon: '🧠', name: 'Minne',
    desc: 'Kollar gamla liknande trades för att lära sig.',
    on:  'Systemet använder historiska resultat för att justera.',
    off: 'Gamla resultat påverkar inte detta test.',
  },
  trading_agents: {
    icon: '🔬', name: 'TradingAgents AI',
    desc: 'Djupare AI-analys med bull/bear-case per signal.',
    on:  'AI granskar varje signal extra noga och kan justera konfidens.',
    off: 'TradingAgents AI ignoreras.',
  },
  risk_engine: {
    icon: '🛡️', name: 'Riskmotor',
    desc: 'Skyddar mot för hög risk per trade.',
    on:  'Dåliga eller riskabla trades blockeras automatiskt.',
    off: 'Riskregler används inte i testet. Riktig handel är alltid av.',
  },
  execution_safety: {
    icon: '⛔', name: 'Säkerhetsmotor',
    desc: 'Extra kontroll som ser till att inget farligt händer.',
    on:  'Extra säkerhetskontroll körs på varje signal.',
    off: 'Säkerhetsmotorn hoppar över — bara tillåtet i testläge.',
  },
  exit_engine: {
    icon: '↘️', name: 'Exitmotor',
    desc: 'Bestämmer hur och när en trade ska stängas.',
    on:  'Systemet kan ta vinst tidigare eller hålla trade längre.',
    off: 'Enkel standardexit används istället.',
  },
  notification_engine: {
    icon: '🔔', name: 'Notiser',
    desc: 'Skickar notiser och larm under testet.',
    on:  'Systemet kan skapa alerts under körningen.',
    off: 'Inga notiser skickas — testet är tyst.',
  },
  volume_strength: {
    icon: '📊', name: 'Volymstyrka',
    desc: 'Kollar om det handlas mycket just nu.',
    on:  'Signaler med för svag volym kan stoppas.',
    off: 'Volym påverkar inte poängen i testet.',
  },
  data_freshness: {
    icon: '🕐', name: 'Datakvalitet',
    desc: 'Kontrollerar att prisdatan inte är för gammal.',
    on:  'Gammal eller osäker data blockeras.',
    off: 'Datakvaliteten ignoreras — bara tillåtet i test.',
  },
  market_group: {
    icon: '🗂️', name: 'Marknadsgrupp',
    desc: 'Skiljer på krypto, aktier, index och ETF.',
    on:  'Olika marknader får olika regler och poängsättning.',
    off: 'Alla marknader behandlas likadant.',
  },
  cooldown: {
    icon: '⏸️', name: 'Paus efter trade',
    desc: 'Väntar lite innan samma symbol testas igen.',
    on:  'Minskar risken för att testa för ofta på samma symbol.',
    off: 'Systemet kan testa samma symbol direkt igen.',
  },
};

// Ordning för byggklossar (togglebara metoder)
const TOGGLEABLE = [
  'ema_filter', 'narrow_state', 'vwap_reclaim', 'vwap_rejection',
  'market_compass', 'market_gate', 'ai_agent', 'memory', 'trading_agents',
  'risk_engine', 'execution_safety', 'exit_engine', 'notification_engine',
  'volume_strength', 'data_freshness', 'market_group', 'cooldown',
];

const MARKET_SYMBOLS = {
  crypto: 'BTCUSDT,ETHUSDT,SOLUSDT',
  stocks: 'AAPL,MSFT,NVDA,TSLA',
  index: 'SPY,QQQ,DIA,IWM',
  etf: 'SPY,QQQ,DIA,IWM',
  leveraged: 'TQQQ,SQQQ,SOXL,SOXS',
};

// ── Hjälpfunktioner ───────────────────────────────────────────────────────────

function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '–';
}
function fmtSigned(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}` : '–';
}

// ── Komponenter ───────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      className={`sl-toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-label={checked ? 'Stäng av' : 'Slå på'}
    >
      <span />
    </button>
  );
}

function SafetyBanner() {
  return (
    <div style={{
      background: 'var(--green-dim)', border: '1.5px solid var(--green)',
      borderRadius: 8, padding: '10px 16px', marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontSize: 22 }}>✅</span>
      <div>
        <strong style={{ color: 'var(--green)', fontSize: 14 }}>Riktig handel är avstängd.</strong>
        <span style={{ color: 'var(--muted)', fontSize: 13, marginLeft: 8 }}>
          Detta är bara test med historisk data. Inga riktiga pengar används.
        </span>
      </div>
    </div>
  );
}

function HelpBox() {
  return (
    <div className="sl-panel" style={{ border: '1.5px solid var(--blue-border)', background: 'var(--blue-dim)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 26 }}>🧩</span>
        <div>
          <strong style={{ fontSize: 14, display: 'block', marginBottom: 6 }}>Vad betyder detta?</strong>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.75 }}>
            Du bygger en strategi som Lego.<br />
            Varje ruta är en del av systemet.<br />
            <strong style={{ color: 'var(--green)' }}>Slå På</strong> det du vill testa.<br />
            <strong style={{ color: 'var(--muted)' }}>Slå Av</strong> det du inte vill ha.<br />
            Kör testet och se vad som<br />fungerade bäst.
          </p>
        </div>
      </div>
    </div>
  );
}

function MethodCard({ methodKey, enabled, pipelineState, onToggle }) {
  const [open, setOpen] = useState(false);
  const info = METHOD_INFO[methodKey] || {
    icon: '⚙️', name: methodKey, desc: 'Systemmodul.',
    on: 'Aktiv.', off: 'Inaktiv.',
  };
  const isBlocking  = pipelineState?.block === true;
  const isWarning   = pipelineState?.passed === false && !isBlocking;
  const cardBorder  = isBlocking ? 'var(--red-border)' : isWarning ? 'var(--yellow-border)' : enabled ? 'var(--green-border)' : 'var(--card-border)';
  const iconBg      = isBlocking ? 'var(--red-dim)' : isWarning ? 'var(--yellow-dim)' : enabled ? 'var(--green-dim)' : 'var(--bg)';
  const statusColor = isBlocking ? 'var(--red)' : isWarning ? 'var(--yellow)' : enabled ? 'var(--green)' : 'var(--muted)';
  const statusText  = isBlocking ? 'BLOCKERAR' : isWarning ? 'VARNING' : enabled ? 'PÅ' : 'AV';

  return (
    <div style={{
      border: `1.5px solid ${cardBorder}`, borderRadius: 10,
      padding: 12, background: 'var(--card-bg)',
      display: 'flex', flexDirection: 'column', gap: 8,
      transition: 'border-color 0.2s',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 20, background: iconBg, borderRadius: 6, padding: '3px 6px', flexShrink: 0 }}>
            {info.icon}
          </span>
          <div>
            <strong style={{ fontSize: 13, display: 'block', color: enabled ? 'inherit' : 'var(--muted)' }}>
              {info.name}
            </strong>
            <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusText}</span>
          </div>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>

      {/* Description */}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {info.desc}
      </p>

      {/* Pipeline state chip */}
      {pipelineState && (
        <div style={{
          fontSize: 11, color: 'var(--muted)', background: 'var(--bg)',
          borderRadius: 4, padding: '2px 6px', display: 'inline-block',
        }}>
          {pipelineState.reason} · {fmtSigned(pipelineState.score_delta)}
        </div>
      )}

      {/* Expandable info */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'none', border: 'none', color: 'var(--blue)',
          fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: 0,
        }}
      >
        {open ? '▲ Dölj info' : '▼ Vad gör detta?'}
      </button>

      {open && (
        <div style={{
          background: 'var(--bg)', borderRadius: 6,
          padding: '8px 10px', fontSize: 12, lineHeight: 1.7,
        }}>
          <div style={{ color: 'var(--green)', marginBottom: 3 }}>
            <strong>Om PÅ:</strong> {info.on}
          </div>
          <div style={{ color: 'var(--muted)' }}>
            <strong>Om AV:</strong> {info.off}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, desc, color }) {
  return (
    <div style={{
      background: 'var(--card-bg)', border: '1px solid var(--card-border)',
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || 'inherit', marginBottom: 2 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {desc && <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</div>}
    </div>
  );
}

// ── TradingAgents Result Memory panel ────────────────────────────────────────

const OUTCOME_LABEL = {
  correct:            { text: 'AI:n trodde rätt',    color: 'var(--green)'  },
  incorrect:          { text: 'AI:n trodde fel',      color: 'var(--red)'    },
  neutral:            { text: 'Liten rörelse',         color: 'var(--muted)'  },
  missed_opportunity: { text: 'AI:n missade en chans', color: 'var(--yellow)' },
  risk_saved:         { text: 'AI:n varnade bra',      color: 'var(--blue)'   },
  pending:            { text: 'Väntar på trade',       color: 'var(--muted)'  },
};

function AgentMemoryPanel({ symbol }) {
  const [data, setData]       = useState(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const load = useCallback(async (sym) => {
    if (!sym) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/tradingagents/results/${sym}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Okänt fel');
      setData(j);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(symbol); }, [symbol, load]);

  const stats = data?.stats;

  return (
    <div className="sl-panel" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <SectionHeader icon="🔬" title="Vad har AI lärt sig?" desc={`TradingAgents historik för ${symbol}`} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', borderRadius: 4, padding: '2px 8px', border: '1px solid var(--card-border)' }}>
            Endast analys — AI:n handlar inte
          </span>
          <button className="btn" style={{ fontSize: 12 }} onClick={() => load(symbol)} disabled={busy}>
            {busy ? '⏳' : 'Uppdatera'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
          {[
            { label: 'Analyser', value: stats.total_analyses ?? 0 },
            { label: 'Utvärderade', value: stats.total_evaluated ?? 0 },
            { label: 'Träffsäkerhet', value: stats.accuracy_pct != null ? `${stats.accuracy_pct}%` : '–', color: stats.accuracy_pct >= 60 ? 'var(--green)' : stats.accuracy_pct >= 40 ? 'var(--yellow)' : 'var(--red)' },
            { label: 'AI:n trodde rätt', value: stats.correct ?? 0, color: 'var(--green)' },
            { label: 'AI:n trodde fel', value: stats.incorrect ?? 0, color: 'var(--red)' },
            { label: 'Missade chanser', value: stats.missed_opportunity ?? 0, color: 'var(--yellow)' },
            { label: 'AI:n varnade bra', value: stats.risk_saved ?? 0, color: 'var(--blue)' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--card-border)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: color || 'inherit' }}>{value}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {data?.lessons?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <strong style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Senaste lärdomar</strong>
          <div className="sl-list">
            {data.lessons.map((l, i) => {
              const meta = OUTCOME_LABEL[l.outcome] || OUTCOME_LABEL.neutral;
              return (
                <div key={i} className="sl-list-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, paddingBottom: 6, borderBottom: '1px solid var(--card-border)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.text}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{l.recommendation}</span>
                    {l.pnl_pct != null && (
                      <span style={{ fontSize: 11, color: l.pnl_pct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {l.pnl_pct >= 0 ? '+' : ''}{Number(l.pnl_pct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text)' }}>{l.lesson}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data?.recent_outcomes?.length === 0 && !busy && (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0' }}>
          Inga utvärderade analyser än. Kör en analys och stäng en paper trade.
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--card-border)', paddingTop: 8, margin: '8px 0 0' }}>
        ⚠ Detta är bara analys. AI:n får inte handla. actions_allowed=false · can_place_orders=false
      </p>
    </div>
  );
}

// ── Sida ──────────────────────────────────────────────────────────────────────

export default function StrategyLabPage() {
  const [config, setConfig]               = useState(null);
  const [pipeline, setPipeline]           = useState(null);
  const [presets, setPresets]             = useState([]);
  const [results, setResults]             = useState(null);
  const [market, setMarket]               = useState('crypto');
  const [symbols, setSymbols]             = useState(MARKET_SYMBOLS.crypto);
  const [dateFrom, setDateFrom]           = useState('');
  const [dateTo, setDateTo]               = useState(new Date().toISOString().slice(0, 10));
  const [selectedPreset, setSelectedPreset] = useState('crypto_vwap_v3_safe');
  const [busy, setBusy]                   = useState(false);
  const [error, setError]                 = useState(null);
  const [agentMemorySymbol, setAgentMemorySymbol] = useState('BTCUSDT');

  async function refresh() {
    try {
      const [cfgR, pipeR, presetR, resR] = await Promise.all([
        fetch('/api/strategy-lab/config'),
        fetch('/api/strategy-lab/pipeline'),
        fetch('/api/strategy-lab/presets'),
        fetch('/api/strategy-lab/results'),
      ]);
      const [cfgJ, pipeJ, presetJ, resJ] = await Promise.all([
        cfgR.json(), pipeR.json(), presetR.json(), resR.json(),
      ]);
      if (!cfgR.ok) throw new Error(cfgJ?.error || `Config ${cfgR.status}`);
      if (!pipeR.ok) throw new Error(pipeJ?.error || `Pipeline ${pipeR.status}`);
      setConfig(cfgJ.config);
      setPipeline(pipeJ);
      setPresets(presetJ.presets || []);
      setResults(resJ);
      setSelectedPreset(cfgJ.config?.active_preset || 'crypto_vwap_v3_safe');
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  const methodState = useMemo(
    () => (pipeline?.methods || []).reduce((acc, m) => { acc[m.method] = m; return acc; }, {}),
    [pipeline],
  );

  async function setMethod(method, enabled) {
    if (!config) return;
    setConfig({ ...config, methods: { ...config.methods, [method]: { ...(config.methods?.[method] || {}), enabled } } });
    try {
      await fetch('/api/strategy-lab/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methods: { [method]: { enabled } } }),
      });
      await refresh();
    } catch (err) { setError(err.message); }
  }

  async function activatePreset(id) {
    setBusy(true);
    try {
      const r = await fetch(`/api/strategy-lab/presets/${id}/activate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `API ${r.status}`);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function runTest() {
    setBusy(true);
    try {
      const r = await fetch('/api/strategy-lab/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market,
          symbols: symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
          date_from: dateFrom,
          date_to: dateTo,
          config,
          limit: 1200,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `API ${r.status}`);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function compareRuns() {
    const runIds = (results?.runs || []).slice(0, 2).map(r => r.id);
    if (runIds.length < 2) return;
    setBusy(true);
    try {
      await fetch('/api/strategy-lab/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds }),
      });
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const latest    = results?.latest;
  const runIds    = (results?.runs || []).slice(0, 2).map(r => r.id);

  // Bygg fullständig lista: kända vänliga presets + eventuella okända från API
  const allPresets = [...FRIENDLY_PRESETS];
  (presets || []).forEach(p => {
    if (!allPresets.find(fp => fp.id === p.id)) {
      allPresets.push({ id: p.id, name: p.label || p.id, desc: '' });
    }
  });

  const activePreset = allPresets.find(p => p.id === selectedPreset);

  // Färger för resultatkort
  const wr   = latest?.summary?.win_rate;
  const wrColor = wr == null ? undefined : wr >= 55 ? 'var(--green)' : wr >= 45 ? 'var(--yellow)' : 'var(--red)';
  const pl   = latest?.summary?.avg_pl_pct;
  const plColor = pl == null ? undefined : pl > 0 ? 'var(--green)' : 'var(--red)';
  const tpl  = latest?.summary?.total_pl_pct;
  const tplColor = tpl == null ? undefined : tpl >= 0 ? 'var(--green)' : 'var(--red)';
  const dd   = latest?.summary?.max_drawdown;
  const ddColor  = dd != null && dd > 10 ? 'var(--red)' : undefined;
  const to   = latest?.summary?.timeout_rate;
  const toColor  = to != null && to > 60 ? 'var(--yellow)' : undefined;

  // Beslutsvisning
  const decision = pipeline?.final_decision;
  const decisionColor = decision === 'ALLOW' ? 'var(--green)' : decision === 'BLOCK' ? 'var(--red)' : 'var(--yellow)';
  const decisionText  = decision === 'ALLOW' ? '✅ TILLÅTEN' : decision === 'BLOCK' ? '🚫 BLOCKERAD' : decision === 'OBSERVE' ? '⚠️ OBSERVERA' : '–';

  return (
    <div>
      {/* Hero */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Strategilabb</div>
          <div className="hero-sub">Testa olika sätt att handla med gammal data. Inga riktiga pengar används.</div>
        </div>
        <button className="btn" onClick={refresh} disabled={busy}>Uppdatera</button>
      </div>

      <SafetyBanner />

      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Preset + Hjälp */}
      <div className="sl-grid" style={{ gridTemplateColumns: '1fr 260px', gap: 16, alignItems: 'start', marginBottom: 16 }}>

        {/* Preset-panel */}
        <div className="sl-panel">
          <SectionHeader icon="🎯" title="Välj recept (preset)" desc="Preset = färdig strategi. Välj ett recept som startpunkt." />
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 12px', lineHeight: 1.6 }}>
            Preset betyder <strong>färdig strategi</strong> — som ett recept för testet.
            Du kan välja enkelt &amp; säkert, aggressivt, eller blanda ihop en egen strategi.
          </p>

          <label style={{ display: 'block', marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
              Välj recept
            </span>
            <select
              value={selectedPreset}
              onChange={e => { setSelectedPreset(e.target.value); activatePreset(e.target.value); }}
              disabled={busy}
              style={{ width: '100%' }}
            >
              {allPresets.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {activePreset && (
            <div style={{
              background: 'var(--bg)', border: '1px solid var(--card-border)',
              borderRadius: 8, padding: '10px 14px', fontSize: 13,
            }}>
              <strong style={{ display: 'block', marginBottom: 3 }}>{activePreset.name}</strong>
              {activePreset.desc && (
                <span style={{ color: 'var(--muted)' }}>{activePreset.desc}</span>
              )}
              {pipeline && (
                <div style={{ marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span>
                    Piplelinens svar:{' '}
                    <strong style={{ color: decisionColor }}>{decisionText}</strong>
                  </span>
                  <span style={{ color: 'var(--muted)' }}>Score: {pipeline.score ?? '–'}</span>
                  <span style={{ color: 'var(--muted)' }}>Konfidens: {pipeline.confidence ?? '–'}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <HelpBox />
      </div>

      {/* Byggklossar */}
      <div className="sl-panel" style={{ marginBottom: 16 }}>
        <SectionHeader icon="🧩" title="Dina byggklossar" desc="Slå av och på varje del för att testa olika kombinationer." />

        {/* Alltid-på steg */}
        <div style={{ marginTop: 10, marginBottom: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
            Dessa delar är alltid på och kan inte stängas av:
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['📡','Marknadsdata'], ['🔍','Scannern'], ['⚡','Signalmotor'], ['💼','Papertrade'], ['📋','Resultat']].map(([icon, name]) => (
              <span key={name} style={{
                background: 'var(--bg)', border: '1px solid var(--card-border)',
                borderRadius: 6, padding: '4px 10px', fontSize: 12, color: 'var(--muted)',
                display: 'inline-flex', gap: 5, alignItems: 'center',
              }}>
                {icon} {name}
              </span>
            ))}
          </div>
        </div>

        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          Klicka på <strong>▼ Vad gör detta?</strong> under varje ruta för att läsa mer.
        </p>

        {/* Byggkloss-grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(195px, 1fr))', gap: 10 }}>
          {TOGGLEABLE.map(key => (
            <MethodCard
              key={key}
              methodKey={key}
              enabled={config?.methods?.[key]?.enabled !== false}
              pipelineState={methodState[key]}
              onToggle={val => setMethod(key, val)}
            />
          ))}
        </div>
      </div>

      {/* Test + Resultat */}
      <div className="sl-grid" style={{ gap: 16, marginBottom: 16 }}>

        {/* Testpanel */}
        <div className="sl-panel">
          <SectionHeader icon="▶️" title="Kör testet" desc="Välj marknad och tid, sedan kör vi testet på gammal data." />
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 12px', lineHeight: 1.6 }}>
            Vi testar på gammal historisk data och simulerar låtsastrades.
            <strong style={{ color: 'var(--green)' }}> Inga riktiga pengar används.</strong>
          </p>
          <div className="sl-form">
            <label>
              Marknad
              <select
                value={market}
                onChange={e => { setMarket(e.target.value); setSymbols(MARKET_SYMBOLS[e.target.value] || symbols); }}
              >
                <option value="crypto">Krypto</option>
                <option value="stocks">Aktier</option>
                <option value="index">Index</option>
                <option value="etf">ETF</option>
                <option value="leveraged">Leveraged ETF</option>
              </select>
            </label>
            <label>
              Symboler
              <input
                value={symbols}
                onChange={e => setSymbols(e.target.value)}
                placeholder="t.ex. BTCUSDT,ETHUSDT"
              />
            </label>
            <label>
              Från datum
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </label>
            <label>
              Till datum
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </label>
            <button className="btn primary" onClick={runTest} disabled={busy}>
              {busy ? '⏳ Kör testet...' : '▶️ Kör testet'}
            </button>
          </div>
        </div>

        {/* Resultatkort */}
        <div className="sl-panel">
          <SectionHeader
            icon="📊"
            title="Testresultat"
            desc={latest?.id ? `Körning: ${latest.id}` : 'Kör testet för att se resultat här.'}
          />
          {latest ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <MetricCard
                label="Antal trades"
                value={latest.summary?.total_trades ?? 0}
                desc="Hur många låtsastrades testet tog."
              />
              <MetricCard
                label="Vinstprocent"
                value={fmtPct(wr)}
                desc="Hur ofta testet vann."
                color={wrColor}
              />
              <MetricCard
                label="Timeout"
                value={fmtPct(to)}
                desc="Hur ofta traden inte hann nå mål eller stop."
                color={toColor}
              />
              <MetricCard
                label="Snitt P/L"
                value={fmtPct(pl)}
                desc="Genomsnittlig vinst eller förlust per trade."
                color={plColor}
              />
              <MetricCard
                label="Total P/L"
                value={fmtPct(tpl)}
                desc="Totalt resultat för alla trades."
                color={tplColor}
              />
              <MetricCard
                label="Max nedgång"
                value={fmtPct(dd)}
                desc="Största nedgång under testet."
                color={ddColor}
              />
              <MetricCard
                label="Risk-blockeringar"
                value={latest.summary?.risk_blocks ?? 0}
                desc="Trades som stoppades av riskmotorn."
              />
              <MetricCard
                label="Safety-blockeringar"
                value={latest.summary?.safety_blocks ?? 0}
                desc="Trades som stoppades av säkerhetsmotorn."
              />
              <MetricCard
                label="Exit-förbättringar"
                value={latest.summary?.exit_improvements ?? 0}
                desc="Trades där exitmotorn förbättrade resultatet."
              />
            </div>
          ) : (
            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 16, textAlign: 'center', padding: '24px 0' }}>
              Kör testet för att se resultat här. 👆
            </div>
          )}
        </div>
      </div>

      {/* Det som fungerade bäst / sämst */}
      <div className="sl-grid" style={{ gap: 16, marginBottom: 16 }}>
        <div className="sl-panel">
          <SectionHeader icon="⭐" title="Det som fungerade bäst" />
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 10px', lineHeight: 1.5 }}>
            Dessa delar hjälpte resultatet mest. Högre siffra = mer hjälp.
          </p>
          <div className="sl-list">
            {(latest?.summary?.best_methods || []).length ? (
              (latest.summary.best_methods).map(m => (
                <div className="sl-list-row" key={m.method}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span>{METHOD_INFO[m.method]?.icon || '⚙️'}</span>
                    <span>{METHOD_INFO[m.method]?.name || m.method}</span>
                  </span>
                  <strong style={{ color: 'var(--green)' }}>{fmtSigned(m.avg_score_delta)}</strong>
                </div>
              ))
            ) : (
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>Kör testet för att se.</span>
            )}
          </div>
        </div>

        <div className="sl-panel">
          <SectionHeader icon="⚠️" title="Det som fungerade sämst" />
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 10px', lineHeight: 1.5 }}>
            Dessa delar skadade resultatet mest. Lägre siffra = mer skada.
          </p>
          <div className="sl-list">
            {(latest?.summary?.worst_methods || []).length ? (
              (latest.summary.worst_methods).map(m => (
                <div className="sl-list-row" key={m.method}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span>{METHOD_INFO[m.method]?.icon || '⚙️'}</span>
                    <span>{METHOD_INFO[m.method]?.name || m.method}</span>
                  </span>
                  <strong style={{ color: 'var(--red)' }}>{fmtSigned(m.avg_score_delta)}</strong>
                </div>
              ))
            ) : (
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>Kör testet för att se.</span>
            )}
          </div>
        </div>
      </div>

      {/* TradingAgents Result Memory — visas när TradingAgents är ON */}
      {config?.methods?.trading_agents?.enabled !== false && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, marginTop: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--muted)' }}>Symbol att granska:</label>
            <input
              value={agentMemorySymbol}
              onChange={(e) => setAgentMemorySymbol(e.target.value.toUpperCase())}
              placeholder="t.ex. BTCUSDT"
              style={{ width: 140 }}
            />
          </div>
          <AgentMemoryPanel symbol={agentMemorySymbol} />
        </div>
      )}

      {/* Jämför strategier */}
      <div className="sl-panel">
        <SectionHeader icon="⚖️" title="Jämför strategier" desc="Jämför två recept och se vilken som gick bäst." />
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 12px', lineHeight: 1.6 }}>
          Kör testet minst <strong>två gånger</strong> med olika inställningar — sedan jämför vi dem och visar vilket recept som vann.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={compareRuns} disabled={busy || runIds.length < 2}>
            ⚖️ Jämför
          </button>
          {runIds.length < 2 && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Kör minst 2 tester för att kunna jämföra.
            </span>
          )}
        </div>
        {results?.compare?.recommendation && (
          <div style={{
            marginTop: 12, padding: '10px 14px',
            background: 'var(--bg)', borderRadius: 8, fontSize: 13,
          }}>
            <strong>Jämförelseresultat:</strong>{' '}
            {results.compare.recommendation.message}
          </div>
        )}
      </div>
    </div>
  );
}
