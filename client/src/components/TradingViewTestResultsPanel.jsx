import React, { useMemo } from 'react';
import {
  resolveStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';
import {
  EMPTY_VALUE,
  fmtMoney,
  fmtNumber,
  fmtTime,
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

function safeText(value, fallback = EMPTY_VALUE) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNum(value, digits = 2, fallback = EMPTY_VALUE) {
  const num = numberOrNull(value);
  if (num === null) return fallback;
  return `${num > 0 ? '+' : ''}${fmtNumber(num, digits)}`;
}

function formatUsd(value) {
  const num = numberOrNull(value);
  if (num === null) return EMPTY_VALUE;
  return `${num > 0 ? '+' : ''}${fmtMoney(num, 'USD', 2)}`;
}

function safePct(value, digits = 2) {
  const text = safeNum(value, digits);
  return text === EMPTY_VALUE ? EMPTY_VALUE : `${text}%`;
}

function fmtDate(value) {
  return fmtTime(value);
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
    const aProfitFactor = numberOrNull(a?.profitFactor);
    const bProfitFactor = numberOrNull(b?.profitFactor);
    if (aProfitFactor !== null && bProfitFactor !== null && aProfitFactor !== bProfitFactor) {
      return bProfitFactor - aProfitFactor;
    }

    const aNet = numberOrNull(a?.netProfitPct);
    const bNet = numberOrNull(b?.netProfitPct);
    if (aNet !== null && bNet !== null && aNet !== bNet) {
      return bNet - aNet;
    }

    const aDrawdown = numberOrNull(a?.maxDrawdownPct);
    const bDrawdown = numberOrNull(b?.maxDrawdownPct);
    if (aDrawdown !== null && bDrawdown !== null && aDrawdown !== bDrawdown) {
      return bDrawdown - aDrawdown;
    }

    const aTrades = numberOrNull(a?.totalTrades);
    const bTrades = numberOrNull(b?.totalTrades);
    if (aTrades !== null && bTrades !== null && aTrades !== bTrades) {
      return bTrades - aTrades;
    }
    return 0;
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
  const strategy = resolveStrategy(result || {});
  const strategyId = safeText(strategy.strategyId, '—');
  const strategyName = strategyDisplayName(strategy, '—');
  const aiTone = String(result?.aiRating || '').toLowerCase().includes('strong') ? 'success' : 'info';
  const netProfitPct = numberOrNull(result?.netProfitPct);
  const profitFactor = numberOrNull(result?.profitFactor);
  const winrate = numberOrNull(result?.winrate);
  const totalTrades = numberOrNull(result?.totalTrades);
  const avgTradePct = numberOrNull(result?.avgTradePct);
  const positive = netProfitPct !== null && netProfitPct > 0;
  const negative = netProfitPct !== null && netProfitPct < 0;

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
            {isBest ? 'Topptest' : `Test #${rank}`}: {strategyName}
          </div>
          <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            {strategyId} · {safeText(result?.symbol)} · {safeText(result?.timeframe)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={badgeStyle(aiTone)}>{safeText(result?.aiRating)}</span>
          <span style={badgeStyle('info')}>{safeText(result?.source)}</span>
          <span style={badgeStyle(isBest ? 'success' : positive ? 'info' : 'warning')}>{fmtDate(result?.testedAt)}</span>
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <Metric label="Net profit USD" value={formatUsd(result?.netProfitUsd)} tone={positive ? 'success' : negative ? 'danger' : 'neutral'} />
        <Metric label="Net profit %" value={safeNum(result?.netProfitPct, 2)} tone={positive ? 'success' : negative ? 'danger' : 'neutral'} />
        <Metric label="Profit factor" value={safeNum(result?.profitFactor, 2)} tone={profitFactor !== null && profitFactor >= 1.5 ? 'success' : 'neutral'} />
        <Metric label="Winrate" value={safePct(result?.winrate, 2)} tone={winrate !== null && winrate >= 50 ? 'success' : 'neutral'} />
        <Metric label="Max drawdown %" value={safeNum(result?.maxDrawdownPct, 2)} tone="danger" />
        <Metric label="Total trades" value={safeText(result?.totalTrades, '–')} tone={totalTrades === null ? 'neutral' : totalTrades >= 50 ? 'success' : 'warning'} />
        <Metric label="Avg trade %" value={safeNum(result?.avgTradePct, 3)} tone={avgTradePct !== null && avgTradePct > 0 ? 'success' : 'neutral'} />
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
            {Array.isArray(result?.filters) && result.filters.length ? result.filters.join(' · ') : EMPTY_VALUE}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <div style={metricStyle()}>
          <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Strategy / runtime</div>
          <div style={{ marginTop: 6, color: 'var(--text)', fontSize: 12, lineHeight: 1.6 }}>
            Strategy ID: {safeText(strategy.strategyId)}<br />
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
  const sourceRows = Array.isArray(data?.results) ? data.results : [];
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
          <span style={badgeStyle('neutral')}>source={safeText(data?.source)}</span>
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
              <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>Bästa manuella test hittills: {strategyDisplayName(resolveStrategy(best), '—')}</div>
              <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                Föreslaget nästa manuella test: {safeText(best.nextRecommendedTest)}
              </div>
            </div>
            <span style={badgeStyle('success')}>{safeText(best.aiRating)}</span>
          </div>

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <Metric label="Symbol" value={safeText(best.symbol)} tone="success" />
            <Metric label="Timeframe" value={safeText(best.timeframe)} />
            <Metric label="Net profit %" value={safeNum(best.netProfitPct, 2)} tone="success" />
            <Metric label="Profit factor" value={safeNum(best.profitFactor, 2)} tone="success" />
            <Metric label="Winrate" value={safePct(best.winrate, 2)} tone="neutral" />
            <Metric label="Max drawdown %" value={safeNum(best.maxDrawdownPct, 2)} tone="danger" />
          </div>
        </div>
      ) : null}

      {results.length ? (
        <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
          {results.map((result, index) => (
            <ResultCard
              key={[result.strategyId, result.resultId, result.testedAt, result.symbol, index].filter(hasValue).join('_')}
              result={result}
              isBest={index === 0}
              rank={index + 1}
            />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 13 }}>
          Inga TradingView-resultat från backend.
        </div>
      )}
    </section>
  );
}
