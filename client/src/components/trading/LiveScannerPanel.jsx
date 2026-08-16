import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtAge,
  fmtNumber,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import {
  EMPTY_SCANNER_FILTERS,
  SCANNER_STATUS_FILTERS,
  filterScannerRows,
  scannerFilterOptions,
} from '../../domain/ScannerDomain.js';
import { MetricCard } from './MetricCard.jsx';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';
import { StatusBadge } from './StatusBadge.jsx';

// Live Scanner är en radar, inte en rapport. En rad = en marknad som en strategi
// bevakar. Allt som inte hjälper användaren att se vad som är på väg att hända
// ligger bakom expand.

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

const COLUMN_COUNT = 12;

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={{ color: 'var(--muted)', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

function directionColor(direction) {
  const text = String(direction || '').toUpperCase();
  if (text.includes('SHORT') || text === 'SELL') return 'var(--danger)';
  if (text.includes('LONG') || text === 'BUY') return 'var(--success)';
  return 'var(--text)';
}

// Signalstyrka kommer som 0–1 från vissa producenter och 0–100 från andra.
// Stapeln normaliserar utan att ändra det visade värdet.
function strengthFraction(value) {
  if (value == null) return null;
  const fraction = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, fraction));
}

function StrengthBar({ value }) {
  const fraction = strengthFraction(value);
  if (fraction == null) return <span>{EMPTY_VALUE}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 44, height: 5, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
        <span style={{
          display: 'block',
          width: `${fraction * 100}%`,
          height: '100%',
          background: fraction >= 0.66 ? 'var(--success)' : (fraction >= 0.33 ? 'var(--warning)' : 'var(--muted)'),
        }}
        />
      </span>
      <span>{fmtNumber(value, 2)}</span>
    </span>
  );
}

// Nästa svep är det enda värdet på sidan som rör sig av sig självt mellan
// hämtningar — därför tickar den lokalt i stället för att vänta på nästa poll.
function NextScan({ at, nowMs }) {
  if (at == null) return <span style={{ color: 'var(--muted)' }}>{EMPTY_VALUE}</span>;
  const remaining = at - nowMs;
  if (remaining <= 0) return <span style={{ color: 'var(--success)' }}>nu</span>;
  const seconds = Math.round(remaining / 1000);
  return <span>om {seconds}s</span>;
}

function DetailBlock({ title, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        color: 'var(--muted)',
        fontSize: 10.5,
        fontWeight: 800,
        textTransform: 'uppercase',
        marginBottom: 6,
      }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function TagList({ items, tone = 'neutral', empty = 'Inga' }) {
  if (!items || !items.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>{empty}</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((item) => (
        <StatusBadge key={item} tone={tone} compact>{item}</StatusBadge>
      ))}
    </div>
  );
}

function PairList({ items, empty }) {
  if (!items || !items.length) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {items.map(({ label, value }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
          <span style={{ color: 'var(--muted)' }}>{label}</span>
          <span style={{ fontWeight: 700 }}>{typeof value === 'boolean' ? (value ? 'Ja' : 'Nej') : textOrEmpty(value)}</span>
        </div>
      ))}
    </div>
  );
}

