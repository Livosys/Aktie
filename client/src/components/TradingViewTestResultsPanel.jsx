import React, { useMemo } from 'react';

const MOCK_TRADINGVIEW_RESULTS = [
  {
    strategyId: 'tv_aapl_sma20_sma200_clean_backtest',
    strategyName: 'AAPL SMA20/SMA200 Clean Backtest',
    symbol: 'AAPL',
    timeframe: '15m',
    source: 'TradingView CSV/backtest',
    testedAt: '2026-06-18T07:30:00Z',
    lookbackDays: 180,
    maxTradesPerDay: 3,
    cooldownMinutes: 60,
    entryRulesHuman: 'Long only when SMA20 reclaims SMA200 and price closes above both averages with trend confirmation.',
    exitRulesHuman: 'Exit on trend loss, opposing cross, or protective stop triggered by invalidation.',
    filters: ['Equities only', 'NYSE/Nasdaq session', 'No earnings window'],
    netProfitUsd: 603.00,
    netProfitPct: 6.03,
    profitFactor: 1.80,
    winrate: 33.67,
    maxDrawdownPct: -1.89,
    totalTrades: 98,
    avgTradePct: 0.062,
    bestTradePct: 1.41,
    worstTradePct: -0.84,
    aiRating: 'Bästa hittills',
    aiReason: 'Best balance between profit factor, drawdown control, and sample size. The clean trend filter looks stable.',
    nextRecommendedTest: 'RSI > 50 + SMA200 uppåtlutning.',
  },
  {
    strategyId: 'tv_googl_sma20_sma200_clean_backtest',
    strategyName: 'GOOGL SMA20/SMA200 Clean Backtest',
    symbol: 'GOOGL',
    timeframe: '15m',
    source: 'TradingView CSV/backtest',
    testedAt: '2026-06-18T07:45:00Z',
    lookbackDays: 180,
    maxTradesPerDay: 3,
    cooldownMinutes: 60,
    entryRulesHuman: 'Long only when SMA20 crosses above SMA200 and momentum stays positive for the confirmation bar.',
    exitRulesHuman: 'Exit on trend reversal, stop invalidation, or when the price loses the moving-average structure.',
    filters: ['Equities only', 'NYSE/Nasdaq session', 'No earnings window'],
    netProfitUsd: 490.00,
    netProfitPct: 4.90,
    profitFactor: 1.54,
    winrate: 32.69,
    maxDrawdownPct: -2.06,
    totalTrades: 104,
    avgTradePct: 0.047,
    bestTradePct: 1.22,
    worstTradePct: -0.91,
    aiRating: 'Näst bäst hittills',
    aiReason: 'Still positive, but weaker efficiency and deeper drawdown than AAPL on the same clean setup.',
    nextRecommendedTest: 'RSI > 50 + SMA200 uppåtlutning.',
  },
];

