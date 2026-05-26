import React, { useState, useEffect, useCallback } from 'react';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v, d = 1) {
  if (v === null || v === undefined) return '–';
  return `${(Number(v) * 100).toFixed(d)}%`;
}

function round(v, d = 1) {
  if (v === null || v === undefined) return '–';
  return Number(v).toFixed(d);
}

function rateColor(v) {
  if (v === null || v === undefined) return 'var(--muted)';
  const n = Number(v);
  if (n >= 0.5)  return 'var(--green)';
  if (n >= 0.35) return 'var(--orange)';
  return 'var(--red)';
}

const REGIME_SV = {
  BULLISH_TREND:   'Stark upptrend',   BEARISH_TREND:  'Stark nedtrend',
  CHOPPY:          'Stökig marknad',   RANGE_DAY:      'Sidledsdag',
  TREND_DAY_UP:    'Trenddag uppåt',   TREND_DAY_DOWN: 'Trenddag nedåt',
  HIGH_VOLATILITY: 'Hög volatilitet',  PANIC:          'Panik',
  UNKNOWN:         'Okänt',
};

const BLOCK_REASON_SV = {
  tfs:          'Three Finger Spread',
  weakVolume:   'Svag volym',
  farFromZone:  'För långt från zon',
  veryLowScore: 'Extremt låg score',
  lowScore:     'Låg score',
};

function regimeBadgeCls(regime) {
  if (!regime) return 'badge-gray';
  if (regime.includes('BULL'))     return 'badge-green';
  if (regime.includes('BEAR'))     return 'badge-red';
  if (regime.includes('TREND_D')) return 'badge-blue';
  if (regime.includes('CHOPPY'))   return 'badge-yellow';
  if (regime.includes('PANIC'))    return 'badge-red';
  if (regime.includes('HIGH_VOL')) return 'badge-orange';
  return 'badge-gray';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ title, value, sub, color }) {
  return (
    <div className="mm-stat-card">
      <div className="mm-stat-title">{title}</div>
      <div className="mm-stat-value" style={{ color: color || 'var(--text)' }}>{value}</div>
      {sub && <div className="mm-stat-sub">{sub}</div>}
    </div>
  );
}

function SectionHeader({ icon, title, sub }) {
  return (
    <div className="mm-section-header">
      <span className="mm-section-icon">{icon}</span>
      <div>
        <div className="mm-section-title">{title}</div>
        {sub && <div className="mm-section-sub">{sub}</div>}
      </div>
    </div>
  );
}

