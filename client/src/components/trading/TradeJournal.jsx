import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import {
  DEFAULT_TRADE_LIMIT,
  EMPTY_TRADE_FILTERS,
  filterTrades,
  summarizeTrades,
  tradeFilterOptions,
} from '../../domain/TradeJournalDomain.js';
import { MetricCard } from './MetricCard.jsx';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { TradeDetailCard } from './TradeDetailCard.jsx';

// Trades är den primära vyn: en rad = en trade. Orders och fills stödjer traden,
// inte tvärtom. All brokerteknik finns kvar men ligger bakom expand.

const PAGE_SIZE = 50;

const STATUS_FILTERS = [
  { value: 'all', label: 'Alla' },
  { value: 'attention', label: '⚠ Kräver uppmärksamhet' },
  { value: 'open', label: '🟡 Open' },
  { value: 'win', label: '🟢 Win' },
  { value: 'loss', label: '🔴 Loss' },
  { value: 'breakeven', label: '⚪ Breakeven' },
  { value: 'closed_unverified', label: '⚪ Closed (PnL saknas)' },
  { value: 'cancelled', label: '⚪ Cancelled' },
  { value: 'rejected', label: '⚪ Rejected' },
];

const selectStyle = {
  background: 'var(--surface-2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  minWidth: 0,
};

