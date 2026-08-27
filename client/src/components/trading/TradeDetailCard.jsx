import React from 'react';
import {
  EMPTY_VALUE,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { StatusBadge } from './StatusBadge.jsx';

// Detaljkortet är den enda platsen där broker-tekniken visas. Standardvyn ska vara
// enkel; allt som inte hjälper ett beslut i tabellen bor här — men ingenting tas bort.

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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
  const visible = rows.filter((row) => row && row.always !== false);
  if (!visible.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>{EMPTY_VALUE}</div>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {visible.map((row) => (
        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 34%) minmax(0, 1fr)', gap: 8, alignItems: 'baseline' }}>
          <div style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{row.label}</div>
          <div style={{
            color: row.tone === 'muted' ? 'var(--muted)' : 'var(--text)',
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

function IdList({ values = [] }) {
  if (!values.length) return EMPTY_VALUE;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {values.map((value) => (
        <span key={String(value)} style={{
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '1px 5px',
          fontFamily: MONO,
          fontSize: 11.5,
        }}>
          {String(value)}
        </span>
      ))}
    </span>
  );
}

function LegTable({ legs = [], currency }) {
  if (!legs.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Inga orderben i snapshoten.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr>
            {['Leg', 'Order ID', 'Order Ref', 'Type', 'Limit', 'Stop', 'Qty', 'Filled', 'Remaining', 'Avg fill', 'Status', 'Perm ID', 'Fills'].map((label) => (
              <th key={label} style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--muted)', fontWeight: 700, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => (
            <tr key={`${leg.leg}_${leg.orderId ?? leg.orderRef ?? ''}`}>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>{textOrEmpty(leg.leg)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontFamily: MONO }}>{textOrEmpty(leg.orderId)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontFamily: MONO, overflowWrap: 'anywhere' }}>{textOrEmpty(leg.orderRef)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{textOrEmpty(leg.orderType)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.limitPrice, 2)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.stopPrice, 2)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.quantity)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.filled)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.remaining)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{fmtNumber(leg.avgFillPrice, 2)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{textOrEmpty(leg.ibStatus || leg.status)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontFamily: MONO }}>{textOrEmpty(leg.permId)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{leg.fills.length ? fmtNumber(leg.fills.length) : EMPTY_VALUE}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {legs.some((leg) => leg.fills.length) ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 6 }}>Broker fills</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {legs.flatMap((leg) => leg.fills.map((fill) => (
              <div key={fill.execId || `${leg.leg}_${fill.orderId}`} style={{ fontSize: 11.5, fontFamily: MONO, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                {textOrEmpty(leg.leg)} · execId {textOrEmpty(fill.execId)} · order {textOrEmpty(fill.orderId)} · {textOrEmpty(fill.side)} {fmtNumber(fill.quantity)} @ {fmtNumber(fill.fillPrice, 2)} · commission {fmtMoney(fill.commission, fill.commissionCurrency || currency, 2)} · {textOrEmpty(fill.time || fill.receivedAt)}
              </div>
            )))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Timeline({ steps = [] }) {
  if (!steps.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Ingen tidsstämplad brokerhändelse i snapshoten.</div>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {steps.map((step) => (
        <div key={step.key} style={{ display: 'grid', gridTemplateColumns: '10px minmax(96px, 30%) minmax(0, 1fr)', gap: 8, alignItems: 'baseline' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', display: 'inline-block' }} />
          <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{step.label}</span>
          <span style={{ fontSize: 12 }}>
            {fmtTime(step.at)}
            {hasValue(step.detail) ? <span style={{ color: 'var(--muted)' }}> · {String(step.detail)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export const TradeDetailCard = React.memo(function TradeDetailCard({ trade, currency = 'USD' }) {
  if (!trade) return null;
  const identity = trade.identity || {};
  const evidence = trade.evidence || {};
  const strategy = trade.strategy || null;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 10,
      padding: '12px 12px 14px',
      background: 'var(--surface-2)',
      borderLeft: '3px solid var(--accent)',
    }}>
      {/* Ordningen följer abstraktionsnivåerna: trade → order → execution →
          identity → rå brokerdata. Identitetskedjan är felsökning, inte det
          första en användare ska mötas av när hen öppnar en trade. */}
      <DetailBlock title="Result" hint="IBKR:s realiserade PnL är netto efter courtage; brutto visas som netto + avgifter.">
        <DetailRows
          rows={[
            { label: 'Entry', value: `${fmtNumber(trade.entryPrice, 2)}${trade.entryTime ? ` · ${fmtTime(trade.entryTime)}` : ''}` },
            { label: 'Exit', value: `${fmtNumber(trade.exitPrice, 2)}${trade.exitTime ? ` · ${fmtTime(trade.exitTime)}` : ''}` },
            { label: 'Stop', value: fmtNumber(trade.stopPrice, 2) },
            { label: 'Take profit', value: fmtNumber(trade.takeProfitPrice, 2) },
            { label: 'Quantity', value: fmtNumber(trade.quantity) },
            { label: 'Duration', value: fmtAge(trade.durationMs) },
            { label: 'Gross PnL', value: fmtMoney(trade.grossPnl, trade.grossPnlCurrency || currency, 2) },
            { label: 'Commission', value: fmtMoney(trade.commission, trade.commissionCurrency || currency, 2) },
            { label: 'Net PnL', value: fmtMoney(trade.netPnl, trade.netPnlCurrency || currency, 2) },
            { label: 'Unrealized PnL', value: fmtMoney(trade.unrealizedPnl, trade.unrealizedPnlCurrency || currency, 2) },
            { label: 'Broker time entry', value: evidence.entryExecutionTime, mono: true },
            { label: 'Broker time exit', value: evidence.filledExecutionTime, mono: true },
          ]}
        />
      </DetailBlock>

      <DetailBlock title="Strategy">
        <DetailRows
          rows={[
            { label: 'Strategy', value: trade.strategyName },
            { label: 'strategyId', value: trade.strategyId, mono: true },
            { label: 'Family', value: trade.strategyFamily },
            { label: 'Signal', value: strategy?.signal || strategy?.signalType },
            { label: 'Signal time', value: fmtTime(trade.signalTimestamp) },
            { label: 'Entry reason', value: strategy?.entryReason },
            { label: 'Exit reason', value: trade.exitReason, tone: 'muted' },
            { label: 'Filled leg', value: trade.filledLeg },
            { label: 'Risk state', value: strategy?.riskState },
            { label: 'Risk/Reward', value: strategy?.riskReward },
            { label: 'Market regime', value: strategy?.marketRegime },
            { label: 'Approval', value: strategy?.approvalState },
          ]}
        />
      </DetailBlock>

      {/* Nivå 3–4: orderplanen och de faktiska fillsen. */}
      <div style={{ gridColumn: '1 / -1' }}>
        <DetailBlock title="Legs (entry, stop, take profit) och broker fills">
          <LegTable legs={trade.legs} currency={currency} />
        </DetailBlock>
      </div>

      <DetailBlock title="Broker timeline">
        <Timeline steps={trade.timeline} />
      </DetailBlock>

      {/* Nivå 5: identitet och diagnostik — sist. */}
      <DetailBlock title="Identity" hint="Samma identitetskedja som backend loggar — signal → candidate → intent → execution → trade.">
        <DetailRows
          mono
          rows={[
            { label: 'signalId', value: identity.signalId },
            { label: 'candidateId', value: identity.candidateId },
            { label: 'lifecycleId', value: identity.lifecycleId },
            { label: 'intentId', value: identity.intentId },
            { label: 'executionId', value: identity.executionId },
            { label: 'tradeId', value: identity.tradeId },
            { label: 'idempotencyKey', value: identity.idempotencyKey },
          ]}
        />
      </DetailBlock>

      <DetailBlock title="Broker" hint={`Konto ${textOrEmpty(trade.accountMasked)} · ${textOrEmpty(trade.broker)}`}>
        <DetailRows
          rows={[
            { label: 'Order IDs', value: <IdList values={trade.brokerOrderIds} /> },
            { label: 'Perm IDs', value: <IdList values={trade.permIds} /> },
            { label: 'Execution IDs', value: <IdList values={trade.execIds} /> },
            { label: 'Order refs', value: <IdList values={trade.orderRefs} /> },
            { label: 'conId', value: trade.conId, mono: true },
            { label: 'Local symbol', value: trade.localSymbol, mono: true },
            { label: 'Execution target', value: trade.executionTarget },
            { label: 'Source', value: trade.source },
          ]}
        />
      </DetailBlock>

      <DetailBlock title="Reconciliation & replay" hint="Fingerprints och migrationsspår används av reconciliation och replay — de visas här i stället för på varje rad.">
        <DetailRows
          rows={[
            { label: 'Intent status', value: trade.intentStatus },
            { label: 'Execution', value: <StatusBadge tone={trade.statusTone} compact>{trade.executionState}</StatusBadge> },
            { label: 'Reconciliation krävs', value: evidence.reconciliationRequired ? 'ja' : 'nej' },
            { label: 'Contract fingerprint', value: evidence.contractFingerprint, mono: true },
            { label: 'Evidence fingerprint', value: evidence.evidenceFingerprint, mono: true },
            { label: 'Identity status', value: evidence.identityStatus },
            { label: 'Migration', value: evidence.migrationVersion ? `${evidence.migrationVersion} · ${textOrEmpty(evidence.migrationSource)} · ${fmtTime(evidence.migratedAt)}` : null },
            { label: 'Resolved by', value: evidence.resolvedBy ? `${evidence.resolvedBy} · ${fmtTime(evidence.resolvedAt)}` : null },
            { label: 'Previous status', value: evidence.previousStatus },
            { label: 'Repair', value: evidence.repairNote ? `${evidence.repairNote} · ${fmtTime(evidence.repairedAt)}` : null },
            { label: 'Blocker', value: evidence.blocker },
            { label: 'IB error', value: evidence.ibErrorCode ? `${evidence.ibErrorCode} · ${textOrEmpty(evidence.ibErrorMessage)}` : null },
            { label: 'Protective cancel', value: evidence.protectiveOrderCancelledId ? `${evidence.protectiveOrderCancelledId} · ${textOrEmpty(evidence.protectiveOrderCancelReason)}` : null },
            { label: 'Rejected reason', value: evidence.rejectedReason },
            { label: 'Cancel reason', value: evidence.cancelReason },
          ]}
        />
      </DetailBlock>
    </div>
  );
});
