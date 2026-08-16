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
import { MetricCard } from './MetricCard.jsx';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { TradeDetailCard } from './TradeDetailCard.jsx';

// Live Trading Desk — sidan man har uppe MEDAN positioner är öppna.
//
// Standardvyn ska besvara fyra frågor på under fem sekunder: hur många positioner
// är öppna, hur mycket tjänar eller förlorar vi just nu, vilka strategier handlar
// och hur nära är stop eller take profit. Allt annat — broker mirror, identitet,
// order- och executionlager — ligger kvar men bakom expand.
//
// Ingen egen hämtning: raderna byggs av sidan ur samma runtime-snapshot som
// resten av desken, och den lokala sekundpulsen läser bara klockan.

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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

// Måste matcha antalet <th> nedan — detaljraden spänner över hela tabellen.
const COLUMN_COUNT = 18;

function pnlColor(value) {
  if (value == null) return 'var(--text)';
  if (value > 0) return 'var(--success)';
  if (value < 0) return 'var(--danger)';
  return 'var(--text)';
}

function directionColor(direction) {
  if (direction === 'SHORT') return 'var(--danger)';
  if (direction === 'LONG') return 'var(--success)';
  return 'var(--text)';
}

// Avstånd mäts i punkter men handlas i ticks — båda får plats i samma cell.
function Distance({ points, ticks, tone = null }) {
  if (points == null) return <span style={{ color: 'var(--muted)' }}>{EMPTY_VALUE}</span>;
  return (
    <span style={{ color: tone || 'var(--text)' }}>
      {fmtNumber(points, 2)}
      {ticks == null ? null : (
        <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {fmtNumber(ticks, 0)}t</span>
      )}
    </span>
  );
}

function DetailBlock({ title, children, hint = null }) {
  return (
    <section style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 12,
      background: 'var(--surface)',
      minWidth: 0,
    }}>
      <div style={{
        color: 'var(--muted)',
        fontSize: 11,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
      {hint ? <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8, lineHeight: 1.4 }}>{hint}</div> : null}
    </section>
  );
}

function DetailRows({ rows = [], mono = false }) {
  if (!rows.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>{EMPTY_VALUE}</div>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 40%) minmax(0, 1fr)', gap: 8, alignItems: 'baseline' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{row.label}</div>
          <div style={{
            color: row.tone || 'var(--text)',
            fontSize: 12,
            fontFamily: mono || row.mono ? MONO : 'inherit',
            overflowWrap: 'anywhere',
            lineHeight: 1.4,
          }}>
            {hasValue(row.value) ? row.value : EMPTY_VALUE}
          </div>
        </div>
      ))}
    </div>
  );
}

