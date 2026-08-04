#!/usr/bin/env node
'use strict';

// Shadow-jämförelse: gammalt beslut mot nytt, offline.
//
// Läser historiska kandidater ur data/futures-paper/events.jsonl och kör dem
// genom BÅDA vägarna:
//
//   gammalt = paperStrategyEntryContractService.evaluatePaperEntryContract()
//   nytt    = canonicalSignalAdapters -> executionReadinessEngine.evaluate()
//
// Skriver aldrig något och rör ingen produktionsväg. Syftet är att få
// identitetssiffran UTAN att vänta på en omstart — kandidatposterna innehåller
// hela payloaden som grinden såg.
//
// MÄTFÄLLA som hanteras här: färskhetsgrinden mäter mot `now`. Körs jämförelsen
// med väggklockan blir varje historisk kandidat inaktuell och identiteten
// felaktigt 100% (båda vägarna blockerar på stale). Klockan fryses därför till
// kandidatens skapandetid.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const entryContracts = require(path.join(ROOT, 'src/services/paperStrategyEntryContractService'));
const adapters = require(path.join(ROOT, 'src/services/canonical/canonicalSignalAdapters'));
const engine = require(path.join(ROOT, 'src/services/canonical/executionReadinessEngine'));
const { validateCanonicalSignal } = require(path.join(ROOT, 'src/services/canonical/canonicalSignal'));

const EVENTS_FILE = path.join(ROOT, 'data/futures-paper/events.jsonl');

// Orchestratorn skickar ALLTID en marketContext till kontraktet
// (ibPaperExecutionOrchestratorService.js:656-665). Utan den mäter jämförelsen
// inte samma indata som produktionen faktiskt använder.
function marketContextFor(candidate) {
  const sessionId = candidate.sessionId || candidate.sessionMetadata?.sessionId || null;
  return {
    marketType: 'futures',
    session: sessionId,
    sessionId,
    isMarketOpen: candidate.isMarketOpen === true || candidate.sessionMetadata?.isMarketOpen === true,
  };
}

function readCandidates({ dayFilter = null } = {}) {
  const out = [];
  if (!fs.existsSync(EVENTS_FILE)) return out;
  const text = fs.readFileSync(EVENTS_FILE, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch (_) { continue; }
    if (event.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
    const ts = String(event.timestamp || '');
    if (dayFilter && !ts.startsWith(dayFilter)) continue;
    for (const candidate of (event.candidates || [])) {
      out.push({ candidate, createdAt: ts });
    }
  }
  return out;
}

function adapterFor(candidate) {
  // Kandidaten bär ingen producerType i dag. Native futures känns igen på sin
  // egen signalkälla; allt annat kommer från TradingOS-läsaren.
  const source = String(candidate.signalSource || candidate.source || '').toLowerCase();
  if (source.includes('futures_native')) return adapters.nativeCanonicalAdapter;
  return adapters.tradingOsCanonicalAdapter;
}

function legacyAdvisoryOf(candidate) {
  // Exakt samma härledning som orchestratorns normalizeCandidate:105 och
  // kontraktets :750 gör.
  return candidate.signalStatus || candidate.entryStatus || candidate.status || candidate.priority || '';
}

function run({ dayFilter = null } = {}) {
  const rows = readCandidates({ dayFilter });
  const summary = {
    total: 0,
    equal: 0,
    mismatch: 0,
    reasonMismatch: 0,
    invalidCanonical: 0,
    byVerdict: {},
    mismatches: [],
    reasonMismatches: [],
    evidenceGaps: {},
  };

  for (const { candidate, createdAt } of rows) {
    // Frys klockan till kandidatens skapandetid.
    const now = new Date(createdAt);
    if (!Number.isFinite(now.getTime())) continue;

    const strategyId = candidate.strategyId || null;

    const marketContext = marketContextFor(candidate);

    const oldDecision = entryContracts.evaluatePaperEntryContract({
      strategyId,
      candidate,
      now,
      marketContext,
    });

    const canonical = adapterFor(candidate)(candidate, { now, marketContext });
    const validation = validateCanonicalSignal(canonical);
    if (!validation.ok) summary.invalidCanonical += 1;

    const newDecision = engine.evaluate({
      canonicalSignal: canonical,
      legacyAdvisory: legacyAdvisoryOf(candidate),
      now,
    });

    const oldAllowed = oldDecision.allowed === true;
    const newAllowed = newDecision.verdict === engine.VERDICTS.EXECUTABLE;
    const equal = oldAllowed === newAllowed;

    summary.total += 1;
    summary.byVerdict[newDecision.verdict] = (summary.byVerdict[newDecision.verdict] || 0) + 1;
    for (const gap of newDecision.evidenceGaps || []) {
      summary.evidenceGaps[gap] = (summary.evidenceGaps[gap] || 0) + 1;
    }

    if (equal) {
      summary.equal += 1;
      // Även vid samma beslut ska orsaken vara jämförbar.
      const expected = engine.LEGACY_REASON_MAP[oldDecision.reasonCode] || null;
      if (!oldAllowed && expected && expected !== newDecision.reasonCode) {
        summary.reasonMismatch += 1;
        if (summary.reasonMismatches.length < 20) {
          summary.reasonMismatches.push({
            createdAt,
            strategyId,
            candidateId: candidate.candidateId,
            oldReason: oldDecision.reasonCode,
            expectedNew: expected,
            actualNew: newDecision.reasonCode,
          });
        }
      }
    } else {
      summary.mismatch += 1;
      if (summary.mismatches.length < 40) {
        summary.mismatches.push({
          createdAt,
          strategyId,
          candidateId: candidate.candidateId,
          signalSubtype: candidate.signalSubtype,
          legacyAdvisory: legacyAdvisoryOf(candidate),
          oldAllowed,
          oldReason: oldDecision.reasonCode,
          newVerdict: newDecision.verdict,
          newReason: newDecision.reasonCode,
          newDetail: newDecision.detail,
        });
      }
    }
  }

  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dayIdx = args.indexOf('--day');
  const dayFilter = dayIdx >= 0 ? args[dayIdx + 1] : null;
  const result = run({ dayFilter });

  const pct = result.total ? (100 * result.equal / result.total).toFixed(2) : '0.00';
  console.log(`kandidater:            ${result.total}`);
  console.log(`beslutsidentitet:      ${result.equal}/${result.total}  (${pct}%)`);
  console.log(`avvikande beslut:      ${result.mismatch}`);
  console.log(`avvikande reasonCode:  ${result.reasonMismatch}  (samma beslut, annan orsak)`);
  console.log(`ogiltig canonical:     ${result.invalidCanonical}`);
  console.log(`verdict-fördelning:    ${JSON.stringify(result.byVerdict)}`);
  console.log(`evidensluckor:         ${JSON.stringify(result.evidenceGaps)}`);
  if (result.mismatches.length) {
    console.log('\n--- avvikande beslut (max 40) ---');
    for (const m of result.mismatches) console.log(JSON.stringify(m));
  }
  if (result.reasonMismatches.length) {
    console.log('\n--- avvikande orsakskod (max 20) ---');
    for (const m of result.reasonMismatches) console.log(JSON.stringify(m));
  }
}

module.exports = { run, readCandidates };
