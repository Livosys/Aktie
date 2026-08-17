import React from 'react';
import { hasValue, textOrEmpty } from '../../utils/tradingFormatters.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';

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

const PROMOTION_LABEL = {
  ready: 'Klar för nästa steg',
  blocked: 'Blockerad',
  terminal: 'Sista steget',
  retired: 'Pensionerad',
  not_in_library: 'Saknas i Library',
};

const PROMOTION_TONE = {
  ready: 'success',
  blocked: 'muted',
  terminal: 'blue',
  retired: 'muted',
  not_in_library: 'warning',
};

const RETIREMENT_LABEL = {
  active: 'Aktiv',
  suggested: 'Pensionering föreslås',
  retired: 'Pensionerad',
  unknown: '—',
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

  const stage = library.lifecycle || null;
  const promotionStatus = library.promotionStatus || 'not_in_library';
  const retirementStatus = library.retirementStatus || 'unknown';

  // Blockeraren visas som den ÄR. En befordran som inte sker ska kunna
  // förklaras utan att någon behöver läsa loggen.
  const promotionHint = promotionStatus === 'blocked' && library.promotionBlockers?.length
    ? `${library.promotionBlockers[0]}${library.promotionTo ? ` → ${library.promotionTo}` : ''}`
    : (library.promotionTo ? `Nästa steg: ${library.promotionTo}` : null);

  const items = [
    {
      label: 'Lifecycle',
      value: textOrEmpty(library.lifecycleLabel || stage),
      tone: STAGE_TONE[stage] || 'muted',
      hint: Number.isFinite(library.lifecycleIndex) && library.lifecycleIndex >= 0
        ? `Steg ${library.lifecycleIndex + 1} av 8`
        : null,
    },
    {
      label: 'Confidence',
      value: scoreText(library.confidenceScore),
      // Confidence säger hur mycket vi VET. Låg confidence är inget fel — det
      // är en uppmaning att köra fler perioder och fler regimer.
      tone: library.confidenceScore == null ? 'muted'
        : library.confidenceScore >= 70 ? 'success'
          : library.confidenceScore >= 40 ? 'blue' : 'warning',
      hint: 'Hur mycket vi vet — skilt från Strategy Score',
    },
    {
      label: 'Promotion',
      value: PROMOTION_LABEL[promotionStatus] || promotionStatus,
      tone: PROMOTION_TONE[promotionStatus] || 'muted',
      hint: promotionHint,
    },
    {
      label: 'Retirement',
      value: RETIREMENT_LABEL[retirementStatus] || retirementStatus,
      tone: RETIREMENT_TONE[retirementStatus] || 'muted',
      hint: library.retirementReason || null,
    },
    {
      label: 'Strategy Score',
      value: scoreText(library.strategyScoreLibrary),
      hint: 'Replay — strategins logik',
    },
    {
      label: 'Execution Score',
      value: scoreText(library.executionScoreLibrary),
      hint: 'Vad utförandet kostade',
    },
    {
      label: 'Production Score',
      value: scoreText(library.productionScore),
      // Ett Production Score på fem affärer är inget omdöme, och det ska synas
      // på raden i stället för att behöva räknas ut av den som läser.
      tone: library.productionScore == null ? 'muted'
        : library.productionScoreQualified === false ? 'warning' : 'blue',
      hint: library.productionScoreQualified === false
        ? `För få paper-affärer (${library.paperTrades ?? 0}) för att luta sig mot`
        : 'Paper och live över tid',
    },
    {
      label: 'Historik',
      value: `${library.replayRuns ?? 0} replay · ${library.paperTrades ?? 0} paper · ${library.liveTrades ?? 0} live`,
      hint: library.currentMarketDnaHash ? `Market DNA ${library.currentMarketDnaHash}` : null,
    },
    {
      // Vilka sorters marknad strategin faktiskt mött. Ett bra resultat i en
      // enda regim är inte ett bra resultat — det är ett obeprövat resultat,
      // och den skillnaden ska synas här.
      label: 'Marknadsregimer',
      value: library.regimesSeen?.length ? library.regimesSeen.join(' · ') : 'Ingen ännu',
      tone: !library.regimesSeen?.length ? 'warning'
        : library.regimesSeen.length >= 3 ? 'success' : 'blue',
      hint: library.regimesSeen?.length
        ? `${library.regimesSeen.length} prövade — blinda fläckar visas i Market Intelligence`
        : 'Strategin har aldrig körts i replay',
    },
  ];

  return (
    <OverviewPanel eyebrow="Strategy Library" title="Livscykel och förtroende">
      <FieldGrid items={items.filter((item) => hasValue(item.value))} />
    </OverviewPanel>
  );
});