// Detaljvyn: allt tekniskt finns kvar, men bara här. Har raden en trade i
// journalen återanvänds tradedetaljkortet oförändrat — samma timeline, samma
// orderben, samma executions, samma identitetskedja, samma replay-/evidensfält.
function PositionDetail({ row, currency, nowMs }) {
  const position = row.position || {};
  const quote = row.quote || {};
  const freshness = row.quoteFreshness || {};
  const durationMs = row.entryMs == null ? row.durationMs : Math.max(0, nowMs - row.entryMs);

  return (
    <div style={{ borderLeft: '3px solid var(--accent, #3b82f6)', background: 'var(--surface-2)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 10,
        padding: '12px 12px 4px',
      }}>
        <DetailBlock title="Live" hint="Räknas ur quoten just nu, kontraktets tickSize/pointValue och positionens entry.">
          <DetailRows
            rows={[
              { label: 'Entry', value: `${fmtNumber(row.entryPrice, 2)}${row.entryTime ? ` · ${fmtTime(row.entryTime)}` : ''}` },
              { label: 'Current', value: fmtNumber(row.currentPrice, 2) },
              { label: 'Punkter', value: fmtNumber(row.points, 2), tone: pnlColor(row.points) },
              { label: 'Ticks', value: fmtNumber(row.ticks, 1), tone: pnlColor(row.ticks) },
              { label: 'Live PnL', value: fmtMoney(row.pnl, currency, 2), tone: pnlColor(row.pnl) },
              { label: 'Live PnL %', value: row.pnlPercent == null ? null : fmtPercent(row.pnlPercent, 2), tone: pnlColor(row.pnlPercent) },
              { label: 'R multiple', value: row.rMultiple == null ? null : `${fmtNumber(row.rMultiple, 2)}R`, tone: pnlColor(row.rMultiple) },
              { label: 'Duration', value: fmtAge(durationMs) },
              { label: 'PnL-källa', value: row.pnlComputed ? 'beräknad ur quote' : 'brokerns orealiserade PnL' },
            ]}
          />
        </DetailBlock>

        <DetailBlock title="Skydd" hint="Distance = hur mycket luft som är kvar innan nivån nås.">
          <DetailRows
            rows={[
              { label: 'Stop', value: fmtNumber(row.stopPrice, 2), tone: row.stopPrice == null ? 'var(--danger)' : null },
              { label: 'Take profit', value: fmtNumber(row.takeProfitPrice, 2) },
              { label: 'Distance to stop', value: row.distanceToStop == null ? null : `${fmtNumber(row.distanceToStop, 2)} p · ${fmtNumber(row.distanceToStopTicks, 0)} ticks · ${fmtPercent(row.distanceToStopPercent, 2)}` },
              { label: 'Distance to TP', value: row.distanceToTarget == null ? null : `${fmtNumber(row.distanceToTarget, 2)} p · ${fmtNumber(row.distanceToTargetTicks, 0)} ticks · ${fmtPercent(row.distanceToTargetPercent, 2)}` },
              { label: 'Risk (entry→stop)', value: row.riskPoints == null ? null : `${fmtNumber(row.riskPoints, 2)} p` },
              { label: 'Reward (entry→TP)', value: row.rewardPoints == null ? null : `${fmtNumber(row.rewardPoints, 2)} p` },
              { label: 'Kvar av risk', value: row.stopFraction == null ? null : fmtPercent(row.stopFraction * 100, 0) },
              { label: 'Kvar till target', value: row.targetFraction == null ? null : fmtPercent(row.targetFraction * 100, 0) },
              { label: 'Protection', value: textOrEmpty(position.protectiveOrderStatus) },
            ]}
          />
        </DetailBlock>

        <DetailBlock title="Strategi">
          <DetailRows
            rows={[
              { label: 'Strategi', value: row.strategyName },
              { label: 'strategyId', value: row.strategyId, mono: true },
              { label: 'Familj', value: row.strategyFamily },
              { label: 'Riktning', value: row.direction, tone: directionColor(row.direction) },
              { label: 'Quantity', value: fmtNumber(row.quantity) },
              { label: 'Tick size', value: fmtNumber(row.tickSize, 4) },
              { label: 'Point value', value: fmtNumber(row.pointValue, 2) },
              { label: 'Radkälla', value: row.source === 'open_trade' ? 'öppen trade (ej i broker mirror)' : 'broker mirror' },
            ]}
          />
        </DetailBlock>

        <DetailBlock title="Quote" hint="Samma quote-data som resten av desken använder — ingen egen prenumeration.">
          <DetailRows
            rows={[
              { label: 'Feed', value: freshness.label, tone: freshness.live ? 'var(--success)' : 'var(--warning)' },
              { label: 'Pris', value: fmtNumber(row.currentPrice, 2) },
              { label: 'Bid / Ask', value: hasValue(quote.bid) || hasValue(quote.ask) ? `${fmtNumber(quote.bid, 2)} / ${fmtNumber(quote.ask, 2)}` : null },
              { label: 'Uppdaterad', value: fmtTime(quote.updatedAt || quote.timestamp) },
              { label: 'Local symbol', value: row.localSymbol, mono: true },
              { label: 'conId', value: row.conId, mono: true },
            ]}
          />
        </DetailBlock>

        <DetailBlock title="Broker mirror" hint="Rå positionsrad från reconciliation — samma fält som tidigare låg i tabellen på den här sidan.">
          <DetailRows
            rows={[
              { label: 'Account', value: position.accountMasked },
              { label: 'Expiry', value: position.expiry },
              { label: 'Avg cost', value: fmtNumber(position.averageCost ?? position.avgCost, 2) },
              { label: 'Market price', value: fmtNumber(position.marketPrice, 2) },
              { label: 'Unrealized PnL', value: fmtMoney(position.unrealizedPnl, currency, 2), tone: pnlColor(position.unrealizedPnl) },
              { label: 'Realized PnL', value: fmtMoney(position.realizedPnl, currency, 2), tone: pnlColor(position.realizedPnl) },
              { label: 'Source', value: position.source || position.executionSource },
              { label: 'Reconciled', value: fmtTime(position.reconciliationTimestamp) },
            ]}
          />
        </DetailBlock>

        <DetailBlock title="Identity chain" hint="Samma kedja som backend loggar — signal → candidate → intent → execution → trade.">
          <DetailRows
            mono
            rows={[
              { label: 'signalId', value: row.identity?.signalId },
              { label: 'candidateId', value: row.identity?.candidateId },
              { label: 'lifecycleId', value: row.identity?.lifecycleId },
              { label: 'intentId', value: row.identity?.intentId },
              { label: 'executionId', value: row.identity?.executionId || row.executionId },
              { label: 'tradeId', value: row.identity?.tradeId },
              { label: 'idempotencyKey', value: row.identity?.idempotencyKey },
            ]}
          />
        </DetailBlock>
      </div>

      {/* Order-, execution-, timeline-, replay- och loggningslagren finns redan i
          tradedetaljkortet. Positionen ärver dem i stället för att duplicera dem. */}
      {row.trade ? (
        <TradeDetailCard trade={row.trade} currency={currency} />
      ) : (
        <div style={{ padding: '4px 12px 14px', color: 'var(--muted)', fontSize: 12 }}>
          Ingen matchande trade i journalen — order, executions, timeline och replay-bevis
          visas när intent-loggen har en rad för den här positionen.
        </div>
      )}
    </div>
  );
}

