import React, { useEffect } from 'react';
import { useScan } from '../hooks.js';
import {
  SectionHeader,
  BestCardV2,
  QQQPremiumCard,
  GuideBoxV2,
  PageStatusBarV2,
} from '../shared.jsx';
import { useAlerts } from '../alertContext.jsx';

export default function NasdaqPage() {
  const { data, health, loading, error, lastFetch, refresh } = useScan('/api/scan/nasdaq');
  const { processResults } = useAlerts();

  useEffect(() => {
    if (data?.results) processResults(data.results, 'nasdaq');
  }, [data?.results, processResults]);

  const results = data?.results || [];
  const qqqData = results.find(r => r.symbol === 'QQQ') ?? null;

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-yellow">NASDAQ-100 Scanner</div>
          <div className="hero-sub">
            Marknadsläge via <strong>QQQ (Nasdaq-100 Proxy)</strong> — Invesco QQQ ETF följer de 100 största Nasdaq-bolagen med korrelation ≥0.99 mot NDX.
          </div>
        </div>
        <PageStatusBarV2 health={health} data={data} lastFetch={lastFetch} onRefresh={refresh} />
      </div>

      <div className="info-banner info-banner-proxy">
        <strong>📊 Proxy-källa:</strong>{' '}
        QQQ används som proxy för NASDAQ-100 eftersom riktig indexdata (NDX / NAS100) inte stöds av nuvarande datakälla (Alpaca IEX).
        QQQ korrelerar starkt med Nasdaq-100 och är ett tillförlitligt substitut för marknadslägesbedömning.
        {/* TODO: Add real NASDAQ-100 index feed via provider that supports NDX/NAS100. */}
      </div>

      {data?.marketWarning && (
        <div className="market-banner">⚠ Marknaden kan vara stängd – visar senast tillgänglig data.</div>
      )}
      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>
          ✗ Fel: {error}
        </div>
      )}

      {loading && <div className="empty"><span className="spinner" /> Hämtar Nasdaq-data…</div>}

      {!loading && (
        <>
          <GuideBoxV2 />

          {qqqData && (
            <div className="sec">
              <SectionHeader
                icon="📊"
                title="QQQ — Nasdaq-100 Proxy"
                desc="Invesco QQQ ETF används som proxy för NASDAQ-100 (NDX). Korrelation >0.99 — tillräcklig för marknadslägesbedömning och setup-timing."
              />
              <QQQPremiumCard data={qqqData} />
            </div>
          )}

          {qqqData && (
            <div className="sec">
              <SectionHeader
                icon={(qqqData.tradeScore ?? 0) >= 60 ? '⚡' : (qqqData.tradeScore ?? 0) >= 30 ? '🎯' : '⏳'}
                title={
                  (qqqData.tradeScore ?? 0) >= 60
                    ? 'Bästa läget just nu'
                    : (qqqData.tradeScore ?? 0) >= 30
                    ? 'Nära setup – bevaka'
                    : 'Ingen stark setup just nu'
                }
                desc={
                  (qqqData.tradeScore ?? 0) >= 60
                    ? 'QQQ har bra setup och timing.'
                    : (qqqData.tradeScore ?? 0) >= 30
                    ? 'Intressant, men vänta på bättre entry.'
                    : 'Priset är inte på rätt ställe just nu. Kom tillbaka senare.'
                }
              />
              <div className="best-grid">
                <BestCardV2 r={qqqData} rank={null} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
