import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import {
  FACTORY_TERM_KEYS,
  uiCopy,
  uiDescription,
  uiLifecycleStage,
  uiName,
  uiPanelHelpItems,
} from '../../services/uiTerminologyService.js';

// ── Strategy Library i strategilådan ────────────────────────────────────────
//
// Ingen ny sida och ingen ny hämtning. Backend hänger biblioteksfälten på den
// översiktsrad som redan bygger den här vyn, så panelen är ännu en panel bland
// de nio som redan ligger i lådan — byggd av samma OverviewPanel och FieldGrid.
//
// Fyra frågor besvaras: var i livet strategin är, hur mycket vi vet om den,
// om den får gå vidare, och om den bör pensioneras.

const STAGE_TONE = {
  draft: 'muted',
  testing: 'blue',
  learning: 'blue',
  candidate: 'warning',
  paper: 'warning',
  monitoring: 'warning',
  approved: 'success',
  live: 'success',
  retired: 'muted',
};

const PROMOTION_TONE = {
  ready: 'success',
  blocked: 'muted',
  terminal: 'blue',
  retired: 'muted',
  not_in_library: 'warning',
};

const RETIREMENT_TONE = {
  active: 'success',
  suggested: 'warning',
  retired: 'muted',
  unknown: 'muted',
};

function scoreText(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 100) / 100) : '—';
}

export const StrategyLifecyclePanel = React.memo(function StrategyLifecyclePanel({ strategy }) {
  const library = strategy?.library;
  if (!library || library.inLibrary === false) return null;

  const panel = uiCopy('strategyLifecyclePanel');
  const panelHelp = uiPanelHelpItems(FACTORY_TERM_KEYS.STRATEGY_LIBRARY);
  const stage = library.lifecycle || null;
  const promotionStatus = library.promotionStatus || 'not_in_library';
  const retirementStatus = library.retirementStatus || 'unknown';

  // Blockeraren visas som den ÄR. En befordran som inte sker ska kunna
  // förklaras utan att någon behöver läsa loggen.
  const promotionHint = promotionStatus === 'blocked' && library.promotionBlockers?.length
    ? `${library.promotionBlockers[0]}${library.promotionTo ? ` → ${library.promotionTo}` : ''}`
    : (library.promotionTo ? `${panel.messages.nextStep}: ${uiLifecycleStage(library.promotionTo)}` : null);

  const items = [
    {
      label: panel.labels.lifecycle,
      value: textOrEmpty(uiLifecycleStage(stage || library.lifecycleLabel)),
      tone: STAGE_TONE[stage] || 'muted',
      hint: Number.isFinite(library.lifecycleIndex) && library.lifecycleIndex >= 0
        ? `${panel.messages.step} ${library.lifecycleIndex + 1} ${panel.messages.of} 8`
        : null,
    },
    {
      label: panel.labels.confidence,
      value: scoreText(library.confidenceScore),
      // Confidence säger hur mycket vi VET. Låg confidence är inget fel — det
      // är en uppmaning att köra fler perioder och fler regimer.
      tone: library.confidenceScore == null ? 'muted'
        : library.confidenceScore >= 70 ? 'success'
          : library.confidenceScore >= 40 ? 'blue' : 'warning',
      hint: panel.messages.confidenceHint,
    },
    {
      label: panel.labels.promotion,
      value: panel.promotionLabels[promotionStatus] || promotionStatus,
      tone: PROMOTION_TONE[promotionStatus] || 'muted',
      hint: promotionHint,
    },
    {
      label: panel.labels.retirement,
      value: panel.retirementLabels[retirementStatus] || retirementStatus,
      tone: RETIREMENT_TONE[retirementStatus] || 'muted',
      hint: library.retirementReason || null,
    },
    {
      label: panel.labels.strategyScore,
      value: scoreText(library.strategyScoreLibrary),
      hint: panel.messages.strategyScoreHint,
    },
    {
      label: panel.labels.executionScore,
      value: scoreText(library.executionScoreLibrary),
      hint: panel.messages.executionScoreHint,
    },
    {
      label: panel.labels.productionScore,
      value: scoreText(library.productionScore),
      // Ett Production Score på fem affärer är inget omdöme, och det ska synas
      // på raden i stället för att behöva räknas ut av den som läser.
      tone: library.productionScore == null ? 'muted'
        : library.productionScoreQualified === false ? 'warning' : 'blue',
      hint: library.productionScoreQualified === false
        ? `${panel.messages.tooFewPaperTrades} (${library.paperTrades ?? 0})`
        : panel.messages.productionScoreHint,
    },
    {
      label: panel.labels.history,
      value: `${library.replayRuns ?? 0} ${panel.messages.replayCount} · ${library.paperTrades ?? 0} ${panel.messages.paperCount} · ${library.liveTrades ?? 0} ${panel.messages.liveCount}`,
      hint: library.currentMarketDnaHash ? `${panel.messages.marketDnaPrefix} ${library.currentMarketDnaHash}` : null,
    },
    {
      // Vilka sorters marknad strategin faktiskt mött. Ett bra resultat i en
      // enda regim är inte ett bra resultat — det är ett obeprövat resultat,
      // och den skillnaden ska synas här.
      label: panel.labels.marketRegimes,
      value: library.regimesSeen?.length ? library.regimesSeen.join(' · ') : panel.messages.noHistory,
      tone: !library.regimesSeen?.length ? 'warning'
        : library.regimesSeen.length >= 3 ? 'success' : 'blue',
      hint: library.regimesSeen?.length
        ? `${library.regimesSeen.length} ${panel.messages.tried} — ${panel.messages.blindSpotsInMarketIntelligence}`
        : panel.messages.neverReplayTested,
    },
    ...panelHelp,
  ];

  return (
    <OverviewPanel
      eyebrow={uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY)}
      title={panel.title}
      summary={uiDescription(FACTORY_TERM_KEYS.STRATEGY_LIBRARY)}
    >
      <FieldGrid items={items.filter((item) => hasValue(item.value))} />
    </OverviewPanel>
  );
});