function CategoryCompare({ byCategory }) {
  if (!byCategory) return null;
  const cats = [
    { key: 'READY',            icon: '✅', color: 'var(--green)' },
    { key: 'WEAK',             icon: '⚠️', color: 'var(--orange)' },
    { key: 'BLOCKED',          icon: '🚫', color: 'var(--red)' },
    { key: 'MICRO_MOVE_READY', icon: '⚡', color: '#a78bfa' },
  ];
  return (
    <div className="mm-cat-grid">
      {cats.map(({ key, icon, color }) => {
        const cat = byCategory[key];
        if (!cat) return null;
        return (
          <div key={key} className="mm-cat-card">
            <div className="mm-cat-header" style={{ color }}>
              <span>{icon}</span>
              <span className="mm-cat-label">{cat.label || key}</span>
            </div>
            <div className="mm-cat-row">
              <span className="mm-cat-k">Träffar</span>
              <span className="mm-cat-v">{cat.samples?.toLocaleString('sv') ?? '–'}</span>
            </div>
            <div className="mm-cat-row">
              <span className="mm-cat-k">+0.25% WR</span>
              <span className="mm-cat-v" style={{ color: rateColor(cat.hit025Rate) }}>
                {pct(cat.hit025Rate)}
              </span>
            </div>
            <div className="mm-cat-row">
              <span className="mm-cat-k">+0.50% WR</span>
              <span className="mm-cat-v" style={{ color: rateColor(cat.hit050Rate) }}>
                {pct(cat.hit050Rate)}
              </span>
            </div>
            <div className="mm-cat-row">
              <span className="mm-cat-k">Avg tid 025</span>
              <span className="mm-cat-v">{cat.avgTime025 != null ? `${round(cat.avgTime025)} min` : '–'}</span>
            </div>
            <div className="mm-cat-row">
              <span className="mm-cat-k">Avg adverse</span>
              <span className="mm-cat-v" style={{ color: 'var(--red)' }}>
                {cat.avgAdverse != null ? `${round(cat.avgAdverse, 2)}%` : '–'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventTypeTable({ rows, limit = 15 }) {
  const [showAll, setShowAll] = useState(false);
  if (!rows || rows.length === 0) return <p className="mm-empty">Ingen data ännu.</p>;
  const visible = showAll ? rows : rows.slice(0, limit);
  return (
    <div className="mm-table-wrap">
      <table className="mm-table">
        <thead>
          <tr>
            <th>Event-typ</th>
            <th>Bl. träffar</th>
            <th>+0.25% (bl.)</th>
            <th>+0.50% (bl.)</th>
            <th>Tid 025</th>
            <th>Alla +0.25%</th>
            <th>Micro?</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((e) => (
            <tr key={e.eventType} className={e.microMoveReady ? 'mm-row-ready' : ''}>
              <td className="mm-td-evt">{e.eventType}</td>
              <td>{e.blockedSamples?.toLocaleString('sv') ?? '–'}</td>
              <td style={{ color: rateColor(e.blockedHit025Rate), fontWeight: 700 }}>{pct(e.blockedHit025Rate)}</td>
              <td style={{ color: rateColor(e.blockedHit050Rate) }}>{pct(e.blockedHit050Rate)}</td>
              <td>{e.blockedAvgTime025 != null ? `${round(e.blockedAvgTime025)} min` : '–'}</td>
              <td style={{ color: rateColor(e.allHit025Rate) }}>{pct(e.allHit025Rate)}</td>
              <td>{e.microMoveReady ? <span className="badge badge-purple">⚡ READY</span> : <span className="badge badge-gray">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="mm-show-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Visa färre' : `Visa alla ${rows.length} event-typer`}
        </button>
      )}
    </div>
  );
}

function BlockReasonTable({ rows }) {
  if (!rows || rows.length === 0) return <p className="mm-empty">Ingen data.</p>;
  return (
    <div className="mm-table-wrap">
      <table className="mm-table">
        <thead>
          <tr>
            <th>Blocker-regel</th>
            <th>Träffar</th>
            <th>+0.25% WR</th>
            <th>+0.50% WR</th>
            <th>Avg tid</th>
            <th>Adverse</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.reason}>
              <td>{BLOCK_REASON_SV[r.reason] || r.reason}</td>
              <td>{r.samples?.toLocaleString('sv') ?? '–'}</td>
              <td style={{ color: rateColor(r.hit025Rate), fontWeight: 700 }}>{pct(r.hit025Rate)}</td>
              <td style={{ color: rateColor(r.hit050Rate) }}>{pct(r.hit050Rate)}</td>
              <td>{r.avgTime025 != null ? `${round(r.avgTime025)} min` : '–'}</td>
              <td style={{ color: 'var(--red)' }}>{r.avgAdverse != null ? `${round(r.avgAdverse, 2)}%` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegimeTable({ rows, limit = 10 }) {
  if (!rows || rows.length === 0) return <p className="mm-empty">Ingen data.</p>;
  return (
    <div className="mm-table-wrap">
      <table className="mm-table">
        <thead>
          <tr>
            <th>Marknadsläge</th>
            <th>Träffar</th>
            <th>+0.25% WR</th>
            <th>+0.50% WR</th>
            <th>Adverse</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => (
            <tr key={r.regime}>
              <td>
                <span className={`badge ${regimeBadgeCls(r.regime)}`}>
                  {REGIME_SV[r.regime] || r.regime}
                </span>
              </td>
              <td>{r.samples?.toLocaleString('sv') ?? '–'}</td>
              <td style={{ color: rateColor(r.hit025Rate), fontWeight: 700 }}>{pct(r.hit025Rate)}</td>
              <td style={{ color: rateColor(r.hit050Rate) }}>{pct(r.hit050Rate)}</td>
              <td style={{ color: 'var(--red)' }}>{r.avgAdverse != null ? `${round(r.avgAdverse, 2)}%` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FastScalpList({ items }) {
  if (!items || items.length === 0) return <p className="mm-empty">Inga snabba scalp-möjligheter identifierade.</p>;
  return (
    <div className="mm-scalp-list">
      {items.map((item) => (
        <div key={item.eventType} className="mm-scalp-card">
          <div className="mm-scalp-name">{item.eventType}</div>
          <div className="mm-scalp-stats">
            <span className="mm-scalp-stat">
              <span className="mm-scalp-k">+0.25% WR</span>
              <span className="mm-scalp-v" style={{ color: rateColor(item.hit025Rate) }}>
                {pct(item.hit025Rate)}
              </span>
            </span>
            <span className="mm-scalp-stat">
              <span className="mm-scalp-k">+0.50% WR</span>
              <span className="mm-scalp-v" style={{ color: rateColor(item.hit050Rate) }}>
                {pct(item.hit050Rate)}
              </span>
            </span>
            <span className="mm-scalp-stat">
              <span className="mm-scalp-k">Avg tid</span>
              <span className="mm-scalp-v">{item.avgMin025 != null ? `${round(item.avgMin025)} min` : '–'}</span>
            </span>
            <span className="mm-scalp-stat">
              <span className="mm-scalp-k">Träffar</span>
              <span className="mm-scalp-v">{item.samples}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReadyEventTypes({ eventTypes }) {
  if (!eventTypes || eventTypes.length === 0) {
    return <p className="mm-empty">Inga MICRO_MOVE_READY event-typer identifierade ännu.</p>;
  }
  return (
    <div className="mm-ready-tags">
      {eventTypes.map((et) => (
        <span key={et} className="badge badge-purple mm-ready-tag">⚡ {et}</span>
      ))}
    </div>
  );
}

function Recommendations({ recs }) {
  if (!recs || recs.length === 0) return null;
  return (
    <div className="mm-recs">
      {recs.map((r, i) => (
        <div key={i} className="mm-rec">
          <span className="mm-rec-icon">💡</span>
          <span>{r}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MicroMovePage() {
  const [report, setReport]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async (build = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = build
        ? '/api/history/micro-move-analysis?build=true'
        : '/api/history/micro-move-analysis';
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Okänt fel');
      setReport(data.report);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setBuilding(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const handleBuild = () => { setBuilding(true); load(true); };

  const r = report;

  return (
    <div className="page-wrap">
      <div className="page-hero">
        <h1 className="page-title">
          <span style={{ marginRight: '0.4em' }}>⚡</span>
          Micro Move Intelligence
        </h1>
        <p className="page-sub">
          Analyserar blockerade signaler som ändå når +0.25% och +0.50%.
          Identifierar snabba scalp-möjligheter och för aggressiva blocker-regler.
        </p>
        <div className="mm-build-row">
          <button
            className="mm-build-btn"
            onClick={handleBuild}
            disabled={loading || building}
          >
            {building ? '⏳ Bygger...' : '🔄 Bygg / Uppdatera analys'}
          </button>
          {r && (
            <span className="mm-generated">
              Senast: {new Date(r.generatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}
              {' · '}{r.source?.joined?.toLocaleString('sv') ?? '?'} signaler analyserade
            </span>
          )}
        </div>
      </div>

      {loading && !building && <div className="mm-loading">Laddar analys...</div>}
      {error    && <div className="mm-error">Fel: {error}</div>}

      {!loading && !r && !error && (
        <div className="mm-no-data">
          <p>Ingen analys ännu. Klicka "Bygg / Uppdatera analys" eller kör Auto Machine.</p>
        </div>
      )}

      {r && (
        <div className="mm-content">

          {/* ── Recommendations ─────────────────────────────────────────── */}
          {r.recommendations?.length > 0 && (
            <section className="mm-section">
              <SectionHeader icon="💡" title="Slutsatser" sub="Vad analysen lärde sig" />
              <Recommendations recs={r.recommendations} />
            </section>
          )}

          {/* ── KPI Overview ─────────────────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader icon="📊" title="Översikt" sub={`Senaste ${r.days} dagar`} />
            <div className="mm-stats-row">
              <StatCard
                title="Totalt signaler"
                value={r.global?.samples?.toLocaleString('sv') ?? '–'}
                sub="Analyserade"
                color="var(--text)"
              />
              <StatCard
                title="Alla → +0.25%"
                value={pct(r.global?.hit025Rate)}
                sub={`${r.global?.hit025Count?.toLocaleString('sv') ?? '?'} signaler`}
                color={rateColor(r.global?.hit025Rate)}
              />
              <StatCard
                title="Alla → +0.50%"
                value={pct(r.global?.hit050Rate)}
                sub={`${r.global?.hit050Count?.toLocaleString('sv') ?? '?'} signaler`}
                color={rateColor(r.global?.hit050Rate)}
              />
              <StatCard
                title="Blockerade totalt"
                value={r.blockedProfitable?.totalBlocked?.toLocaleString('sv') ?? '–'}
                sub="Score ≤20"
                color="var(--muted)"
              />
              <StatCard
                title="Blockerade → +0.25%"
                value={pct(r.blockedProfitable?.hit025Rate)}
                sub={`${r.blockedProfitable?.missedOpportunities025?.toLocaleString('sv') ?? '?'} missade`}
                color={rateColor(r.blockedProfitable?.hit025Rate)}
              />
              <StatCard
                title="Micro Move Ready"
                value={r.readyEventTypes?.length ?? 0}
                sub="Event-typer identifierade"
                color="#a78bfa"
              />
            </div>
          </section>

          {/* ── Category Comparison ───────────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="⚖️"
              title="READY vs BLOCKED vs MICRO_MOVE_READY"
              sub="Jämförelse av signaltyper och deras micro-move prestanda"
            />
            <CategoryCompare byCategory={r.byCategory} />
          </section>

          {/* ── MICRO_MOVE_READY event types ──────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="⚡"
              title="MICRO_MOVE_READY Event-typer"
              sub={`Event-typer med ≥40% träff på +0.25% trots blockering (min 20 träffar)`}
            />
            <ReadyEventTypes eventTypes={r.readyEventTypes} />
          </section>

          {/* ── Fast scalp opportunities ──────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="🎯"
              title="Snabba Scalp-möjligheter"
              sub="Blockerade signaler med hög 0.25%-träff OCH snabb genomsnittstid"
            />
            <FastScalpList items={r.fastScalpOpportunities} />
          </section>

          {/* ── Event type breakdown ──────────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="📋"
              title="Event-typ Breakdown"
              sub="Sorterat efter blockerad +0.25% träffprocent"
            />
            <EventTypeTable rows={r.byEventType} />
          </section>

          {/* ── Block reason analysis ─────────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="🚫"
              title="Blocker-regel Analys"
              sub="Vilka regler stoppar signaler som ändå fungerar?"
            />
            <BlockReasonTable rows={r.byBlockReason} />
          </section>

          {/* ── Market regime breakdown ───────────────────────────────────── */}
          <section className="mm-section">
            <SectionHeader
              icon="🌐"
              title="Marknadsläge Breakdown"
              sub="Micro-move träffprocent per marknadsläge"
            />
            <RegimeTable rows={r.byRegime} />
          </section>

          {/* ── Criteria info ────────────────────────────────────────────── */}
          {r.microMoveReadyCriteria && (
            <section className="mm-section mm-section-sm">
              <SectionHeader icon="⚙️" title="MICRO_MOVE_READY Kriterier" />
              <div className="mm-criteria">
                <span>Score-spann: <strong>{r.microMoveReadyCriteria.scoreRange?.[0]}–{r.microMoveReadyCriteria.scoreRange?.[1]}</strong></span>
                <span>Min +0.25% rate: <strong>{pct(r.microMoveReadyCriteria.minHit025Rate)}</strong></span>
                <span>Min träffar: <strong>{r.microMoveReadyCriteria.minSamples}</strong></span>
                <span>Kräver: <strong>Ingen TFS</strong></span>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