const PositionRow = React.memo(function PositionRow({ row, expanded, onToggle, currency, nowMs }) {
  const durationMs = row.entryMs == null ? row.durationMs : Math.max(0, nowMs - row.entryMs);
  return (
    <>
      <tr
        onClick={() => onToggle(row.key)}
        style={{ cursor: 'pointer', background: expanded ? 'var(--surface-2)' : 'transparent' }}
        data-position-key={row.key}
        data-position-status={row.status}
        data-strategy-id={row.strategyId}
      >
        <td style={{ ...tdStyle, width: 24, color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</td>
        <td style={tdStyle}>
          <StatusBadge tone={row.statusTone} compact>{row.statusDot} {row.statusLabel}</StatusBadge>
        </td>
        <td style={{ ...tdStyle, fontWeight: 800 }} title={textOrEmpty(row.localSymbol)}>{textOrEmpty(row.symbol)}</td>
        <td style={{ ...tdStyle, maxWidth: 190 }} title={row.strategyId}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{textOrEmpty(row.strategyName)}</div>
        </td>
        <td style={{ ...tdStyle, color: 'var(--muted)' }}>{textOrEmpty(row.strategyFamily)}</td>
        <td style={{ ...tdStyle, color: directionColor(row.direction), fontWeight: 800 }}>{textOrEmpty(row.direction)}</td>
        <td style={tdStyle}>{fmtNumber(row.entryPrice, 2)}</td>
        <td style={tdStyle} title={row.quoteFreshness?.label}>
          {fmtNumber(row.currentPrice, 2)}
          {row.quoteFreshness && !row.quoteFreshness.live ? (
            <span style={{ color: 'var(--warning)' }}> *</span>
          ) : null}
        </td>
        <td style={{ ...tdStyle, color: pnlColor(row.pnl), fontWeight: 800 }}>
          {row.pnl == null ? EMPTY_VALUE : fmtMoney(row.pnl, currency, 2)}
        </td>
        <td style={{ ...tdStyle, color: pnlColor(row.pnlPercent) }}>
          {row.pnlPercent == null ? EMPTY_VALUE : fmtPercent(row.pnlPercent, 2)}
        </td>
        <td style={{ ...tdStyle, color: pnlColor(row.ticks) }}>{fmtNumber(row.ticks, 1)}</td>
        <td style={{ ...tdStyle, color: pnlColor(row.rMultiple), fontWeight: 800 }}>
          {row.rMultiple == null ? EMPTY_VALUE : `${fmtNumber(row.rMultiple, 2)}R`}
        </td>
        <td style={tdStyle}>{fmtNumber(row.quantity)}</td>
        <td style={{ ...tdStyle, color: row.stopPrice == null ? 'var(--danger)' : 'var(--text)' }}>
          {row.stopPrice == null ? 'saknas' : fmtNumber(row.stopPrice, 2)}
        </td>
        <td style={tdStyle}>{fmtNumber(row.takeProfitPrice, 2)}</td>
        <td style={tdStyle} title={row.distanceToStopPercent == null ? null : fmtPercent(row.distanceToStopPercent, 2)}>
          <Distance
            points={row.distanceToStop}
            ticks={row.distanceToStopTicks}
            tone={row.status === 'near_stop' ? 'var(--warning)' : null}
          />
        </td>
        <td style={tdStyle} title={row.distanceToTargetPercent == null ? null : fmtPercent(row.distanceToTargetPercent, 2)}>
          <Distance
            points={row.distanceToTarget}
            ticks={row.distanceToTargetTicks}
            tone={row.status === 'near_target' ? 'var(--accent, #3b82f6)' : null}
          />
        </td>
        <td style={tdStyle}>{fmtAge(durationMs)}</td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={COLUMN_COUNT} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
            <PositionDetail row={row} currency={currency} nowMs={nowMs} />
          </td>
        </tr>
      ) : null}
    </>
  );
});

