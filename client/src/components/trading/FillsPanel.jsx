import React, { useMemo, useState } from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtMoney,
  fmtNumber,
  fmtTime,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { buildFillRows } from '../../domain/TradeJournalDomain.js';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';

// Ren execution-logg. Ingen strategistatistik och ingen candidate-information —
// klicket tar användaren till traden som fillen tillhör.

const PAGE_SIZE = 100;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const thStyle = {
  textAlign: 'left',
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
};

export const FillsPanel = React.memo(function FillsPanel({
  brokerFills = [],
  currency = 'USD',
  waiting = false,
  onSelectTrade = null,
  action = null,
}) {
  const [page, setPage] = useState(0);
  const rows = useMemo(() => buildFillRows({ brokerFills }), [brokerFills]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <section style={tradingSectionStyle({ marginTop: 14, padding: 0, overflow: 'hidden' })}>
      <div style={{ padding: 16, paddingBottom: 0 }}>
        <SectionHeader
          eyebrow="Broker mirror"
          title="Broker Executions"
          summary="Execution-logg från IBKR. Klicka på en fill för att öppna traden den tillhör."
          action={action}
        />
      </div>
      {waiting && !rows.length ? (
        <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{WAITING_BROKER}</div>
      ) : !rows.length ? (
        <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Inga brokerfills i reconciliation-mirrorn.</div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time', 'Exec ID', 'Order ID', 'Strategy', 'Symbol', 'Side', 'Qty', 'Fill Price', 'Commission', 'Source'].map((label) => (
                    <th key={label} style={thStyle}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.key}
                    onClick={row.executionId && onSelectTrade ? () => onSelectTrade(row.executionId) : undefined}
                    style={{ cursor: row.executionId && onSelectTrade ? 'pointer' : 'default' }}
                    title={row.executionId ? `Trade ${row.executionId}${row.brokerTime ? ` · broker time ${row.brokerTime}` : ''}` : row.brokerTime}
                    data-exec-id={row.execId}
                  >
                    <td style={tdStyle}>{fmtTime(row.time)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{textOrEmpty(row.execId)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{textOrEmpty(row.orderId)}</td>
                    <td style={tdStyle}>{textOrEmpty(row.strategyId)}</td>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{textOrEmpty(row.symbol)}</td>
                    <td style={tdStyle}>{textOrEmpty(row.side)}</td>
                    <td style={tdStyle}>{fmtNumber(row.quantity)}</td>
                    <td style={tdStyle}>{fmtNumber(row.fillPrice, 2)}</td>
                    <td style={tdStyle}>{row.commission == null ? EMPTY_VALUE : fmtMoney(row.commission, row.commissionCurrency || currency, 2)}</td>
                    <td style={{ ...tdStyle, color: 'var(--muted)' }}>{textOrEmpty(row.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderTop: '1px solid var(--border)',
            color: 'var(--muted)',
            fontSize: 12,
            flexWrap: 'wrap',
          }}>
            <span>Visar {fmtNumber(safePage * PAGE_SIZE + visible.length)} av {fmtNumber(rows.length)} fills</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Föregående</button>
              <span>Sida {safePage + 1} / {pageCount}</span>
              <button type="button" className="btn" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Nästa</button>
            </span>
          </div>
        </>
      )}
    </section>
  );
});
