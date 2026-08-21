'use strict';

// Barnprocess som kör Native Replay Engine.
//
// ── Varför en egen process ───────────────────────────────────────────────────
//
// Replay-loopen är synkron från första baren till sista: klockan stegas i
// JavaScript, varje steg utvärderar samtliga strategier, och ingenting i
// kedjan väntar på I/O. Mätt på en komplett handelsdag (2026-08-18, MNQ+MES,
// 13:00–17:00Z) kostar den 1,44 s per strategi. Med registrets 29 körbara
// strategier blir en enda körning ~49 s — i serverprocessen hade det varit 49
// sekunder utan hjärtslag: inga API-svar, ingen paper-cykel, ingen watchdog.
//
// Samma mönster som runAutoMachineWorker.js och buildOverviewWorker.js redan
// använder av exakt samma skäl.
//
// Workern väljer ingenting själv. Den tar emot en färdig konfiguration och
// anropar samma createNativeReplayEngine().run() som acceptanstesterna kör.
//
// ── Varför bokföringen också sker här ────────────────────────────────────────
//
// RunResult bär tradesByStrategy som en Map, och en Map överlever inte
// process.send() — den blir ett tomt objekt på andra sidan. Rapporten och
// biblioteksbokföringen måste därför byggas där RunResult fortfarande är helt,
// alltså här. Föräldern får en liten sammanfattning tillbaka.
//
// Det är dessutom rätt av ett andra skäl: bokföringen läser och skriver filer,
// och den kostnaden hör inte hemma i serverprocessen heller.

const engineModule = require('../services/replay/nativeReplayEngineService');
const reportModule = require('../services/replay/replayReportService');
const recorderModule = require('../services/library/strategyLibraryRecorderService');
const evolutionModule = require('../services/evolution/evolutionEngineService');
const evidenceLedger = require('../services/research/researchEvidenceLedgerService');
const policyModule = require('../services/research/researchEvidencePolicyService');

// process.send() är asynkront. Att avsluta direkt efter send() trunkerar
// skrivningen, och föräldern ser då bara en exit-kod utan 'message' — samma
// fälla som buildOverviewWorker.js dokumenterar. Vänta på send-callbacken.
function sendThenExit(message, exitCode) {
  if (typeof process.send === 'function') {
    process.send(message, (err) => process.exit(err ? 1 : exitCode));
    return;
  }
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(message), () => process.exit(exitCode));
}

function handleRun(config = {}, { runId = null, requestedBy = null } = {}) {
  try {
    const run = engineModule.createNativeReplayEngine({}).run(config);
    const report = reportModule.buildReplayReport(run);

    // Registret in i biblioteket FÖRE körningen bokförs: en REPLAY_RECORDED för
    // en strategi biblioteket aldrig hört talas om hade blivit en post utan
    // ursprung. syncAll är idempotent — den skriver bara det som saknas.
    const recorder = recorderModule.createStrategyLibraryRecorder({});
    const sync = recorder.syncAll();
    const recorded = recorder.recordReplayRun(run, report, { runId, requestedBy });

    // Evolution Engine kopplas in på ETT sätt: varje registrerad strategis
    // genom får sin rot i släktträdet. Inga mutationer skapas här — motorn får
    // producera nytt DNA först när någon uttryckligen ber om det, och den
    // frågan besvaras inte av en replay-körning.
    //
    // seedRegisteredStrategies är idempotent: en rot som redan finns ger
    // alreadyPresent och skrivs inte om.
    const evolution = evolutionModule.createEvolutionEngine({});
    const seeded = evolution.seedRegisteredStrategies();

    // ── Research-hypoteser klassificeras mot den godkända evidenspolicyn ──────
    //
    // Klassificeringen sker HÄR, efter bokföringen och i samma barnprocess, av
    // två skäl. Den läser hela bibliotekets historik för hypotesen och den
    // kostnaden hör inte hemma i serverprocessen — samma skäl som gör att
    // bokföringen ligger här. Och den ska bygga på evidensen INKLUSIVE den
    // körning som just skrevs; en klassificering före bokföringen hade svarat
    // på gårdagens underlag.
    //
    // Domen lagras inte. Den härleds ur biblioteket vid varje anrop, så den kan
    // aldrig säga något annat än den evidens den bygger på — och evidensen växer
    // för varje dygn som bokförs.
    //
    // Ingenting aktiveras. En HISTORICALLY_VALIDATED_CANDIDATE är fortfarande
    // varken runtime eller Paper; det avgörs av researchHypothesisService
    // LIFECYCLE_GATES och inte av ett utfall i en rapport.
    const researchVerdicts = evidenceLedger.classifyRecordedRun(
      (recorded.written || []).map((row) => row.strategyId),
    );

    sendThenExit({
      type: 'native_replay_result',
      ok: true,
      payload: {
        config: run.config,
        counts: run.counts,
        dataCoverage: run.dataCoverage,
        ticks: run.ticks,
        strategyScore: (report.strategyScore?.perStrategy || []).map((row) => ({
          strategyId: row.strategyId,
          total: row.total,
          band: row.band ?? null,
          trades: row.stats?.trades ?? 0,
          winRate: row.stats?.winRate ?? null,
          strategyPnlUsd: row.stats?.strategyPnlUsd ?? null,
        })),
        marketClassification: report.marketClassification?.classification || null,
        library: {
          registryStrategies: sync.registry?.registryStrategies ?? null,
          created: (sync.registry?.created || []).length,
          dnaChanged: (sync.registry?.dnaChanged || []).length,
          paperWritten: sync.paper?.written ?? null,
          replayWritten: (recorded.written || []).length,
          replaySkipped: (recorded.skipped || []).length,
        },
        lineage: {
          rootsCreated: (seeded.created || []).length,
          nodes: seeded.nodes ?? null,
        },
        research: researchVerdicts.length ? {
          policyVersion: policyModule.POLICY_VERSION,
          policyStatus: policyModule.describePolicy().status,
          classified: researchVerdicts.map((row) => ({
            strategyId: row.strategyId,
            outcome: row.outcome,
            reason: row.reason,
            failed: row.failed || [],
            netEvidenceComplete: row.netEvidenceComplete ?? null,
            researchTrades: row.aggregates?.research?.trades ?? null,
            validationTrades: row.aggregates?.validation?.trades ?? null,
          })),
          // Klassificering är inte befordran. Fältet står här för att en läsare
          // aldrig ska behöva gissa vad utfallet gav.
          runtimeEligible: false,
          paperEligible: false,
        } : null,
      },
    }, 0);
  } catch (err) {
    sendThenExit({
      type: 'native_replay_result',
      ok: false,
      error: err && err.message ? err.message : String(err),
    }, 1);
  }
}

if (require.main === module) {
  process.on('message', (msg) => {
    if (!msg || msg.type !== 'native_replay_run') return;
    handleRun(msg.config || {}, { runId: msg.runId || null, requestedBy: msg.requestedBy || null });
  });
}

module.exports = { handleRun };
