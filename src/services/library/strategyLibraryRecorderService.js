'use strict';

// ── Strategy Library Recorder ────────────────────────────────────────────────
//
// Vägen in i biblioteket från de tre källorna: Replay, Paper och Live.
//
// ── Varför Replay inte skriver själv ────────────────────────────────────────
//
// nativeReplayEngineService är avsiktligt fri från fil-IO och klocka — det är
// vad som gör en körning reproducerbar. Låter man motorn skriva till disk mitt
// i loopen är den egenskapen borta. Recordern tar därför emot ett färdigt
// RunResult och en färdig rapport och skriver ut dem efteråt.
//
// ── Varför Paper och Live LÄSES i stället för att skriva ────────────────────
//
// Det naturliga vore att exekveringskedjan anropade biblioteket när en affär
// stängs. Men den kedjan går mot en riktig broker med riktiga order, och att
// lägga in ett nytt skrivanrop där för en analysfunktions skull är att ta en
// risk i fel ände av systemet.
//
// I stället läses affärerna ur ledgerns egen logg och viks in i biblioteket.
// Det är IDEMPOTENT: varje affär bärs av sitt tradeId, och en affär som redan
// finns registreras inte igen. Synken kan köras hur ofta som helst, och den
// kan köras om från början efter ett avbrott utan att skapa dubbletter.
//
// ── Identitetsöversättning ──────────────────────────────────────────────────
//
// Paper-affärerna är stämplade med LEGACY-strategi-id (trend_continuation),
// medan biblioteket är nycklat på native-id (native_futures_trend_continuation_v1).
// Registret äger den mappningen och är den enda som får göra den. Affärer vars
// ursprung inte går att lösa upp RÄKNAS och rapporteras — de tystas aldrig
// bort, för en tyst bortfallen affär är en post som saknas i strategins liv.

const fs = require('fs');
const path = require('path');

const libraryModule = require('./strategyLibraryService');
const nativeRegistry = require('../nativeFuturesStrategyRegistryService');
const strategyRegistry = require('../strategyRegistryService');
const strategyScoreV1 = require('../score/strategyScoreV1Service');
const confidenceScore = require('../score/confidenceScoreService');
const marketDna = require('../market/marketDnaService');
const strategyDna = require('../dna/strategyDnaService');
const aiMemoryModule = require('../memory/aiMemoryService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'strategy_library_recorder',
});

const DEFAULT_PAPER_TRADES_FILE = path.resolve(__dirname, '../../../data/futures-paper/trades.jsonl');

