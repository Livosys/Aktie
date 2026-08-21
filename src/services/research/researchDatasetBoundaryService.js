'use strict';

// ── Research Dataset Boundary ────────────────────────────────────────────────
//
// Hur historiken delas i research och validation utan läckage. Det är ett
// METODVAL, inte ett faktum om lagret — och därför allt den här modulen äger.
//
// Vilka handelsdagar som finns, vilket kontrakt som äger dem och vilket
// kalenderfönster de motsvarar är marknadsdatafakta och bor i
// src/data/tradingDayCalendar.js. De låg här tills replay-kön behövde samma
// svar; en produktionsväg som importerar en modul kallad "research" är en
// lagerinversion, och att duplicera mappningen hade varit värre — två
// uträkningar av samma sak pekar förr eller senare på olika dygn.
//
// ── Varför kontraktsjusterad split och inte 70/30 ───────────────────────────
//
// En ren tidssplit på 70/30 lägger snittet mitt i ett kontrakt (M6), så samma
// kontrakts mikrostruktur — dess tickprofil, dess likviditet, dess rullfönster
// — finns på BÅDA sidor. Det är inte läckage av framtida priser, men det är
// läckage av instrumentidentitet, och en validering vars instrument redan är
// inlärt mäter mindre än den utger sig för.
//
// Kontraktsjusterad split lägger snittet mellan kontrakt. Noll kontrakt och
// noll dygn delas, och överlappet MÄTS i stället för att antas — en split som
// påstår sig vara läckagefri utan att räkna efter är en förhoppning.
//
// All research i det här lagret använder exact_contract. Undantagslöst; se
// tradingDayCalendar för varför.
//
// Ren modul: läser kalendern, skriver ingenting, handlar inte.

const calendar = require('../../data/tradingDayCalendar');


const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'research_dataset_boundary',
});

const BOUNDARY_VERSION = 'research-dataset-boundary-v1';

const DATA_ACCESS_MODES = calendar.DATA_ACCESS_MODES;
const DEFAULT_ROOTS = calendar.DEFAULT_ROOTS;

// Splittens skiljelinje uttrycks som kontrakt, inte som datum. Datumen HÄRLEDS
// ur kontrakten — hade de stått för hand hade de tyst kunnat glida isär från
// vilka kontrakt lagret faktiskt innehåller.
const RESEARCH_CONTRACT_ORDINALS = 2;

/**
 * Research/validation-split, kontraktsjusterad.
 *
 * Snittet läggs mellan det N:te och det (N+1):te kontraktet. Dygnen härleds,
 * och överlappet verifieras i stället för att antas — en split som PÅSTÅR sig
 * vara läckagefri utan att räkna efter är en förhoppning.
 */
function buildSplit({ roots = DEFAULT_ROOTS, dataStore = null, researchContracts = RESEARCH_CONTRACT_ORDINALS } = {}) {
  const readOptions = dataStore ? { dataStore } : {};
  const shared = new Set(calendar.sharedDays({ roots, ...readOptions }));
  const contractsByRoot = new Map(roots.map((root) => [
    String(root).toUpperCase(), calendar.listContracts(root, readOptions),
  ]));

  const researchDays = new Set();
  const validationDays = new Set();
  const researchContractKeys = [];
  const validationContractKeys = [];

  for (const [root, contracts] of contractsByRoot) {
    contracts.forEach((contract, index) => {
      const target = index < researchContracts ? researchDays : validationDays;
      const keys = index < researchContracts ? researchContractKeys : validationContractKeys;
      keys.push(`${root}:${contract.contractKey.split(':').slice(1).join(':')}`);
      for (const day of contract.days) {
        if (shared.has(day)) target.add(day);
      }
    });
  }

  const research = [...researchDays].sort();
  const validation = [...validationDays].sort();
  const dayOverlap = research.filter((day) => validationDays.has(day));

  return {
    ok: dayOverlap.length === 0,
    boundaryVersion: BOUNDARY_VERSION,
    dataAccessMode: DATA_ACCESS_MODES.EXACT_CONTRACT,
    roots: [...roots].map((r) => String(r).toUpperCase()),
    splitMethod: 'contract_adjusted_temporal',
    randomSplit: false,
    research: {
      days: research,
      dayCount: research.length,
      from: research[0] || null,
      to: research[research.length - 1] || null,
      contracts: researchContractKeys.sort(),
    },
    validation: {
      days: validation,
      dayCount: validation.length,
      from: validation[0] || null,
      to: validation[validation.length - 1] || null,
      contracts: validationContractKeys.sort(),
    },
    // Mätt, inte påstått.
    dayOverlap,
    contractOverlap: researchContractKeys.filter((key) => validationContractKeys.includes(key)),
    sharedDayCount: shared.size,
    ...SAFETY,
  };
}

/** Datamängdens gräns som den ska bokföras i ett experiments härkomst. */
function describeBoundary(options = {}) {
  // Kalenderns beskrivning plus research-lagrets egen märkning. Talen räknas på
  // ett ställe; den här modulen lägger bara till vem som frågade.
  return {
    ...calendar.describeCalendar(options),
    boundaryVersion: BOUNDARY_VERSION,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  BOUNDARY_VERSION,
  DATA_ACCESS_MODES,
  DEFAULT_ROOTS,
  buildSplit,
  describeBoundary,
};