function ScannerDetail({ row, scanHistory }) {
  const research = row.research || {};
  const canonical = row.canonicalCandidate || {};
  // Scanner-timeline: bara de svep som faktiskt rör den här strategin visas som
  // träff, resten som kontext.
  const timeline = scanHistory.slice(0, 8);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
      gap: 16,
      padding: 16,
      background: 'var(--surface-2)',
    }}
    >
      <DetailBlock title="Indikatorvärden">
        <PairList items={row.indicators} empty="Kandidaten bär inga indikatorfält." />
      </DetailBlock>

      <DetailBlock title="Uppfyllda villkor">
        <TagList items={row.conditions?.met} tone="success" empty="Inga uppfyllda villkor rapporterade." />
      </DetailBlock>

      <DetailBlock title="Saknade villkor">
        <TagList items={row.conditions?.missing} tone="warning" empty="Inga saknade villkor." />
        {row.conditions?.blockedReason ? (
          <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
            Blockerare: <span style={{ color: 'var(--warning)' }}>{row.conditions.blockedReason}</span>
          </div>
        ) : null}
        {row.conditions?.warnings?.length ? (
          <div style={{ marginTop: 8 }}>
            <TagList items={row.conditions.warnings} tone="warning" />
          </div>
        ) : null}
      </DetailBlock>

      <DetailBlock title="Canonical candidate">
        <PairList
          items={[
            { label: 'Candidate', value: row.candidateId },
            { label: 'Verdict', value: row.canonicalVerdict },
            { label: 'Reason', value: canonical.reasonCode },
            { label: 'Producer', value: canonical.producerType },
            { label: 'Policy', value: canonical.policyId },
            { label: 'Entry contract', value: row.entryContractStatus },
          ]}
          empty="Ingen canonical readiness."
        />
      </DetailBlock>

      <DetailBlock title="Senaste signal">
        <PairList
          items={[
            { label: 'Signal', value: row.latestSignal },
            { label: 'Direction', value: row.direction },
            { label: 'Market regime', value: row.marketRegime },
            { label: 'Session', value: row.session },
            { label: 'Session tillåten', value: row.sessionAllowed },
            { label: 'Tidpunkt', value: row.lastScanAt == null ? null : fmtTime(new Date(row.lastScanAt).toISOString()) },
          ]}
          empty="Ingen signal."
        />
      </DetailBlock>

      <DetailBlock title="Research">
        <PairList
          items={[
            { label: 'Timeout rate', value: research.timeoutRate == null ? null : fmtNumber(research.timeoutRate, 2) },
            { label: 'Avg MFE', value: research.avgMfe == null ? null : fmtNumber(research.avgMfe, 2) },
            { label: 'Avg MAE', value: research.avgMae == null ? null : fmtNumber(research.avgMae, 2) },
            { label: 'Contract candidates', value: research.entryContractCandidateCount },
            { label: 'Contract pass', value: research.entryContractPassCount },
            { label: 'Contract block', value: research.entryContractBlockCount },
          ]}
          empty="Ingen research-data."
        />
      </DetailBlock>

      <DetailBlock title="Scanner timeline">
        {timeline.length ? (
          <div style={{ display: 'grid', gap: 4 }}>
            {timeline.map((entry, index) => (
              <div key={entry.scanId || index} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--muted)' }}>{fmtTime(entry.startedAt)}</span>
                <span>{fmtNumber(entry.candidatesCreated)} kandidater</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>Inga scans ännu.</div>
        )}
      </DetailBlock>
    </div>
  );
}

const ScannerRow = React.memo(function ScannerRow({ row, expanded, onToggle, nowMs, scanHistory }) {
  return (
    <>
      <tr
        onClick={() => onToggle(row.key)}
        style={{ cursor: 'pointer', background: expanded ? 'var(--surface-2)' : 'transparent' }}
        data-strategy-id={row.strategyId}
        data-scanner-status={row.status}
      >
        <td style={{ ...tdStyle, width: 24, color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</td>
        <td style={{ ...tdStyle, fontWeight: 800 }}>{textOrEmpty(row.symbol)}</td>
        <td style={{ ...tdStyle, maxWidth: 220 }} title={row.strategyId}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{textOrEmpty(row.strategyName)}</div>
        </td>
        <td style={{ ...tdStyle, color: 'var(--muted)' }}>{textOrEmpty(row.strategyFamily)}</td>
        <td style={tdStyle}>
          <StatusBadge tone={row.statusTone} compact>{row.statusDot} {row.statusLabel}</StatusBadge>
        </td>
        <td style={{ ...tdStyle, color: directionColor(row.direction), fontWeight: 800 }}>
          {textOrEmpty(row.direction)}
        </td>
        <td style={tdStyle}>{row.score == null ? EMPTY_VALUE : fmtNumber(row.score, 1)}</td>
        <td style={tdStyle}><StrengthBar value={row.signalStrength} /></td>
        <td style={tdStyle} title={row.lastScanAt == null ? null : fmtTime(new Date(row.lastScanAt).toISOString())}>
          {row.lastScanAt == null ? EMPTY_VALUE : fmtAge(nowMs - row.lastScanAt)}
        </td>
        <td style={{ ...tdStyle, color: 'var(--muted)' }}><NextScan at={row.nextScanAt} nowMs={nowMs} /></td>
        <td style={tdStyle} title={row.candidateId}>
          {row.candidateId
            ? <StatusBadge tone="info" compact>{String(row.candidateId).slice(0, 10)}</StatusBadge>
            : EMPTY_VALUE}
        </td>
        <td style={tdStyle}>
          {row.position ? (
            <span style={{ color: directionColor(row.position.direction), fontWeight: 800 }}>
              {textOrEmpty(row.position.direction)} {row.position.quantity == null ? '' : fmtNumber(row.position.quantity)}
            </span>
          ) : EMPTY_VALUE}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={COLUMN_COUNT} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
            <ScannerDetail row={row} scanHistory={scanHistory} />
          </td>
        </tr>
      ) : null}
    </>
  );
});