function safeText(value, fallback = '–') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNum(value, digits = 2, fallback = '–') {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}`;
}

function formatUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '–';
  return `${num > 0 ? '+' : ''}$${num.toFixed(2)}`;
}

function fmtDate(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '–';
  return date.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function badgeStyle(tone = 'neutral') {
  const map = {
    neutral: { border: 'var(--border)', bg: 'var(--surface-2)', fg: 'var(--text)' },
    success: { border: 'rgba(34,197,94,0.28)', bg: 'rgba(34,197,94,0.10)', fg: '#86efac' },
    warning: { border: 'rgba(245,158,11,0.28)', bg: 'rgba(245,158,11,0.10)', fg: '#fcd34d' },
    danger: { border: 'rgba(239,68,68,0.28)', bg: 'rgba(239,68,68,0.10)', fg: '#fca5a5' },
    info: { border: 'rgba(56,189,248,0.28)', bg: 'rgba(56,189,248,0.10)', fg: '#7dd3fc' },
  };
  const cfg = map[tone] || map.neutral;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: 999,
    border: `1px solid ${cfg.border}`,
    background: cfg.bg,
    color: cfg.fg,
    fontSize: 11,
    fontWeight: 800,
    lineHeight: 1.2,
  };
}

function sectionStyle(theme = 'dark') {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 18,
    marginBottom: 18,
    boxShadow: theme === 'light' ? '0 10px 24px rgba(15,23,42,0.06)' : '0 18px 40px rgba(2,6,23,0.18)',
  };
}

function sortResults(rows) {
  return [...rows].sort((a, b) => {
    const aProfitFactor = Number(a?.profitFactor);
    const bProfitFactor = Number(b?.profitFactor);
    if (Number.isFinite(aProfitFactor) && Number.isFinite(bProfitFactor) && aProfitFactor !== bProfitFactor) {
      return bProfitFactor - aProfitFactor;
    }

    const aNet = Number(a?.netProfitPct);
    const bNet = Number(b?.netProfitPct);
    if (Number.isFinite(aNet) && Number.isFinite(bNet) && aNet !== bNet) {
      return bNet - aNet;
    }

    const aDrawdown = Number(a?.maxDrawdownPct);
    const bDrawdown = Number(b?.maxDrawdownPct);
    if (Number.isFinite(aDrawdown) && Number.isFinite(bDrawdown) && aDrawdown !== bDrawdown) {
      return bDrawdown - aDrawdown;
    }

    return Number(b?.totalTrades || 0) - Number(a?.totalTrades || 0);
  });
}

function metricStyle() {
  return {
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 12,
    background: 'var(--surface-2)',
    minHeight: 82,
  };
}

function Metric({ label, value, note, tone = 'neutral' }) {
  return (
    <div style={metricStyle()}>
      <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ marginTop: 5, fontSize: 18, fontWeight: 900, color: tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)' }}>
        {value}
      </div>
      {note ? <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 11, lineHeight: 1.45 }}>{note}</div> : null}
    </div>
  );
}

function ResultCard({ result, isBest = false, rank = 1 }) {
  const aiTone = String(result?.aiRating || '').toLowerCase().includes('strong') ? 'success' : 'info';
  const positive = Number(result?.netProfitPct) > 0;

  return (
    <article style={{
      border: isBest ? '1px solid rgba(34,197,94,0.34)' : '1px solid var(--border)',
      borderRadius: 16,
      padding: 16,
      background: isBest ? 'linear-gradient(180deg, rgba(34,197,94,0.10) 0%, var(--surface) 100%)' : 'var(--surface)',
      boxShadow: isBest ? '0 18px 40px rgba(34,197,94,0.08)' : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text)' }}>
            {isBest ? 'Topptest' : `Test #${rank}`}: {safeText(result?.strategyName)}
          </div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            {safeText(result?.strategyId)} · {safeText(result?.symbol)} · {safeText(result?.timeframe)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={badgeStyle(aiTone)}>{safeText(result?.aiRating, 'AI rating')}</span>
          <span style={badgeStyle('info')}>{safeText(result?.source, 'TradingView CSV/backtest')}</span>
          <span style={badgeStyle(isBest ? 'success' : positive ? 'info' : 'warning')}>{fmtDate(result?.testedAt)}</span>
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <Metric label="Net profit USD" value={formatUsd(result?.netProfitUsd)} tone={positive ? 'success' : 'danger'} />
        <Metric label="Net profit %" value={safeNum(result?.netProfitPct, 2)} tone={positive ? 'success' : 'danger'} />
        <Metric label="Profit factor" value={safeNum(result?.profitFactor, 2)} tone={Number(result?.profitFactor) >= 1.5 ? 'success' : 'neutral'} />
        <Metric label="Winrate" value={`${safeNum(result?.winrate, 2)}%`} tone={Number(result?.winrate) >= 50 ? 'success' : 'neutral'} />
        <Metric label="Max drawdown %" value={safeNum(result?.maxDrawdownPct, 2)} tone="danger" />
        <Metric label="Total trades" value={safeText(result?.totalTrades, '–')} tone={Number(result?.totalTrades) >= 50 ? 'success' : 'warning'} />
        <Metric label="Avg trade %" value={safeNum(result?.avgTradePct, 3)} tone={Number(result?.avgTradePct) > 0 ? 'success' : 'neutral'} />
        <Metric label="Best / worst trade" value={`${safeNum(result?.bestTradePct, 2)} / ${safeNum(result?.worstTradePct, 2)}`} tone="neutral" />
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Entry rules</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>{safeText(result?.entryRulesHuman)}</div>
        </div>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Exit rules</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>{safeText(result?.exitRulesHuman)}</div>
        </div>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Filters</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>
            {Array.isArray(result?.filters) && result.filters.length ? result.filters.join(' · ') : '–'}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Strategy / runtime</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
            Strategy ID: {safeText(result?.strategyId)}<br />
            Tested at: {fmtDate(result?.testedAt)}<br />
            Lookback: {safeText(result?.lookbackDays)} days<br />
            Max trades/day: {safeText(result?.maxTradesPerDay)}<br />
            Cooldown: {safeText(result?.cooldownMinutes)} minutes
          </div>
        </div>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Analys</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.55 }}>{safeText(result?.aiReason)}</div>
        </div>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Föreslaget nästa manuella test</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.55, fontWeight: 800 }}>
            {safeText(result?.nextRecommendedTest)}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function TradingViewTestResultsPanel({ data, theme = 'dark' }) {
  const sourceRows = Array.isArray(data?.results) && data.results.length ? data.results : MOCK_TRADINGVIEW_RESULTS;
  const results = useMemo(() => sortResults(sourceRows), [sourceRows]);
  const best = results[0] || null;

  return (
    <section style={sectionStyle(theme)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Manuellt importerade TradingView/Pine Script-resultat</h2>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Manuellt importerade TradingView/Pine Script-resultat. TradingView-resultat är externa backtests. De lägger inga order och påverkar inte broker eller risk.
          </div>
          <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>
            Senare kan dessa resultat kopplas till AI-rekommendationer och Learning Engine, men just nu är detta manuellt research-underlag.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={badgeStyle('success')}>read-only</span>
          <span style={badgeStyle('neutral')}>source=TradingView CSV/backtest</span>
          <span style={badgeStyle('info')}>sorted by profitFactor → netProfitPct → maxDrawdownPct → trades</span>
        </div>
      </div>

      <div style={{ padding: '12px 14px', borderRadius: 14, border: '1px solid rgba(56,189,248,0.22)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>
        TradingView-resultat är externa backtests. De lägger inga order och påverkar inte broker eller risk.
      </div>

      {best ? (
        <div style={{ marginTop: 14, border: '1px solid rgba(34,197,94,0.22)', borderRadius: 14, padding: 14, background: 'linear-gradient(180deg, rgba(34,197,94,0.08) 0%, var(--surface-2) 100%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>Bästa manuella test hittills: {safeText(best.strategyName)}</div>
              <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                AAPL är starkast hittills. Nästa test: RSI &gt; 50 + SMA200 uppåtlutning.
              </div>
            </div>
            <span style={badgeStyle('success')}>{safeText(best.aiRating)}</span>
          </div>

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <Metric label="Symbol" value={safeText(best.symbol)} tone="success" />
            <Metric label="Timeframe" value={safeText(best.timeframe)} />
            <Metric label="Net profit %" value={safeNum(best.netProfitPct, 2)} tone="success" />
            <Metric label="Profit factor" value={safeNum(best.profitFactor, 2)} tone="success" />
            <Metric label="Winrate" value={`${safeNum(best.winrate, 2)}%`} tone="neutral" />
            <Metric label="Max drawdown %" value={safeNum(best.maxDrawdownPct, 2)} tone="danger" />
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
        {results.map((result, index) => (
          <ResultCard key={result.strategyId} result={result} isBest={index === 0} rank={index + 1} />
        ))}
      </div>
    </section>
  );
}