const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  color: 'var(--muted)',
  fontSize: 10.5,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0,
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

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={{ color: 'var(--muted)', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

function pnlColor(value) {
  if (value == null) return 'var(--text)';
  if (value > 0) return 'var(--success)';
  if (value < 0) return 'var(--danger)';
  return 'var(--text)';
}

function shortTime(value) {
  const text = fmtTime(value);
  return text === EMPTY_VALUE ? EMPTY_VALUE : text.slice(5, 16);
}

function tradeStatusLabel(trade = {}) {
  return {
    open: 'Öppen',
    win: 'Vinst',
    loss: 'Förlust',
    breakeven: 'Plus minus noll',
    closed_unverified: 'Resultat saknas',
    cancelled: 'Avbruten',
    rejected: 'Stoppad',
  }[trade.status] || trade.statusLabel || EMPTY_VALUE;
}

function directionLabel(direction) {
  if (direction === 'LONG') return 'Lång';
  if (direction === 'SHORT') return 'Kort';
  return textOrEmpty(direction);
}

const TradeRow = React.memo(function TradeRow({ trade, expanded, onToggle, currency, columnCount }) {
  const pnl = trade.status === 'open' ? trade.unrealizedPnl : trade.netPnl;
  const openRow = trade.status === 'open';
  return (
    <>
      <tr
        onClick={() => onToggle(trade.key)}
        style={{
          cursor: 'pointer',
          background: expanded ? 'var(--surface-2)' : 'transparent',
        }}
        data-execution-id={trade.executionId}
        data-trade-status={trade.status}
      >
        <td style={{ ...tdStyle, width: 24, color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</td>
        {/* Entry- och exittid är två rader i samma kolumn: båda syns utan att
            tabellen blir bredare. Duration ligger kvar som egen kolumn. */}
        <td style={tdStyle} title={`Entry ${fmtTime(trade.entryTime)}${trade.exitTime ? ` · Exit ${fmtTime(trade.exitTime)}` : ''}`}>
          <div>{shortTime(trade.entryTime)}</div>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {trade.exitTime ? shortTime(trade.exitTime) : EMPTY_VALUE}
          </div>
        </td>
        <td style={{ ...tdStyle, fontWeight: 800 }}>{textOrEmpty(trade.symbol)}</td>
        <td style={{ ...tdStyle, maxWidth: 190 }} title={textOrEmpty(trade.strategyName)}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{textOrEmpty(trade.strategyName)}</div>
          <div style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {textOrEmpty(trade.strategyFamily)}
          </div>
        </td>
        <td style={tdStyle}>
          {hasValue(trade.direction) ? (
            <span style={{ color: trade.direction === 'SHORT' ? 'var(--danger)' : 'var(--success)', fontWeight: 800 }}>{directionLabel(trade.direction)}</span>
          ) : EMPTY_VALUE}
        </td>
        <td style={tdStyle}>
          <StatusBadge tone={trade.statusTone} compact>{trade.statusDot} {tradeStatusLabel(trade)}</StatusBadge>
        </td>
        <td style={tdStyle}>{fmtNumber(trade.entryPrice, 2)}</td>
        <td style={tdStyle}>{fmtNumber(trade.exitPrice, 2)}</td>
        <td style={tdStyle}>{fmtNumber(trade.stopPrice, 2)}</td>
        <td style={tdStyle}>{fmtNumber(trade.takeProfitPrice, 2)}</td>
        <td style={tdStyle}>{fmtNumber(trade.quantity)}</td>
        <td style={{ ...tdStyle, color: pnlColor(trade.grossPnl) }}>
          {trade.grossPnl == null ? EMPTY_VALUE : fmtMoney(trade.grossPnl, currency, 2)}
        </td>
        <td style={tdStyle}>{fmtMoney(trade.commission, trade.commissionCurrency || currency, 2)}</td>
        <td style={{ ...tdStyle, color: pnlColor(pnl), fontWeight: 800 }} title={openRow && pnl != null ? 'Orealiserad PnL från öppen brokerposition' : null}>
          {pnl == null ? EMPTY_VALUE : `${fmtMoney(pnl, currency, 2)}${openRow ? '*' : ''}`}
        </td>
        <td style={{ ...tdStyle, color: pnlColor(trade.pnlPercent) }}>{trade.pnlPercent == null ? EMPTY_VALUE : fmtPercent(trade.pnlPercent, 2)}</td>
        <td style={tdStyle}>{fmtAge(trade.durationMs)}</td>
        {/* Broker står i detaljkortet — samma värde på varje rad hjälper inget beslut. */}
        <td style={tdStyle}>{textOrEmpty(trade.exitReason)}</td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={columnCount} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
            <TradeDetailCard trade={trade} currency={currency} />
          </td>
        </tr>
      ) : null}
    </>
  );
});

export const TradeJournal = React.memo(function TradeJournal({
  trades = [],
  totalTrades = 0,
  truncated = false,
  currency = 'USD',
  waiting = false,
  focusExecutionId = null,
  onFocusHandled = null,
  action = null,
}) {
  const [filters, setFilters] = useState(EMPTY_TRADE_FILTERS);
  const [expandedKey, setExpandedKey] = useState(null);
  const [page, setPage] = useState(0);

  const summary = useMemo(() => summarizeTrades(trades), [trades]);
  const options = useMemo(() => tradeFilterOptions(trades), [trades]);
  const filtered = useMemo(() => filterTrades(trades, filters), [filters, trades]);

  // En fill eller order kan peka hit: filtret nollställs och traden expanderas.
  useEffect(() => {
    if (!focusExecutionId) return;
    setFilters({ ...EMPTY_TRADE_FILTERS, search: focusExecutionId });
    setExpandedKey(focusExecutionId);
    setPage(0);
    if (typeof onFocusHandled === 'function') onFocusHandled();
  }, [focusExecutionId, onFocusHandled]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  // Bara sidans rader renderas — 300 trades ska aldrig bli 300 DOM-rader på en gång.
  const visible = useMemo(
    () => filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filtered, safePage],
  );

  const update = useCallback((patch) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  }, []);

  const toggle = useCallback((key) => {
    setExpandedKey((current) => (current === key ? null : key));
  }, []);

  // Måste matcha antalet <th> nedan — detaljraden spänner över hela tabellen.
  const columnCount = 17;

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <section style={tradingSectionStyle({ borderColor: 'rgba(59,130,246,0.30)' })}>
        <SectionHeader
          eyebrow="Senaste avslut"
          title="Affärsjournal"
          // Rubriken beskriver verkligheten — vad en rad är och hur den är sorterad.
          // Att grupperingen sker på executionId är implementation och hör hemma i koden.
          summary="En rad = en affär, från ingång till avslut. Öppna affärer ligger överst, därefter senaste avslut."
          action={action}
        />
        {/* Varje kort svarar på en av frågorna standardvyn ska klara på tio sekunder:
            hur många trades, vilka strategier handlar, hur gick det, vad är öppet,
            vad kräver uppmärksamhet. Fördjupning (expectancy, profit factor, snitt,
            largest, sharpe, drawdown) bor i Analytics och upprepas inte här. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <MetricCard
            label="Affärer"
            value={fmtNumber(summary.trades)}
            hint={truncated ? `av ${fmtNumber(totalTrades)} totalt` : `${fmtNumber(summary.closedTrades)} stängda`}
          />
          <MetricCard
            label="Strategier"
            value={fmtNumber(summary.activeStrategies)}
            hint={summary.strategyNames.length ? summary.strategyNames.slice(0, 3).join(', ') + (summary.strategyNames.length > 3 ? ` +${summary.strategyNames.length - 3}` : '') : null}
          />
          <MetricCard
            label="Öppna affärer"
            value={fmtNumber(summary.openTrades)}
            tone={summary.openTrades ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Vinstgrad"
            value={summary.winRate == null ? EMPTY_VALUE : fmtPercent(summary.winRate, 1)}
            hint={`${fmtNumber(summary.wins)} W · ${fmtNumber(summary.losses)} L`}
          />
          <MetricCard
            label="Resultat"
            value={fmtMoney(summary.netPnl, currency, 2)}
            tone={summary.netPnl == null ? 'neutral' : (summary.netPnl < 0 ? 'danger' : 'success')}
            hint={`brutto ${fmtMoney(summary.grossPnl, currency, 2)} · courtage ${fmtMoney(summary.commission, currency, 2)}`}
          />
          {/* Klickbart: kortet är ingången till exakt de trades som behöver åtgärd. */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => update({ status: summary.attention.total ? 'attention' : 'all' })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                update({ status: summary.attention.total ? 'attention' : 'all' });
              }
            }}
            style={{ cursor: summary.attention.total ? 'pointer' : 'default', minWidth: 0 }}
            title={summary.attention.total ? 'Visa endast affärer som kräver uppmärksamhet' : null}
          >
            <MetricCard
              label="Kräver uppmärksamhet"
              value={fmtNumber(summary.attention.total)}
              tone={summary.attention.total ? 'danger' : 'success'}
              hint={summary.attention.total
                ? [
                  summary.attention.rejected ? `${fmtNumber(summary.attention.rejected)} stoppade` : null,
                  summary.attention.openWithoutStop ? `${fmtNumber(summary.attention.openWithoutStop)} utan stop` : null,
                  summary.attention.unverified ? `${fmtNumber(summary.attention.unverified)} utan PnL` : null,
                ].filter(Boolean).join(' · ')
                : 'inget att åtgärda'}
            />
          </div>
        </div>
      </section>

      <section style={tradingSectionStyle({ padding: 12 })}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, alignItems: 'end' }}>
          <Field label="Status">
            <select style={selectStyle} value={filters.status} onChange={(event) => update({ status: event.target.value })}>
              {STATUS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="Strategi">
            <select style={selectStyle} value={filters.strategyId} onChange={(event) => update({ strategyId: event.target.value })}>
              <option value="all">Alla</option>
              {options.strategies.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="Marknad">
            <select style={selectStyle} value={filters.symbol} onChange={(event) => update({ symbol: event.target.value })}>
              <option value="all">Alla</option>
              {options.symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </Field>
          <Field label="Riktning">
            <select style={selectStyle} value={filters.direction} onChange={(event) => update({ direction: event.target.value })}>
              <option value="all">Alla</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </Field>
          <Field label="PnL">
            <select style={selectStyle} value={filters.pnl} onChange={(event) => update({ pnl: event.target.value })}>
              <option value="all">Alla</option>
              <option value="positive">Positiv</option>
              <option value="negative">Negativ</option>
            </select>
          </Field>
          <Field label="Från">
            <input type="date" style={selectStyle} value={filters.from} onChange={(event) => update({ from: event.target.value })} />
          </Field>
          <Field label="Till">
            <input type="date" style={selectStyle} value={filters.to} onChange={(event) => update({ to: event.target.value })} />
          </Field>
          <Field label="Sök">
            <input
              type="search"
              // Sökningen matchar fortfarande hela identitetskedjan — men den
              // vokabulären ska inte vara det första en användare möter.
              placeholder="strategi, symbol eller ID"
              style={selectStyle}
              value={filters.search}
              onChange={(event) => update({ search: event.target.value })}
            />
          </Field>
          {/* Ingen "Endast öppna"-kryssruta: statusfiltrets 🟡 Open gör exakt samma sak.
              filters.openOnly finns kvar i domänen och fungerar oförändrat. */}
          <button type="button" className="btn" onClick={() => { setFilters(EMPTY_TRADE_FILTERS); setPage(0); }}>Rensa filter</button>
        </div>
      </section>

      <section style={tradingSectionStyle({ padding: 0, overflow: 'hidden' })}>
        {waiting && !trades.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{WAITING_BROKER}</div>
        ) : !filtered.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
            {trades.length ? 'Inga affärer matchar filtret.' : 'Inga affärer visas ännu.'}
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle} aria-label="Expandera" />
                    <th style={thStyle}>Ingång / avslut</th>
                    <th style={thStyle}>Symbol</th>
                    <th style={thStyle}>Strategi / familj</th>
                    <th style={thStyle}>Riktning</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Ingång</th>
                    <th style={thStyle}>Avslut</th>
                    <th style={thStyle}>Stop</th>
                    <th style={thStyle}>Mål</th>
                    <th style={thStyle}>Antal</th>
                    <th style={thStyle}>Brutto</th>
                    <th style={thStyle}>Courtage</th>
                    <th style={thStyle}>Resultat</th>
                    <th style={thStyle}>Resultat %</th>
                    <th style={thStyle}>Tid</th>
                    <th style={thStyle}>Orsak</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((trade) => (
                    <TradeRow
                      key={trade.key}
                      trade={trade}
                      expanded={expandedKey === trade.key}
                      onToggle={toggle}
                      currency={currency}
                      columnCount={columnCount}
                    />
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
              <span>
                Visar {fmtNumber(safePage * PAGE_SIZE + 1)}–{fmtNumber(safePage * PAGE_SIZE + visible.length)} av {fmtNumber(filtered.length)} affärer
                {filtered.length !== trades.length ? ` (filtrerat från ${fmtNumber(trades.length)})` : ''}
                {truncated ? ` · kapat till ${fmtNumber(DEFAULT_TRADE_LIMIT)} av ${fmtNumber(totalTrades)}` : ''}
                {' · '}* = orealiserad PnL på öppen position
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="btn" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Föregående</button>
                <span>Sida {safePage + 1} / {pageCount}</span>
                <button type="button" className="btn" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Nästa</button>
              </span>
            </div>
          </>
        )}
      </section>
    </section>
  );
});