export const LiveScannerPanel = React.memo(function LiveScannerPanel({
  rows = [],
  summary = {},
  scanHistory = [],
  scannerConnected = null,
  waiting = false,
  action = null,
}) {
  const [filters, setFilters] = useState(EMPTY_SCANNER_FILTERS);
  const [expandedKey, setExpandedKey] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Radarn har en egen sekundpuls så att "senaste scan" och nedräkningen till
  // nästa svep rör sig även mellan runtime-hämtningarna. Den läser bara klockan.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const options = useMemo(() => scannerFilterOptions(rows), [rows]);
  const filtered = useMemo(() => filterScannerRows(rows, filters), [filters, rows]);

  const update = useCallback((patch) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const toggle = useCallback((key) => {
    setExpandedKey((current) => (current === key ? null : key));
  }, []);

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <section style={tradingSectionStyle({ borderColor: 'rgba(34,197,94,0.30)' })}>
        <SectionHeader
          eyebrow="Live Scanner"
          title="Vad scannas just nu"
          summary="En rad = en marknad som en strategi bevakar. Sorterad efter hur nära entry raden är. Klicka på en rad för indikatorer, villkor och canonical candidate."
          action={action}
        />
        {/* Sex kort, inget mer: de svarar på radarns egna frågor och upprepar
            varken kontosaldo, broker mirror eller runtime-tillstånd. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <MetricCard
            label="Scanning symbols"
            value={fmtNumber(summary.scanningSymbols)}
            tone={summary.scanningSymbols ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Active strategies"
            value={fmtNumber(summary.activeStrategies)}
            hint={summary.totalRows ? `${fmtNumber(summary.activeRows)} av ${fmtNumber(summary.totalRows)} rader` : null}
            tone={summary.activeStrategies ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Candidates"
            value={fmtNumber(summary.candidates)}
            tone={summary.candidates ? 'success' : 'neutral'}
          />
          <MetricCard
            label="Open positions"
            value={fmtNumber(summary.openPositions)}
            tone={summary.openPositions ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Signals today"
            value={fmtNumber(summary.signalsToday)}
            tone={summary.signalsToday ? 'success' : 'neutral'}
          />
          <MetricCard
            label="Latest scan"
            value={summary.latestScanAt ? fmtAge(nowMs - new Date(summary.latestScanAt).getTime()) : EMPTY_VALUE}
            hint={hasValue(scannerConnected) ? (scannerConnected ? 'scanner ansluten' : 'scanner frånkopplad') : null}
            tone={scannerConnected === false ? 'danger' : (summary.latestScanAt ? 'success' : 'neutral')}
          />
        </div>
      </section>

      <section style={tradingSectionStyle({ padding: 12 })}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, alignItems: 'end' }}>
          <Field label="Status">
            <select style={selectStyle} value={filters.status} onChange={(event) => update({ status: event.target.value })}>
              {SCANNER_STATUS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="Marknad">
            <select style={selectStyle} value={filters.symbol} onChange={(event) => update({ symbol: event.target.value })}>
              <option value="all">Alla</option>
              {options.symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </Field>
          <Field label="Familj">
            <select style={selectStyle} value={filters.family} onChange={(event) => update({ family: event.target.value })}>
              <option value="all">Alla</option>
              {options.families.map((family) => <option key={family} value={family}>{family}</option>)}
            </select>
          </Field>
          <Field label="Sök">
            <input
              type="search"
              placeholder="strategi, marknad eller candidate"
              style={selectStyle}
              value={filters.search}
              onChange={(event) => update({ search: event.target.value })}
            />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
            <input
              type="checkbox"
              checked={filters.activeOnly}
              onChange={(event) => update({ activeOnly: event.target.checked })}
            />
            {/* Blockerade strategier är inte på radarn — de går att ta fram, men
                de ska inte skymma det som faktiskt scannas. */}
            <span>Dölj blockerade</span>
          </label>
          <button type="button" className="btn" onClick={() => setFilters(EMPTY_SCANNER_FILTERS)}>Rensa filter</button>
        </div>
      </section>

      <section style={tradingSectionStyle({ padding: 0, overflow: 'hidden' })}>
        {waiting && !rows.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{WAITING_BROKER}</div>
        ) : !filtered.length ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
            {rows.length ? 'Inga rader matchar filtret.' : 'Inga strategier scannar just nu.'}
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle} aria-label="Expandera" />
                    <th style={thStyle}>Symbol</th>
                    <th style={thStyle}>Strategi</th>
                    <th style={thStyle}>Familj</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Direction</th>
                    <th style={thStyle}>Score</th>
                    <th style={thStyle}>Signal strength</th>
                    <th style={thStyle}>Senaste scan</th>
                    <th style={thStyle}>Nästa scan</th>
                    <th style={thStyle}>Candidate</th>
                    <th style={thStyle}>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <ScannerRow
                      key={row.key}
                      row={row}
                      expanded={expandedKey === row.key}
                      onToggle={toggle}
                      nowMs={nowMs}
                      scanHistory={scanHistory}
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
            }}
            >
              Visar {fmtNumber(filtered.length)} av {fmtNumber(rows.length)} rader
              {filters.activeOnly && rows.length !== summary.activeRows ? ' · blockerade dolda' : ''}
            </div>
          </>
        )}
      </section>
    </section>
  );
});

export default LiveScannerPanel;
