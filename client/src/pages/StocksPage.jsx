import React, { useEffect } from 'react';
import { useScan } from '../hooks.js';
import {
  SummaryStrip,
  SectionHeader,
  SymbolCardList,
  BestCardV2,
  HeroSignalCard,
  GuideBoxV2,
  PageStatusBarV2,
} from '../shared.jsx';
import { useAlerts } from '../alertContext.jsx';

export default function StocksPage() {
  const { data, health, loading, error, lastFetch, refresh } = useScan('/api/scan/stocks');
  const { processResults } = useAlerts();

  useEffect(() => {
    if (data?.results) processResults(data.results, 'stocks');
  }, [data?.results, processResults]);

  const results = data?.results || [];

  const isAvoid = (r) =>
    ['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'NO_TRADE', 'BREAKOUT_ALREADY_OCCURRED'].includes(r.state) ||
    r.threeFingerSpread?.active || r.breakoutAlreadyOccurred || r.autoFilter?.blocked;
  const isActive = (r) => !isAvoid(r);
  const byScore  = (a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0);

  const best  = [...results].filter(r => isActive(r) && (r.tradeScore ?? 0) >= 60).sort(byScore).slice(0, 3);
  const near  = [...results].filter(r => isActive(r) && (r.tradeScore ?? 0) >= 30 && (r.tradeScore ?? 0) < 60).sort(byScore);
  const wait  = [...results].filter(r => isActive(r) && (r.tradeScore ?? 0) < 30).sort(byScore);
  const avoid = results.filter(isAvoid);

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
          <GuideBoxV2 />

          {/* Starkaste signalen */}
          <div className="sec">
            <SectionHeader
              icon="⚡"
              title="Starkaste signalen just nu"
              count={best.length > 0 ? best.length : null}
              desc={best.length > 0 ? 'Motorn har hittat ett starkt läge. Setup + timing är bra.' : null}
            />
            {best.length === 0 ? (
              <div className="hero-empty">
                <div className="hero-empty-icon">⚡</div>
                <div className="hero-empty-text">
                  <strong>Ingen stark signal just nu</strong>
                  Motorn väntar på bättre läge. Kom tillbaka när marknaden rör sig.
                </div>
              </div>
            ) : (
              <>
                <HeroSignalCard r={best[0]} />
                {best.slice(1).length > 0 && (
                  <>
                    <div className="hero-secondary-title">Fler starka lägen</div>
                    <div className="best-grid">
                      {best.slice(1).map((r, i) => <BestCardV2 key={r.symbol} r={r} rank={i + 2} />)}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Nära setup */}
          {near.length > 0 && (
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

          {/* Trend men vänta */}
          {wait.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="⏳"
                title="Trend – men vänta"
                count={wait.length}
                desc="Trenden finns, men priset är inte på rätt plats just nu. Kom tillbaka senare."
              />
              <SymbolCardList rows={wait} />
            </div>
          )}

          {/* Undvik */}
          {avoid.length > 0 && (
            <div className="sec">
              <SectionHeader
                icon="⛔"
                title="Undvik / jaga inte"
                count={avoid.length}
                desc="Motorn eller reglerna blockerar dessa lägen. Priset är för långt ifrån, rörelsen har redan börjat, eller risken är för hög."
              />
              <SymbolCardList rows={avoid} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
