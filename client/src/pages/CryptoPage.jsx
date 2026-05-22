import React, { useState, useEffect, useCallback } from 'react';
import {
  SummaryStrip, SectionHeader, SymbolCardList, BestCardV2, HeroSignalCard,
  GuideBoxV2, cryptoTvLink, fmtTime, TopSignalsPanel, LiveFilterBar,
} from '../shared.jsx';
import { useAlerts } from '../alertContext.jsx';

const REFRESH_MS = 15_000;

function useCryptoScan() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/crypto');
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchData]);

  return { data, loading, error, lastFetch, refresh: fetchData };
}

export default function CryptoPage() {
  const { data, loading, error, lastFetch, refresh } = useCryptoScan();
  const { processResults } = useAlerts();
  const [filters, setFilters] = useState({ direction: null, minScore: 0, hideAvoid: false });

  useEffect(() => {
    if (data?.results) processResults(data.results, 'crypto');
  }, [data?.results, processResults]);

  const results = data?.results || [];

  const isAvoid = (r) =>
    ['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'NO_TRADE', 'BREAKOUT_ALREADY_OCCURRED'].includes(r.state) ||
    r.threeFingerSpread?.active || r.breakoutAlreadyOccurred || r.autoFilter?.blocked;
  const isActive = (r) => !isAvoid(r);
  const byScore  = (a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0);

  function applyFilters(rows) {
    return rows.filter(r => {
      if (filters.direction === 'long'  && !r.signal?.startsWith('LONG'))  return false;
      if (filters.direction === 'short' && !r.signal?.startsWith('SHORT')) return false;
      if (filters.minScore > 0 && (r.tradeScore ?? 0) < filters.minScore)   return false;
      if (filters.hideAvoid && isAvoid(r)) return false;
      return true;
    });
  }

  const best  = applyFilters([...results].filter(r => isActive(r) && (r.tradeScore ?? 0) >= 60).sort(byScore).slice(0, 3));
  const near  = applyFilters([...results].filter(r => isActive(r) && (r.tradeScore ?? 0) >= 30 && (r.tradeScore ?? 0) < 60).sort(byScore));
  const wait  = applyFilters([...results].filter(r => isActive(r) && (r.tradeScore ?? 0) < 30).sort(byScore));
  const avoid = filters.hideAvoid ? [] : applyFilters(results.filter(isAvoid));

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-orange">Krypto Scanner</div>
          <div className="hero-sub">
            Kör 24/7 via Binance.{' '}
            <strong>BTC · ETH · SOL</strong> — vi kollar om priset är redo att röra sig.
          </div>
        </div>
        <div className="status-bar-v2">
          <span className="status-pill s-ok"><span className="dot" />Binance live</span>
          <span className="status-pill" style={{ color: 'var(--orange)' }}>🔄 24/7</span>
          {data?.lastScan && (
            <span className="status-pill">⏱ {fmtTime(data.lastScan)}</span>
          )}
          <button className="btn" onClick={refresh} style={{ fontSize: 11, padding: '3px 10px' }}>↻ Uppdatera</button>
        </div>
      </div>

      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Fel: {error}
        </div>
      )}

      {loading && <div className="empty"><span className="spinner" /> Hämtar krypto från Binance…</div>}

      {!loading && (
        <>
          <SummaryStrip results={results} />
          <TopSignalsPanel results={results} tvLinkFn={cryptoTvLink} />
          <LiveFilterBar filters={filters} onChange={setFilters} />
          <GuideBoxV2 />

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
                <HeroSignalCard r={best[0]} tvLinkFn={cryptoTvLink} />
                {best.slice(1).length > 0 && (
                  <>
                    <div className="hero-secondary-title">Fler starka lägen</div>
                    <div className="best-grid">
                      {best.slice(1).map((r, i) => <BestCardV2 key={r.symbol} r={r} rank={i + 2} tvLinkFn={cryptoTvLink} />)}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {near.length > 0 && (
            <div className="sec">
              <SectionHeader icon="🎯" title="Nära setup – vänta på bättre entry" count={near.length}
                desc="Intressant, men vänta på ett bättre tillfälle att gå in." />
              <SymbolCardList rows={near} tvLinkFn={cryptoTvLink} />
            </div>
          )}

          {wait.length > 0 && (
            <div className="sec">
              <SectionHeader icon="⏳" title="Trend – men vänta" count={wait.length}
                desc="Priset rör sig, men inte på rätt ställe ännu. Kom tillbaka senare." />
              <SymbolCardList rows={wait} tvLinkFn={cryptoTvLink} />
            </div>
          )}

          {avoid.length > 0 && (
            <div className="sec">
              <SectionHeader icon="⛔" title="Undvik / jaga inte" count={avoid.length}
                desc="Motorn eller reglerna blockerar dessa lägen." />
              <SymbolCardList rows={avoid} tvLinkFn={cryptoTvLink} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
