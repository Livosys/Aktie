import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { buildTradeStatistics, summarizeTrades } from '../../domain/TradeJournalDomain.js';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';

// All handelsstatistik samlas här — inte på varje orderkort. Siffrorna räknas ur
// samma journalrader som Trades-sidan visar, så tabellerna aldrig kan säga emot
// varandra. Endast broker-verifierad realiserad PnL räknas som en stängd trade,
// vilket är samma regel som backendens strategy performance använder.
// Samma tabell svarar på tre frågor beroende på groupBy: vilken strategi tjänar
// pengar, vilken familj, och vilken marknad.

const GROUPINGS = {
  strategy: {
    eyebrow: 'Strategy statistics',
    title: 'Statistik per strategi',
    label: 'Strategi',
    empty: 'Ingen strategistatistik i broker mirror.',
    showFamily: true,
  },
  family: {
    eyebrow: 'Family statistics',
    title: 'Statistik per familj',
    label: 'Familj',
    empty: 'Ingen familjestatistik i broker mirror.',
    showFamily: false,
  },
  symbol: {
    eyebrow: 'Market statistics',
    title: 'Statistik per marknad',
    label: 'Marknad',
    empty: 'Ingen marknadsstatistik i broker mirror.',
    showFamily: false,
  },
};

const thStyle = {
  textAlign: 'right',
  padding: '8px 10px',
  color: 'var(--muted)',
  fontSize: 10.5,
  fontWeight: 800,
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  background: 'var(--surface)',
  zIndex: 1,
};

const tdStyle = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  whiteSpace: 'nowrap',
  textAlign: 'right',
};

const leftAlign = { textAlign: 'left' };

function pnlColor(value) {
  if (value == null) return 'var(--text)';
  if (value > 0) return 'var(--success)';
  if (value < 0) return 'var(--danger)';
  return 'var(--text)';
}

export const StrategyStatisticsPanel = React.memo(function StrategyStatisticsPanel({
  trades = [],
  currency = 'USD',
  waiting = false,
  groupBy = 'strategy',
}) {
  const grouping = GROUPINGS[groupBy] || GROUPINGS.strategy;
  const stats = useMemo(() => buildTradeStatistics(trades, groupBy), [groupBy, trades]);
  const total = useMemo(() => summarizeTrades(trades), [trades]);

  return (
    <section style={tradingSectionStyle({ padding: 0, overflow: 'hidden' })}>
      <div style={{ padding: 16, paddingBottom: 0 }}>
        <SectionHeader
          eyebrow={grouping.eyebrow}
          title={grouping.title}
          summary="Win rate, expectancy, profit factor, average/largest win och loss, sharpe, drawdown, trades samt netto-, brutto-PnL och courtage. Endast trades med broker-verifierad realiserad PnL räknas som stängda."
        />
      </div>
      {waiting && !stats.length ? (
        <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{WAITING_BROKER}</div>
      ) : !stats.length ? (
        <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{grouping.empty}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, ...leftAlign }}>{grouping.label}</th>
                {grouping.showFamily ? <th style={{ ...thStyle, ...leftAlign }}>Family</th> : null}
                <th style={thStyle}>Trades</th>
                <th style={thStyle}>Open</th>
                <th style={thStyle}>Closed</th>
                <th style={thStyle}>Wins</th>
                <th style={thStyle}>Losses</th>
                <th style={thStyle}>Win rate</th>
                <th style={thStyle}>Expectancy</th>
                <th style={thStyle}>Profit factor</th>
                <th style={thStyle}>Avg win</th>
                <th style={thStyle}>Avg loss</th>
                <th style={thStyle}>Largest win</th>
                <th style={thStyle}>Largest loss</th>
                <th style={thStyle}>Sharpe</th>
                <th style={thStyle}>Drawdown</th>
                <th style={thStyle}>Gross PnL</th>
                <th style={thStyle}>Commission</th>
                <th style={thStyle}>Net PnL</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.groupKey}>
                  <td style={{ ...tdStyle, ...leftAlign, fontWeight: 700 }} title={textOrEmpty(row.strategyId)}>{textOrEmpty(row.groupLabel)}</td>
                  {grouping.showFamily ? (
                    <td style={{ ...tdStyle, ...leftAlign, color: 'var(--muted)' }}>{textOrEmpty(row.groupSublabel)}</td>
                  ) : null}
                  <td style={tdStyle}>{fmtNumber(row.trades)}</td>
                  <td style={tdStyle}>{fmtNumber(row.openTrades)}</td>
                  <td style={tdStyle} title={row.unverifiedTrades ? `${row.unverifiedTrades} stängda utan verifierad PnL räknas inte` : null}>
                    {fmtNumber(row.closedTrades)}{row.unverifiedTrades ? <span style={{ color: 'var(--muted)' }}> (+{fmtNumber(row.unverifiedTrades)})</span> : null}
                  </td>
                  <td style={tdStyle}>{fmtNumber(row.wins)}</td>
                  <td style={tdStyle}>{fmtNumber(row.losses)}</td>
                  <td style={tdStyle}>{row.winRate == null ? EMPTY_VALUE : fmtPercent(row.winRate, 1)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.expectancy) }}>{fmtMoney(row.expectancy, currency, 2)}</td>
                  <td style={tdStyle}>{row.profitFactor == null ? EMPTY_VALUE : fmtNumber(row.profitFactor, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.averageWin) }}>{fmtMoney(row.averageWin, currency, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.averageLoss) }}>{fmtMoney(row.averageLoss, currency, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.largestWin) }}>{fmtMoney(row.largestWin, currency, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.largestLoss) }}>{fmtMoney(row.largestLoss, currency, 2)}</td>
                  <td style={tdStyle}>{row.sharpe == null ? EMPTY_VALUE : fmtNumber(row.sharpe, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.drawdown) }}>{fmtMoney(row.drawdown, currency, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.grossPnl) }}>{fmtMoney(row.grossPnl, currency, 2)}</td>
                  <td style={tdStyle}>{fmtMoney(row.commission, currency, 2)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.netPnl), fontWeight: 800 }}>{fmtMoney(row.netPnl, currency, 2)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...tdStyle, ...leftAlign, fontWeight: 800 }}>Totalt</td>
                {grouping.showFamily ? <td style={tdStyle} /> : null}
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtNumber(total.trades)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtNumber(total.openTrades)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtNumber(total.closedTrades)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtNumber(total.wins)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtNumber(total.losses)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{total.winRate == null ? EMPTY_VALUE : fmtPercent(total.winRate, 1)}</td>
                <td style={tdStyle} />
                <td style={{ ...tdStyle, fontWeight: 800 }}>{total.profitFactor == null ? EMPTY_VALUE : fmtNumber(total.profitFactor, 2)}</td>
                <td style={{ ...tdStyle, color: pnlColor(total.averageWinner) }}>{fmtMoney(total.averageWinner, currency, 2)}</td>
                <td style={{ ...tdStyle, color: pnlColor(total.averageLoser) }}>{fmtMoney(total.averageLoser, currency, 2)}</td>
                <td style={tdStyle} />
                <td style={tdStyle} />
                <td style={tdStyle} />
                <td style={tdStyle} />
                <td style={{ ...tdStyle, color: pnlColor(total.grossPnl), fontWeight: 800 }}>{fmtMoney(total.grossPnl, currency, 2)}</td>
                <td style={{ ...tdStyle, fontWeight: 800 }}>{fmtMoney(total.commission, currency, 2)}</td>
                <td style={{ ...tdStyle, color: pnlColor(total.netPnl), fontWeight: 800 }}>{fmtMoney(total.netPnl, currency, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
