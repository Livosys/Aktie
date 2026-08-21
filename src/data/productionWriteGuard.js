'use strict';

// ── Skydd mot att diagnostik skriver i driftens data ─────────────────────────
//
// Systemets permanenta minnen — Strategy Library, AI Memory och Strategy Family
// Tree — är append-only loggar. Det gör dem robusta mot att bli överskrivna,
// men samtidigt helt oskyddade mot att bli PÅSKRIVNA: en rad som lagts till kan
// inte tas bort utan att historiken förfalskas.
//
// Det gör en verifieringskörning farlig på ett sätt som inte syns. Att fråga
// "vad skulle evolutionen föreslå här?" gjordes genom att faktiskt anropa
// createOptimizedDnaCandidates(), och den skriver noder i släktträdet som
// sidoeffekt. Elva genom hamnade i driftens träd den 20 augusti 2026 på det
// sättet — inte fel data, men inte heller fabrikens egna resultat, och omöjliga
// att ta bort i efterhand.
//
// ── Två lager, och det första är det viktiga ────────────────────────────────
//
//   1. Diagnostik ska inte skriva alls. Evolution Engine har därför ett
//      persist: false-läge som räknar fram förslagen utan att röra trädet.
//      Det är den rätta vägen, och den kräver ingen miljövariabel.
//
//   2. Om någon ändå försöker skriva från en sandlåda ska det SMÄLLA, inte
//      lyckas tyst. Det är vad den här modulen gör.
//
// Sandlådeläget stängs av som standard. Drift beter sig alltså exakt som förut;
// modulen kan bara neka en skrivning, aldrig ändra vad som skrivs.

const path = require('path');

// Katalogen som ÄR driften. Allt under den är permanent minne.
const PRODUCTION_DATA_DIR = path.resolve(__dirname, '../../data');

const SANDBOX_ENV = 'TRADING_OS_SANDBOX';

/**
 * Är vi i sandlådeläge?
 *
 * Läses vid varje anrop och inte en gång vid inläsning: ett test som sätter
 * flaggan efter att modulen laddats ska ändå skyddas.
 */
function sandboxEnabled() {
  const raw = process.env[SANDBOX_ENV];
  if (raw == null || raw === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/** Ligger filen i driftens datakatalog? */
function isProductionPath(file) {
  if (!file) return false;
  const resolved = path.resolve(String(file));
  const root = `${PRODUCTION_DATA_DIR}${path.sep}`;
  return resolved === PRODUCTION_DATA_DIR || resolved.startsWith(root);
}

/**
 * Kastar om en sandlådekörning försöker skriva i driftens data.
 *
 * @param {string} file   filen som ska skrivas
 * @param {string} label  vem som skriver, för felmeddelandet
 */
function assertWritable(file, label = 'append_only_log') {
  if (!sandboxEnabled() || !isProductionPath(file)) return;
  throw new Error(
    `${label}_blocked_by_sandbox: ${file} ligger i driftens datakatalog och ${SANDBOX_ENV} är på. `
    + 'Peka om loggen med sin env-variabel, eller använd ett läge som inte persisterar.',
  );
}

/**
 * Miljövariablerna som pekar om ALLA permanenta minnen till en egen katalog.
 *
 * Samlad här därför att de tre loggarna måste flyttas TILLSAMMANS. Flyttas
 * bara två skriver den tredje i driften, och det är precis vad som hände när
 * biblioteket och trädet var omdirigerade men AI Memory inte var det.
 *
 * Barnprocesser ärver process.env, så en förälder som satt de här värdena
 * skyddar även den replay-worker den startar.
 */
function sandboxEnv(rootDir) {
  const root = path.resolve(rootDir);
  return {
    [SANDBOX_ENV]: '1',
    STRATEGY_LIBRARY_EVENTS_FILE: path.join(root, 'strategy-library', 'events.jsonl'),
    AI_MEMORY_EVENTS_FILE: path.join(root, 'ai-memory', 'experiments.jsonl'),
    // Släktträdet ligger bredvid AI Memory i driften (data/ai-memory/lineage.jsonl),
    // inte i en egen katalog. Sandlådan speglar layouten så att en omdirigering
    // blir fullständig.
    STRATEGY_FAMILY_TREE_FILE: path.join(root, 'ai-memory', 'lineage.jsonl'),
  };
}

module.exports = {
  PRODUCTION_DATA_DIR,
  SANDBOX_ENV,
  sandboxEnabled,
  isProductionPath,
  assertWritable,
  sandboxEnv,
};
