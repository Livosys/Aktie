import React, { useEffect, useState, useMemo } from 'react';
import { useScan } from '../hooks.js';
import {
  SummaryStrip, SectionHeader, SymbolCardList, BestCardV2,
  GuideBoxV2, PageStatusBarV2, TopSignalsPanel,
  DecisionHeroCard, Top5SignalsSection, DecisionFilterBar,
  SymbolGroupCard, tvLink,
} from '../shared.jsx';
import { useAlerts } from '../alertContext.jsx';
import { enrichWithDecisions, isAvoidSignal, getBestSignal, getTopN, groupBySymbol } from '../decisionEngine.js';

export default function StocksPage() {
  const { data, health, loading, error, lastFetch, refresh } = useScan('/api/scan/stocks');
  const { processResults } = useAlerts();
  const [learning, setLearning]     = useState(null);
  const [sigFilters, setSigFilters] = useState({ mode: 'all', hideChoppy: false, grouped: false, hideDuplicates: false });

  // Fetch learning summary once on mount — enriches decision data
  useEffect(() => {
    fetch('/api/history/learning-summary')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.summary) setLearning(j.summary); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (data?.results) processResults(data.results, 'stocks');
  }, [data?.results, processResults]);

  const results = data?.results || [];

  // Enrich all signals with decision data
  const enriched = useMemo(() => enrichWithDecisions(results, learning), [results, learning]);

  // Best signal + Top 5 (always from full enriched set, ignoring view filters)
  const bestSignal = useMemo(() => getBestSignal(enriched), [enriched]);
  const top5       = useMemo(() => getTopN(enriched, 5), [enriched]);

  // Apply view filters
  const filtered = useMemo(() => {
    let rs = enriched;
    if (sigFilters.hideChoppy) rs = rs.filter(r => r.marketRegime !== 'CHOPPY');
    switch (sigFilters.mode) {
      case 'best':      rs = rs.filter(r => (r._decision?.signalScore ?? r.tradeScore ?? 0) >= 60); break;
      case 'long':      rs = rs.filter(r => r.signal?.startsWith('LONG'));  break;
      case 'short':     rs = rs.filter(r => r.signal?.startsWith('SHORT')); break;
      case 'validated': rs = rs.filter(r => (r._decision?.similarSignalCount ?? 0) >= 20); break;
      case 'bullish':   rs = rs.filter(r => ['BULLISH_TREND', 'TREND_DAY_UP'].includes(r.marketRegime)); break;
      case 'bearish':   rs = rs.filter(r => ['BEARISH_TREND', 'TREND_DAY_DOWN'].includes(r.marketRegime)); break;
      case 'choppy':    rs = rs.filter(r => ['CHOPPY', 'HIGH_VOLATILITY', 'RANGE_DAY'].includes(r.marketRegime)); break;
      case 'highConf':  rs = rs.filter(r => r._decision?.confidenceLevel === 'HIGH'); break;
      default: break;
    }
    if (sigFilters.hideDuplicates) {
      const sorted = [...rs].sort((a, b) => (b._decision?.signalScore ?? b.tradeScore ?? 0) - (a._decision?.signalScore ?? a.tradeScore ?? 0));
      const seen = new Set();
      rs = sorted.filter(r => { if (seen.has(r.symbol)) return false; seen.add(r.symbol); return true; });
    }
    return rs;
  }, [enriched, sigFilters]);

  const byDecScore = (a, b) =>
    (b._decision?.signalScore ?? b.tradeScore ?? 0) -
    (a._decision?.signalScore ?? a.tradeScore ?? 0);

  const isAvoid = r => isAvoidSignal(r);
  const isActive = r => !isAvoid(r);

  const best  = [...filtered].filter(r => isActive(r) && (r._decision?.signalScore ?? r.tradeScore ?? 0) >= 60).sort(byDecScore).slice(0, 3);
  const near  = [...filtered].filter(r => isActive(r) && (r._decision?.signalScore ?? r.tradeScore ?? 0) >= 30 && (r._decision?.signalScore ?? r.tradeScore ?? 0) < 60).sort(byDecScore);
  const wait  = [...filtered].filter(r => isActive(r) && (r._decision?.signalScore ?? r.tradeScore ?? 0) < 30).sort(byDecScore);
  const avoid = filtered.filter(isAvoid);

  // Symbol groups
  const symbolGroups = useMemo(() => {
    if (!sigFilters.grouped) return null;
    return groupBySymbol(filtered);
  }, [filtered, sigFilters.grouped]);

  return (
    <div>
      {/* Hero */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Aktie Scanner</div>
          <div className="hero-sub">
            Vi letar efter aktier som är redo att röra sig.{' '}
            <strong>NVDA · AMD · TSLA · AAPL · MSFT · AMZN · META</strong>
          </div>
        </div>
        <PageStatusBarV2 health={health} data={data} lastFetch={lastFetch} onRefresh={refresh} />
      </div>

      {/* Banners */}
      {data?.marketWarning && (
        <div className="market-banner">⚠ Marknaden kan vara stängd – visar senast tillgänglig data.</div>
      )}
      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Fel: {error}
        </div>
      )}

      {loading && <div className="empty"><span className="spinner" /> Hämtar aktier…</div>}

      {!loading && (
        <>
          <SummaryStrip results={results} />
          <TopSignalsPanel results={enriched} />

          {/* ── Filter bar ─────────────────────────────────────────────────── */}
          <DecisionFilterBar filters={sigFilters} onChange={setSigFilters} />

          <GuideBoxV2 />

          {/* ── Bästa signal just nu ──────────────────────────────────────── */}
          <div className="sec">
            <SectionHeader
              icon="🏆"
              title="Bästa signal just nu"
              desc={bestSignal
                ? 'Signalen med högst poäng baserat på betyg och historisk data.'
                : 'Motorn väntar på ett tydligare läge.'}
            />
            {bestSignal ? (
              <DecisionHeroCard r={bestSignal} tvLinkFn={tvLink} />
            ) : (
              <div className="hero-empty">
                <div className="hero-empty-icon">🏆</div>
                <div className="hero-empty-text">
                  <strong>Ingen stark signal just nu</strong>
                  Motorn väntar på bättre läge. Kom tillbaka när marknaden rör sig.
                </div>
              </div>
            )}
          </div>

          {/* ── Topp 5 signaler ───────────────────────────────────────────── */}
          {top5.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="🔝"
                title="Topp 5 signaler"
                count={top5.length}
                desc="De fem starkaste aktiva signalerna — rankade efter poäng och historisk data."
              />
              <Top5SignalsSection signals={top5} tvLinkFn={tvLink} />
            </div>
          )}

          {/* ── Grupperat per symbol ──────────────────────────────────────── */}
          {sigFilters.grouped && symbolGroups && (
            <div className="sec">
              <SectionHeader
                icon="📦"
                title="Grupperade per symbol"
                count={Object.keys(symbolGroups).length}
                desc="Varje symbol visas som ett kort med alla signaler och historisk sammanfattning."
              />
              <div className="sym-groups-grid">
                {Object.entries(symbolGroups).map(([sym, group]) => (
                  <SymbolGroupCard
                    key={sym}
                    symbol={sym}
                    group={group}
                    learning={learning}
                    tvLinkFn={tvLink}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Starka setup (60+) ────────────────────────────────────────── */}
          {!sigFilters.grouped && (
            <div className="sec">
              <SectionHeader
                icon="⚡"
                title="Starka setup"
                count={best.length > 0 ? best.length : null}
                desc={best.length > 0 ? 'Betyg 60+. Setup + timing är bra.' : null}
              />
              {best.length === 0 ? (
                <div className="hero-empty">
                  <div className="hero-empty-icon">⚡</div>
                  <div className="hero-empty-text">
                    <strong>Inga starka setup just nu</strong>
                    Motorn väntar på bättre läge.
                  </div>
                </div>
              ) : (
                <div className="best-grid">
                  {best.map((r, i) => <BestCardV2 key={r.symbol} r={r} rank={i + 1} />)}
                </div>
              )}
            </div>
          )}

          {/* ── Nära setup ────────────────────────────────────────────────── */}
          {!sigFilters.grouped && near.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="🎯"
                title="Nära setup – vänta på bättre entry"
                count={near.length}
                desc="Intressanta aktier, men vänta på ett bättre tillfälle att gå in."
              />
              <SymbolCardList rows={near} />
            </div>
          )}

          {/* ── Trend men vänta ───────────────────────────────────────────── */}
          {!sigFilters.grouped && wait.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="⏳"
                title="Trend – men vänta"
                count={wait.length}
                desc="Trenden finns, men priset är inte på rätt plats just nu."
              />
              <SymbolCardList rows={wait} />
            </div>
          )}

          {/* ── Undvik ────────────────────────────────────────────────────── */}
          {!sigFilters.grouped && avoid.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="⛔"
                title="Undvik / jaga inte"
                count={avoid.length}
                desc="Motorn eller reglerna blockerar dessa lägen."
              />
              <SymbolCardList rows={avoid} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
