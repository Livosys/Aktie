import React from 'react';
import { PipelinePage, Kpis, EmptyNote, useOverview } from './pipelineCommon.jsx';
import { num, safeString } from '../utils/safeRender.js';

// Paper Trading — simulated trading only. No real money, no real orders. Read-only.
export default function PipelinePaperPage() {
  const { data, error, loading, reload } = useOverview();
  const ps = (data && data.paperStatus) || {};
  const sum = ps.summary || {};

  return (
    <PipelinePage
      icon="📝" title="Paper Trading" status={ps.status} loading={loading} error={error} onReload={reload}
      intro="Paper Trading är simulerad handel. Inga riktiga pengar används och inga riktiga order läggs. Broker av · Live trading av · Riktiga order blockerade."
    >
      {data && (
        <>
          <Kpis items={[
            { label: 'Låtsastrades', value: num(ps.count != null ? ps.count : sum.totalTrades) },
            { label: 'Vinst', value: num(sum.win) },
            { label: 'Förlust', value: num(sum.loss) },
            { label: 'Timeout', value: num(sum.timeout) },
            { label: 'winRate', value: sum.winRate != null ? num(sum.winRate, '%') : '—' },
            { label: 'decisiveWinRate', value: sum.decisiveWinRate != null ? num(sum.decisiveWinRate, '%') : '—' },
            { label: 'avgPnl', value: sum.avgPnl != null ? num(sum.avgPnl) : '—' },
            { label: 'Bästa strategi', value: safeString(sum.bestStrategy, '—') },
          ]} />

          <div className="cr-card">
            <h3>Allowlist (vilka strategier får paper-testas)</h3>
            <ul className="cr-list">
              <li><span className="cr-good">Godkända:</span> {num(sum.allowlistApprovedCount)}</li>
              <li><span className="cr-tag">Redo:</span> {num(sum.allowlistReadyCount)}</li>
              <li><span className="cr-tag">Väntar:</span> {num(sum.allowlistPendingCount)}</li>
              <li><span className="cr-bad">Avvisade:</span> {num(sum.allowlistRejectedCount)}</li>
              <li><span className="cr-bad">Blockerade:</span> {num(sum.allowlistBlockedCount)}</li>
            </ul>
          </div>

          {ps.status === 'empty' && <EmptyNote>{safeString(sum.message, 'Det finns inga låtsastester att visa ännu.')}</EmptyNote>}

          <p className="cr-foot">
            Säkerhet: broker_enabled={String(data.broker_enabled)} · live_trading_enabled={String(data.live_trading_enabled)} · can_place_orders={String(data.can_place_orders)}.
          </p>
        </>
      )}
    </PipelinePage>
  );
}
