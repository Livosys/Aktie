import React from 'react';
import {
  ActivityList,
  BarChart,
  ChartCard,
  LineChart,
} from '../dashboard/DashboardKit.jsx';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { MetricCard } from './MetricCard.jsx';
import { SectionHeader, tradingSectionStyle } from './OverviewPanel.jsx';
import { StatusRail } from './StatusBadge.jsx';

// Trading Dashboard — startsidan. Fyra block, i den ordning en trader läser dem:
// dagens siffror, lever kedjan, hur ser dagen ut, vad har hänt senast.
//
// Broker runtime snapshot, execution control, broker mirror, runtime pulse och
// pipeline-korten är flyttade till Runtime. De beskriver systemet; den här sidan
// beskriver handeln.
//
// Graferna använder appens egna chart-primitiver ur DashboardKit — ingen ny
// grafmotor, inget nytt bibliotek.

function pnlTone(value) {
  if (value == null) return 'neutral';
  if (value < 0) return 'danger';
  if (value > 0) return 'success';
  return 'neutral';
}

function clockTime(ms) {
  if (ms == null) return EMPTY_VALUE;
  return new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function moneyOrEmpty(value, currency) {
  return value == null ? EMPTY_VALUE : fmtMoney(value, currency, 2);
}

function statusRailItems(indicators = []) {
  return indicators.map((indicator) => ({
    label: indicator.label,
    tone: indicator.tone,
    value: indicator.key === 'last_scan'
      ? (indicator.ageMs == null ? EMPTY_VALUE : `${fmtAge(indicator.ageMs)} sedan`)
      : `${indicator.value}${indicator.hint ? ` · ${indicator.hint}` : ''}`,
  }));
}

function tradeItems(rows = [], currency) {
  return rows.map((row) => {
    const pnl = row.closed ? row.netPnl : row.unrealizedPnl;
    return {
      id: row.id,
      tone: row.tone,
      title: `${textOrEmpty(row.symbol)}${hasValue(row.direction) ? ` ${row.direction}` : ''}`,
      meta: [
        textOrEmpty(row.strategyName),
        `${row.statusDot || ''} ${textOrEmpty(row.statusLabel)}`.trim(),
        pnl == null ? null : `${fmtMoney(pnl, currency, 2)}${row.closed ? '' : '*'}`,
      ].filter(hasValue).join(' · '),
      time: clockTime(row.at),
    };
  });
}

function scannerItems(rows = []) {
  return rows.map((row) => ({
    id: row.id,
    tone: row.tone,
    title: row.candidates == null
      ? 'Scan'
      : `${fmtNumber(row.candidates)} kandidater`,
    meta: [
      row.signalsRead == null ? null : `${fmtNumber(row.signalsRead)} OS-signaler`,
      textOrEmpty(row.status) === EMPTY_VALUE ? null : row.status,
      row.executionTarget,
    ].filter(hasValue).join(' · '),
    time: row.ageMs == null ? clockTime(row.at) : fmtAge(row.ageMs),
  }));
}

function positionItems(rows = [], currency) {
  return rows.map((row) => ({
    id: row.id,
    tone: row.tone,
    title: `${textOrEmpty(row.symbol)}${hasValue(row.direction) ? ` ${row.direction}` : ''}${row.quantity == null ? '' : ` × ${fmtNumber(row.quantity)}`}`,
    meta: [
      textOrEmpty(row.strategyName),
      `${row.statusDot || ''} ${textOrEmpty(row.statusLabel)}`.trim(),
      row.pnl == null ? null : fmtMoney(row.pnl, currency, 2),
    ].filter(hasValue).join(' · '),
    time: row.at == null ? EMPTY_VALUE : clockTime(row.at),
  }));
}

export const TradingDashboardPanel = React.memo(function TradingDashboardPanel({
  summary = {},
  marketStatus = {},
  equityPoints = [],
  pnlBars = [],
  activity = {},
  currency = 'USD',
  waiting = false,
  action = null,
}) {
  const equityEnd = equityPoints.length ? equityPoints[equityPoints.length - 1].value : null;
  const chartBars = pnlBars.map((bar) => ({
    label: `${textOrEmpty(bar.label)} ${clockTime(bar.at)}`,
    value: bar.value,
    tone: bar.tone,
    display: moneyOrEmpty(bar.value, currency),
  }));

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <section style={tradingSectionStyle({ borderColor: 'rgba(59,130,246,0.30)' })}>
        <SectionHeader
          eyebrow="Trading Dashboard"
          title="Hur går det idag"
          summary="Dagens resultat, öppen risk och om kedjan marknad → scanner → broker → quotes lever. Siffrorna räknas ur samma trades som Trades och Analytics visar."
          action={action}
        />
        {/* Sex kort. Net, gross och courtage hör ihop aritmetiskt och redovisas
            på stängda trades; det som fortfarande står ute ligger som hint. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <MetricCard
            label="Trades idag"
            value={fmtNumber(summary.tradesToday)}
            hint={`${fmtNumber(summary.closedToday)} stängda · ${fmtNumber(summary.openTrades)} öppna`}
            tone={summary.tradesToday ? 'info' : 'neutral'}
          />
          <MetricCard
            label="Öppna positioner"
            value={fmtNumber(summary.openPositions)}
            hint={summary.unprotectedPositions ? `${fmtNumber(summary.unprotectedPositions)} utan stop` : null}
            tone={summary.unprotectedPositions ? 'danger' : (summary.openPositions ? 'info' : 'neutral')}
          />
          <MetricCard
            label="Net PnL idag"
            value={moneyOrEmpty(summary.netPnl, currency)}
            hint={summary.unrealizedPnl == null
              ? 'realiserat idag'
              : `orealiserat ${fmtMoney(summary.unrealizedPnl, currency, 2)} · totalt ${fmtMoney(summary.netToday, currency, 2)}`}
            tone={pnlTone(summary.netPnl)}
          />
          <MetricCard
            label="Gross PnL idag"
            value={moneyOrEmpty(summary.grossPnl, currency)}
            hint="före courtage"
            tone={pnlTone(summary.grossPnl)}
          />
          <MetricCard
            label="Courtage idag"
            value={moneyOrEmpty(summary.commission, currency)}
            hint="stängda trades"
            tone={summary.commission ? 'warning' : 'neutral'}
          />
          <MetricCard
            label="Win rate"
            value={summary.winRate == null ? EMPTY_VALUE : fmtPercent(summary.winRate, 1)}
            hint={`${fmtNumber(summary.wins)} W · ${fmtNumber(summary.losses)} L`}
            tone={summary.winRate == null ? 'neutral' : (summary.winRate >= 50 ? 'success' : 'warning')}
          />
        </div>
      </section>

      {/* Marknadsläget som en rad, inte som kort: fem värden som ska gå att svepa
          över på en sekund. Okänt är okänt — aldrig grönt. */}
      <section style={tradingSectionStyle({ padding: 12 })}>
        <StatusRail items={statusRailItems(marketStatus.indicators)} />
        {waiting ? (
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>{WAITING_BROKER}</div>
        ) : null}
      </section>

      <div className="dash-grid-2">
        <ChartCard
          title="Equity idag"
          subtitle="Kumulativ realiserad PnL sedan dagens start"
          tone={equityEnd == null ? 'neutral' : (equityEnd < 0 ? 'warning' : 'good')}
        >
          <LineChart
            points={equityPoints}
            height={130}
            stroke={equityEnd != null && equityEnd < 0 ? 'var(--danger)' : 'var(--success)'}
            emptyText="Inga stängda trades idag."
          />
        </ChartCard>
        <ChartCard title="PnL idag" subtitle="En stapel per stängd trade">
          <BarChart bars={chartBars} height={130} emptyText="Inga stängda trades idag." />
        </ChartCard>
      </div>

      <div className="dash-grid-3">
        <ChartCard title="Senaste trades" subtitle="* = orealiserad PnL på öppen trade">
          <ActivityList
            items={tradeItems(activity.trades, currency)}
            emptyText={waiting ? WAITING_BROKER : 'Inga trades ännu.'}
          />
        </ChartCard>
        <ChartCard title="Senaste scanner-event" subtitle="Svep från scanmotorn">
          <ActivityList
            items={scannerItems(activity.scannerEvents)}
            emptyText={waiting ? WAITING_BROKER : 'Inga scans ännu.'}
          />
        </ChartCard>
        <ChartCard title="Senaste positioner" subtitle="Öppna positioner, senast öppnad först">
          <ActivityList
            items={positionItems(activity.positions, currency)}
            emptyText={waiting ? WAITING_BROKER : 'Inga öppna positioner.'}
          />
        </ChartCard>
      </div>
    </section>
  );
});

export default TradingDashboardPanel;