// Vem som bad om körningen. Sista värdet är fallback: en okänd beställare är
// systemet, aldrig ett tomt fält — annars går det inte att skilja "vi vet inte"
// från "ingen frågade".
const REQUESTERS = Object.freeze([
  'manual', 'batch', 'optimizer', 'evolution', 'regression', 'benchmark', 'system',
]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Strategins deklarerade timeframe, om den har någon.
 *
 * Bara research-hypoteser deklarerar en. De åtta modulerna, deras varianter och
 * de muterade genomen kör i den timeframe kompositionsroten väljer och gör
 * inget anspråk på någon annan.
 */
function declaredTimeframeFor(strategyId) {
  try {
    const hypotheses = require('../research/researchHypothesisService');
    if (!hypotheses.isResearchStrategyId(strategyId)) return null;
    return hypotheses.getHypothesis(strategyId)?.semantics?.timeframe || null;
  } catch (_) {
    return null;
  }
}

/** Legacy- eller native-id → native-id. Null när det inte går att avgöra. */
function resolveNativeStrategyId(strategyId, registry = nativeRegistry) {
  const id = text(strategyId);
  if (!id) return null;
  if (typeof registry.getStrategy === 'function' && registry.getStrategy(id)) return id;
  if (registry.isNativeStrategyId(id)) return id;
  return registry.soleNativeStrategyForOrigin(id)?.strategyId || null;
}

function createStrategyLibraryRecorder(options = {}) {
  const library = options.library || libraryModule.defaultStrategyLibrary;
  const registry = options.registry || { ...nativeRegistry, ...strategyRegistry };
  const paperTradesFile = options.paperTradesFile || DEFAULT_PAPER_TRADES_FILE;
  const memory = options.memory || aiMemoryModule.defaultAiMemory;

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * Skriver in en replay-körning, en rad per strategi som handlade.
   *
   * @param {object} runResult  från nativeReplayEngineService.run()
   * @param {object} report     från replayReportService.buildReplayReport()
   */
  function recordReplayRun(runResult, report, { runId = null, at = null, requestedBy = null } = {}) {
    const id = runId || `replay:${runResult.config?.mode}:${runResult.config?.from}:${runResult.config?.to}`;
    // Varje replay bygger AI:s kunskapsbas, oavsett vem som bad om den. Vem det
    // var är HÄRKOMST och påverkar därför aldrig experimentets identitet — en
    // manuell körning och en från evolutionen på samma DNA i samma marknad är
    // samma experiment, och minnet ska då peka tillbaka till Library i stället
    // för att bära en egen resultatkopia.
    const requester = REQUESTERS.includes(requestedBy) ? requestedBy : REQUESTERS[REQUESTERS.length - 1];
    const classification = report.marketClassification?.classification || null;
    const executionScore = report.executionScore?.total ?? null;
    // Market DNA för perioden. Den grova regimnyckeln följer med varje körning
    // så att Market Intelligence kan svara på vilka förhållanden strategin har
    // sett — och, viktigare, vilka den aldrig har sett.
    // En körning täcker en MÄNGD regimer — MNQ och MES kan ha olika karaktär
    // samma dag. Mängden lagras som mängd.
    //
    // Första versionen slog ihop dem till en sträng ("down/normal+down/quiet").
    // Det såg ut att fungera men var fel på två sätt: den sammansatta nyckeln
    // fanns inte i katalogen och kunde därför aldrig matcha, så täckningen
    // räknade nycklar som inte existerar och samma regim listades samtidigt som
    // testad och som blind fläck.
    const runRegimeKeys = [...new Set(report.marketDna?.regimeKeys || [])].sort();
    // Entydig nyckel bara när körningen faktiskt hade EN regim. Annars null —
    // en tvetydighet ska inte döljas bakom ett påhittat namn.
    const runRegimeKey = runRegimeKeys.length === 1 ? runRegimeKeys[0] : null;
    const runDnaHash = report.marketDna?.combinedHash || null;
    const written = [];
    const skipped = [];
    const experiments = [];

    for (const score of report.strategyScore?.perStrategy || []) {
      const strategyId = resolveNativeStrategyId(score.strategyId, registry);
      if (!strategyId) {
        skipped.push({ strategyId: score.strategyId, reason: 'unresolved_strategy_id' });
        continue;
      }

      const trades = [...(runResult.tradesByStrategy?.get(score.strategyId) || [])];
      const stats = score.stats || {};
      const recoveryFactor = (stats.maxDrawdownUsd > 0 && stats.strategyPnlUsd != null)
        ? Math.round((stats.strategyPnlUsd / stats.maxDrawdownUsd) * 1000) / 1000
        : null;
      const replayEvent = library.recordReplayRun({
        strategyId,
        runId: id,
        mode: runResult.config?.mode || null,
        // ── Timeframe bokförs ─────────────────────────────────────────────
        //
        // Raden bar tidigare inte vilken timeframe körningen använde. Följden
        // upptäcktes 2026-08-20: en hypotes som deklarerar 5m men av misstag
        // kördes på 2m fick sina rader summerade ihop med sina riktiga, och en
        // läsare kunde inte skilja dem åt eftersom fältet inte fanns.
        //
        // Värdet finns redan i körningens konfiguration. Att inte skriva ned det
        // gjorde en blandning av två timeframes omöjlig att upptäcka i
        // efterhand.
        timeframe: runResult.config?.timeframe || null,
        from: runResult.config?.from || null,
        to: runResult.config?.effectiveTo || runResult.config?.to || null,
        trades: stats.trades,
        winRate: stats.winRate,
        strategyPnlUsd: stats.strategyPnlUsd,
        profitFactor: stats.profitFactor ?? null,
        expectancyUsd: stats.expectancyUsd ?? null,
        maxDrawdownUsd: stats.maxDrawdownUsd ?? null,
        avgWinUsd: stats.avgWinUsd ?? null,
        avgLossUsd: stats.avgLossUsd ?? null,
        // ── Netto, kostnad och courtage bokförs också ─────────────────────
        //
        // strategyPnlUsd är STRATEGY EDGE — resultatet mätt mot de priser
        // strategin syftade på. Det är rätt mått för att jämföra signaler, och
        // därför det som stod här ensamt.
        //
        // Men det säger inget om huruvida affärerna hade tjänat pengar. Cykel 1
        // och 2 mätte hypoteser med profit factor över 1 vars netto var
        // negativt: courtaget är fast 2,44 USD per affär och
        // exekveringskostnaden varierade mellan 0,32 och 7,47. En
        // evidenspolicy som ska kunna svara "bar den här hypotesen sin egen
        // kostnad?" kan inte läsa det ur strategyPnlUsd.
        //
        // Talen RÄKNAS redan av tradeLedgerService.summarizeTrades. De
        // persisterades bara inte, och biblioteket är den kanoniska
        // evidenskällan — en fråga som inte går att besvara därifrån går inte
        // att besvara alls.
        netPnlUsd: stats.netPnlUsd ?? null,
        executionCostUsd: stats.executionCostUsd ?? null,
        commissionUsd: stats.commissionUsd ?? null,
        strategyScore: score.total,
        executionScore,
        band: score.band ?? null,
        recoveryFactor,
        sharpe: null,
        sharpeAvailable: false,
        marketClassification: classification,
        marketRegimeKey: runRegimeKey,
        marketRegimeKeys: runRegimeKeys,
        marketDnaHash: runDnaHash,
        qualified: score.qualified === true,
        at,
      });

      // Aktuella mått. Historiken ligger kvar i loggen — det här pekar bara ut
      // det senast kända värdet.
      library.recordScore({ strategyId, scoreType: 'strategyScore', value: score.total, detail: score.components, at });
      if (executionScore != null) {
        library.recordScore({ strategyId, scoreType: 'executionScore', value: executionScore, at });
      }

      // Confidence räknas på ALLT strategin har gjort, inte bara den här
      // körningen — måttet handlar om samlad kunskap.
      const record = library.getStrategy(strategyId);
      const runs = record?.replayHistory || [];

      // Confidence räknar GROVA regimer, inte fina DNA-profiler.
      //
      // Det är ett medvetet val och det viktigaste i hela kopplingen: med det
      // fina avtrycket blir nästan varje handelsdag en egen profil, och då
      // skulle en strategi se ut att ha prövats i tre marknadsregimer efter tre
      // dagar. Upplösningen skulle avgöra måttet i stället för verkligheten.
      // Sexton dygn i lagret ger 15 fina profiler men 6 grova regimer — och det
      // är sexan som är svaret på "hur många sorters marknad har vi sett".
      const conf = confidenceScore.calculateConfidenceScore(
        replayTradesAsScored(record),
        {
          // Unionen av regimerna, inte en nyckel per körning: en körning som
          // täckte två regimer har visat strategin två sorters marknad.
          marketClassifications: runs.flatMap((row) => (
            Array.isArray(row.marketRegimeKeys) && row.marketRegimeKeys.length
              ? row.marketRegimeKeys
              : [row.marketRegimeKey || row.marketClassification].filter(Boolean)
          )),
        },
      );
      library.recordScore({ strategyId, scoreType: 'confidenceScore', value: conf.total, detail: conf.evidence, at });

      // Strategins market DNA är mängden förhållanden den levt igenom, inte den
      // senaste körningen.
      library.recordMarketDna({
        strategyId,
        marketDnaHash: marketDna.combineMarketDnaHashes(runs.map((row) => row.marketDnaHash)),
        profiles: [...new Set(runs.map((row) => row.marketDnaHash).filter(Boolean))],
        regimeKeys: [...new Set(runs.map((row) => row.marketRegimeKey).filter(Boolean))],
        at,
      });

      // ── AI Memory ─────────────────────────────────────────────────────────
      //
      // Ett experiment per STRATEGI, inte per körning. En körning i
      // strategy-läge utvärderar alla registrerade strategier samtidigt, och
      // frågan minnet finns för — "har vi prövat det HÄR genomet i den HÄR
      // marknaden?" — är per strategi. Ett experiment per körning hade gjort
      // den frågan omöjlig att ställa.
      //
      const memoryResult = recordExperimentFor({
        strategyId, runResult, record: library.getStrategy(strategyId),
        runDnaHash, runRegimeKeys, classification, runId: id, requester, at,
        replayEvent,
      });
      if (memoryResult) experiments.push(memoryResult);

      written.push({ strategyId, trades: trades.length, strategyScore: score.total });
    }

    return { ok: true, runId: id, requestedBy: requester, written, skipped, experiments, ...SAFETY };
  }

  /**
   * Skriver ett experiment till AI Memory.
   *
   * Returnerar null när identiteten är ofullständig — ett experiment utan
   * Market DNA går inte att återanvända, och att tvinga fram en nyckel ändå
   * hade gjort alla sådana körningar till samma experiment.
   */
  function recordExperimentFor({
    strategyId, runResult, record, runDnaHash, runRegimeKeys, classification,
    runId, requester, at, replayEvent,
  }) {
    const dna = strategyDna.getStrategyDna(strategyId);
    if (!dna || !runDnaHash) {
      return { strategyId, recorded: false, reason: !dna ? 'no_strategy_dna' : 'no_market_dna' };
    }

    // ── Timeframe in i identiteten (AI Memory v2) ─────────────────────────
    //
    // executedTimeframe hämtas ur KÖRNINGENS konfiguration, aldrig ur strategins
    // metadata. Det är hela poängen: en hypotes som deklarerar 5m men kördes på
    // 2m ska få en annan identitet än samma hypotes körd rätt, och den
    // skillnaden finns bara i vad motorn faktiskt stegade i.
    //
    // declaredTimeframe är vad strategin säger sig kräva. En strategi som inte
    // deklarerar någon har inte "okänd" timeframe utan ingen alls, och det
    // skrivs ut explicit — annars hade ett saknat värde och ett medvetet
    // frånvarande värde blivit samma experiment.
    const executedTimeframe = text(runResult.config?.timeframe);
    const declaredTimeframe = declaredTimeframeFor(strategyId) || aiMemoryModule.NO_DECLARED_TIMEFRAME;

    const spec = {
      // ── identitet ───────────────────────────────────────────────────────
      strategyDnaHash: dna.dnaHash,
      parameterHash: dna.parameterHash,
      marketDnaHash: runDnaHash,
      replayMode: runResult.config?.mode || null,
      executionModel: aiMemoryModule.executionModelOf(runResult.config?.fillEngine || {}),
      strategyVersion: dna.strategyVersion || record?.currentVersion || 'unknown',
      declaredTimeframe,
      executedTimeframe,
      // ── härkomst: lagras, identifierar inte ─────────────────────────────
      period: `${runResult.config?.from}..${runResult.config?.effectiveTo || runResult.config?.to}`,
      symbols: runResult.config?.symbols || [],
      runId,
      requestedBy: requester,
      regimeKeys: runRegimeKeys,
      marketClassification: classification,
    };

    const libraryRef = {
      source: 'strategy_library',
      resultType: 'replay',
      strategyId,
      libraryRunId: runId,
      eventType: replayEvent?.type || libraryModule.EVENT_TYPES.REPLAY_RECORDED,
      recordedAt: replayEvent?.recordedAt || null,
    };

    const written = memory.recordExperiment(spec, libraryRef, { lineage: dna.lineage, at });
    return {
      strategyId,
      recorded: true,
      experimentKey: written.experimentKey,
      // Sant betyder att körningen var onödig — experimentet fanns redan i minnet.
      repeat: written.alreadyKnown === true,
      requestedBy: requester,
    };
  }

  // Replay-historiken som poängsättbara rader. En körning bidrar med sitt
  // resultat och sin tidpunkt; enskilda affärer sparas inte i biblioteket
  // eftersom de redan finns i replay-rapporten.
  function replayTradesAsScored(record) {
    return (record?.replayHistory || []).flatMap((row) => {
      const count = Number(row.trades) || 0;
      if (!count) return [];
      const perTrade = (Number(row.strategyPnlUsd) || 0) / count;
      const wins = Math.round((Number(row.winRate) || 0) / 100 * count);
      return Array.from({ length: count }, (_, i) => ({
        strategyPnlUsd: i < wins ? Math.abs(perTrade) || 1 : -(Math.abs(perTrade) || 1),
        closedAt: row.to || row.at,
        openedAt: row.from || row.at,
      }));
    });
  }

  // ── Paper och Live ────────────────────────────────────────────────────────

  /**
   * Viker in stängda affärer ur ledgerns logg. Idempotent per tradeId.
   *
   * @param {'paper'|'live'} target  vilken sida som ska läsas
   */
  function ingestExecutionHistory({ target = 'paper', at = null } = {}) {
    const rows = readJsonl(paperTradesFile)
      .filter((row) => row.status === 'closed' && text(row.tradeId));

    // Live och paper skiljs på affärens eget executionTarget. Saknas fältet är
    // affären paper — allt som finns i dag saknar det, och live har aldrig
    // varit påslaget. Den dagen live kör hamnar dess affärer i liveHistory
    // utan att en rad här behöver ändras.
    const wanted = rows.filter((row) => {
      const executionTarget = text(row.executionTarget || row.execution_target) || 'ibkr_paper';
      return target === 'live'
        ? executionTarget === 'ibkr_live'
        : executionTarget !== 'ibkr_live';
    });

    const written = [];
    const skipped = [];
    const experiments = [];
    let duplicates = 0;

    // Redan bokförda affärer, per strategi. Läses en gång.
    const seen = new Map();
    for (const record of library.listStrategies()) {
      const history = target === 'live' ? record.liveHistory : record.paperHistory;
      seen.set(record.strategyId, new Set(history.map((row) => row.tradeId)));
    }

    for (const row of wanted) {
      const strategyId = resolveNativeStrategyId(row.strategyId, registry);
      if (!strategyId) {
        skipped.push({ tradeId: row.tradeId, strategyId: row.strategyId, reason: 'unresolved_strategy_id' });
        continue;
      }
      if (seen.get(strategyId)?.has(row.tradeId)) {
        duplicates += 1;
        continue;
      }

      const payload = {
        strategyId,
        canonicalStrategyId: text(row.canonicalStrategyId || row.originStrategyId || row.strategyId),
        nativeStrategyId: text(row.nativeStrategyId || resolveNativeStrategyId(row.strategyId, registry)),
        originStrategyId: text(row.originStrategyId || row.strategyId),
        strategyVersion: text(row.strategyVersion || row.strategyLogicVersion),
        strategyFamily: text(row.strategyFamily),
        candidateId: text(row.candidateId),
        signalId: text(row.signalId || row.originalSignalId),
        tradeId: row.tradeId,
        openedAt: text(row.openedAt),
        closedAt: text(row.closedAt),
        symbol: text(row.root || row.symbol),
        direction: text(row.side),
        session: text(row.session || row.entrySession?.session),
        sessionId: text(row.sessionId || row.entrySession?.sessionId),
        marketRegime: text(row.marketRegime || row.marketRegimeV2),
        executionTarget: text(row.executionTarget || row.execution_target) || 'ibkr_paper',
        realizedPnlUsd: num(row.realizedPnlUsd),
        exitReason: text(row.exitReason),
        at: at || text(row.closedAt),
      };
      if (target === 'live') library.recordLiveTrade(payload);
      else library.recordPaperTrade(payload);

      if (!seen.has(strategyId)) seen.set(strategyId, new Set());
      seen.get(strategyId).add(row.tradeId);
      written.push({ strategyId, tradeId: row.tradeId });
    }

    // Production Score: samma poängmatematik som Strategy Score, men på
    // VERKLIGA affärer i stället för replay. Det är hela skillnaden mellan de
    // två måtten, och därför räknas de av samma funktion på olika underlag.
    const touched = [...new Set(written.map((row) => row.strategyId))];
    for (const strategyId of touched) {
      const record = library.getStrategy(strategyId);
      const history = target === 'live' ? record.liveHistory : record.paperHistory;
      const scored = history.map((row) => ({ status: 'closed', strategyPnlUsd: row.realizedPnlUsd }));
      const score = strategyScoreV1.scoreTrades(scored, { strategyId });
      library.recordScore({
        strategyId, scoreType: 'productionScore', value: score.total,
        detail: { source: target, trades: scored.length, qualified: score.qualified, band: score.band },
      });
    }

    return {
      ok: true,
      target,
      candidates: wanted.length,
      written: written.length,
      duplicates,
      skipped,
      strategiesTouched: touched,
      ...SAFETY,
    };
  }

  /** Full synk: registret in, sedan paper och live. Idempotent hela vägen. */
  function syncAll({ at = null } = {}) {
    const registrySync = library.syncFromRegistry();
    const paper = ingestExecutionHistory({ target: 'paper', at });
    const live = ingestExecutionHistory({ target: 'live', at });
    return { ok: true, registry: registrySync, paper, live, ...SAFETY };
  }

  return {
    SAFETY,
    recordReplayRun,
    ingestExecutionHistory,
    syncAll,
    _internal: { resolveNativeStrategyId, replayTradesAsScored, readJsonl },
  };
}

module.exports = {
  SAFETY,
  DEFAULT_PAPER_TRADES_FILE,
  createStrategyLibraryRecorder,
  resolveNativeStrategyId,
};