export const PositionDeskPanel = React.memo(function PositionDeskPanel({
  rows = [],
  summary = {},
  currency = 'USD',
  waiting = false,
  action = null,
}) {
  const [expandedKey, setExpandedKey] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Sekundpuls: duration ska röra sig även mellan runtime-hämtningarna. Priser,
  // PnL, ticks, R och avstånd följer med nästa snapshot — ingen ny polling införs.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const toggle = useCallback((key) => {
    setExpandedKey((current) => (current === key ? null : key));
  }, []);

  const averageDuration = useMemo(() => fmtAge(summary.averageDurationMs), [summary.averageDurationMs]);

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <section style={tradingSectionStyle({ borderColor: 'rgba(34,197,94,0.30)' })}>
        <SectionHeader
          eyebrow="Live Trading Desk"
          title="Öppna positioner"
          summary="En rad = en öppen position. Sorterad efter vad som kräver ett beslut först: oskyddad risk, nära stop, nära target. Klicka på en rad för order, executions, identitet och replay."
          action={action}
        />
        {/* Sju små kort — inget kontosaldo, ingen brokerdiagnostik. De svarar bara
            på hur mycket som är ute, hur det går just nu och hur dagen ligger. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <MetricCard
            label="Open positions"
            value={fmtNumber(summary.openPositions)}
            hint={summary.unprotectedPositions ? `${fmtNumber(summary.unprotectedPositions)} utan stop` : null}
            tone={summary.unprotectedPositions ? 'danger' : (summary.openPositions ? 'info' : 'neutral')}
          />
          <MetricCard
            label="Unrealized PnL"
            value={summary.unrealizedPnl == null ? EMPTY_VALUE : fmtMoney(summary.unrealizedPnl, currency, 2)}
            hint="öppna positioner just nu"
            tone={summary.unrealizedPnl == null ? 'neutral' : (summary.unrealizedPnl < 0 ? 'danger' : 'success')}
          />
          <MetricCard
            label="Realized PnL idag"
            value={summary.realizedToday == null ? EMPTY_VALUE : fmtMoney(summary.realizedToday, currency, 2)}
            hint={summary.closedToday ? `${fmtNumber(summary.closedToday)} stängda idag` : 'inga stängda idag'}
            tone={summary.realizedToday == null ? 'neutral' : (summary.realizedToday < 0 ? 'danger' : 'success')}
          />
          <MetricCard
            label="Net PnL idag"
            value={summary.netToday == null ? EMPTY_VALUE : fmtMoney(summary.netToday, currency, 2)}
            hint="realiserat + orealiserat"
            tone={summary.netToday == null ? 'neutral' : (summary.netToday < 0 ? 'danger' : 'success')}
          />
          <MetricCard
            label="Winning positions"
            value={fmtNumber(summary.winningPositions)}
            tone={summary.winningPositions ? 'success' : 'neutral'}
          />
          <MetricCard
            label="Losing positions"
            value={fmtNumber(summary.losingPositions)}
            tone={summary.losingPositions ? 'danger' : 'neutral'}
          />
          <MetricCard
            label="Snitt duration"
            value={averageDuration}
            hint="öppna positioner"
          />
        </div>
      </section>

      <section style={tradingSectionStyle({ padding: 0, overflow: 'hidden' })}>
        {waiting && !rows.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{WAITING_BROKER}</div>
        ) : !rows.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Inga öppna positioner.</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle} aria-label="Expandera" />
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Symbol</th>
                    <th style={thStyle}>Strategi</th>
                    <th style={thStyle}>Familj</th>
                    <th style={thStyle}>L/S</th>
                    <th style={thStyle}>Entry</th>
                    <th style={thStyle}>Current</th>
                    <th style={thStyle}>Live PnL</th>
                    <th style={thStyle}>PnL %</th>
                    <th style={thStyle}>Ticks</th>
                    <th style={thStyle}>R</th>
                    <th style={thStyle}>Qty</th>
                    <th style={thStyle}>Stop</th>
                    <th style={thStyle}>TP</th>
                    <th style={thStyle}>Till stop</th>
                    <th style={thStyle}>Till TP</th>
                    <th style={thStyle}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <PositionRow
                      key={row.key}
                      row={row}
                      expanded={expandedKey === row.key}
                      onToggle={toggle}
                      currency={currency}
                      nowMs={nowMs}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{
              padding: '10px 12px',
              borderTop: '1px solid var(--border)',
              color: 'var(--muted)',
              fontSize: 12,
            }}>
              {fmtNumber(rows.length)} öppna positioner · avstånd visas som punkter · ticks
              {' · '}* = priset kommer inte från en färsk live-quote
            </div>
          </>
        )}
      </section>
    </section>
  );
});

export default PositionDeskPanel;
