import React, { useEffect, useState } from 'react';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import {
  FACTORY_TERM_KEYS,
  uiCopy,
  uiDescription,
  uiFactoryAction,
  uiFactoryGap,
  uiName,
  uiPanelHelpItems,
} from '../../services/uiTerminologyService.js';

// ── Strategy Brain på Strategy Dashboard ────────────────────────────────────
//
// Ingen ny sida. Panelen ligger på den flik där strategierna redan visas och
// använder samma OverviewPanel och FieldGrid som de nio andra.
//
// Den hämtar SJÄLV, och det är ett medvetet undantag från sidans mönster där
// allt kommer ur runtime-snapshoten: hjärnans analys bygger DNA-katalogen ur
// marknadsdatalagret och kostar ~400 ms. Att lägga den i runtime hade gjort
// varje poll fyra gånger dyrare, och en tung läsning i den vägen har frusit
// event-loopen förut. Den hämtas därför en gång, när fliken öppnas.
//
// Panelen visar det hjärnan är till för: var kunskapen SAKNAS, inte vilken
// strategi som råkar ha bäst siffror.

const ACTION_TONE = {
  re_test: 'blue',
  optimize: 'warning',
  paper: 'success',
  live_candidate: 'success',
  retire: 'muted',
  wait: 'muted',
};

function scoreText(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 100) / 100) : '—';
}

export const StrategyBrainPanel = React.memo(function StrategyBrainPanel({ strategyId = null }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const panel = uiCopy('strategyBrainPanel');
  const panelHelp = uiPanelHelpItems(FACTORY_TERM_KEYS.STRATEGY_BRAIN);
  const eyebrow = uiName(FACTORY_TERM_KEYS.STRATEGY_BRAIN);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetch('/api/strategy-brain', { credentials: 'include', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`API ${res.status}`))))
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, data }); })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setState({ loading: false, error: err.message, data: null });
      });
    return () => { cancelled = true; controller.abort(); };
  }, []);

  if (state.loading) {
    return (
      <OverviewPanel eyebrow={eyebrow} title={panel.titles.loading} summary={panel.messages.loading}>
        <FieldGrid items={panelHelp} />
      </OverviewPanel>
    );
  }

  if (state.error || !state.data?.ok) {
    return (
      <OverviewPanel eyebrow={eyebrow} title={panel.titles.error} summary={panel.messages.errorSuffix}>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          {panel.messages.errorPrefix} ({state.error || panel.messages.errorUnknown}).
        </div>
      </OverviewPanel>
    );
  }

  const { data } = state;
  const rows = data.strategies || [];
  const row = strategyId ? rows.find((entry) => entry.strategyId === strategyId) : null;
  const next = data.nextReplay;

  // Utan vald strategi: systemets bild. Med vald strategi: dess kunskapsläge.
  const items = row ? [
    {
      label: panel.labels.recommendation,
      value: uiFactoryAction(row.recommendation.action) || row.recommendation.action,
      tone: ACTION_TONE[row.recommendation.action] || 'muted',
      hint: row.recommendation.motivation,
    },
    {
      label: panel.labels.knowledgeScore,
      value: scoreText(row.knowledgeScore),
      tone: row.knowledgeScore >= 80 ? 'success' : row.knowledgeScore >= 50 ? 'blue' : 'warning',
      hint: panel.hints.knowledgeScore,
    },
    {
      label: panel.labels.confidence,
      value: scoreText(row.confidenceScore),
      hint: panel.hints.confidence,
    },
    {
      label: panel.labels.coverage,
      value: row.regimesTested.length
        ? `${row.regimesTested.length} ${panel.messages.of} ${data.market.availableRegimes.length}`
        : panel.messages.noRegime,
      tone: row.blindSpots.length === 0 ? 'success' : 'warning',
      hint: row.blindSpots.length
        ? `${uiName(FACTORY_TERM_KEYS.BLIND_SPOTS)}: ${row.blindSpots.join(', ')}`
        : panel.messages.allRegimesTried,
    },
    ...row.gaps.slice(0, 3).map((gap) => ({
      label: uiFactoryGap(gap.type) || gap.type,
      value: `${gap.informationValue}`,
      tone: 'warning',
      hint: JSON.stringify(gap.detail),
    })),
    ...panelHelp,
  ] : [
    {
      label: panel.labels.nextReplay,
      value: next ? next.strategyId : panel.messages.noReplay,
      tone: next ? 'blue' : 'muted',
      hint: next ? next.motivation : panel.messages.allKnown,
    },
    {
      label: panel.labels.targetRegime,
      value: next?.targetRegime || '—',
      hint: next ? `${panel.hints.informationValue} ${next.informationGain}` : null,
    },
    {
      label: panel.labels.marketRegimes,
      value: `${data.market.availableRegimes.length}`,
      hint: data.market.untestedByAnyone?.length
        ? `${panel.hints.noStrategyHasSeen}: ${data.market.untestedByAnyone.join(', ')}`
        : panel.messages.everyRegimeSeen,
      tone: data.market.untestedByAnyone?.length ? 'warning' : 'success',
    },
    {
      label: panel.labels.aiMemory,
      value: `${data.memory?.experiments ?? 0}`,
      hint: data.memory?.repeats
        ? `${data.memory.repeats} ${panel.messages.repeatsWarning}`
        : panel.messages.noRepeats,
      tone: data.memory?.repeats ? 'warning' : 'success',
    },
    ...Object.entries(data.recommendations || {}).map(([action, ids]) => ({
      label: uiFactoryAction(action) || action,
      value: String(ids.length),
      tone: ACTION_TONE[action] || 'muted',
      hint: ids.join(', '),
    })),
    ...panelHelp,
  ];

  return (
    <OverviewPanel
      eyebrow={eyebrow}
      title={row ? panel.titles.strategy : panel.titles.system}
      summary={uiDescription(FACTORY_TERM_KEYS.STRATEGY_BRAIN)}
    >
      <FieldGrid items={items} />
    </OverviewPanel>
  );
});
