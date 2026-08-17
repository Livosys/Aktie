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
const strategyScoreV1 = require('../score/strategyScoreV1Service');
const confidenceScore = require('../score/confidenceScoreService');

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

/** Legacy- eller native-id → native-id. Null när det inte går att avgöra. */
function resolveNativeStrategyId(strategyId, registry = nativeRegistry) {
  const id = text(strategyId);
  if (!id) return null;
  if (registry.isNativeStrategyId(id)) return id;
  return registry.soleNativeStrategyForOrigin(id)?.strategyId || null;
}

function createStrategyLibraryRecorder(options = {}) {
  const library = options.library || libraryModule.defaultStrategyLibrary;
  const registry = options.registry || nativeRegistry;
  const paperTradesFile = options.paperTradesFile || DEFAULT_PAPER_TRADES_FILE;

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * Skriver in en replay-körning, en rad per strategi som handlade.
   *
   * @param {object} runResult  från nativeReplayEngineService.run()
   * @param {object} report     från replayReportService.buildReplayReport()
   */
  function recordReplayRun(runResult, report, { runId = null, at = null } = {}) {
    const id = runId || `replay:${runResult.config?.mode}:${runResult.config?.from}:${runResult.config?.to}`;
    const classification = report.marketClassification?.classification || null;
    const executionScore = report.executionScore?.total ?? null;
    const written = [];
    const skipped = [];

    for (const score of report.strategyScore?.perStrategy || []) {
      const strategyId = resolveNativeStrategyId(score.strategyId, registry);
      if (!strategyId) {
        skipped.push({ strategyId: score.strategyId, reason: 'unresolved_strategy_id' });
        continue;
      }

      const trades = [...(runResult.tradesByStrategy?.get(score.strategyId) || [])];
      library.recordReplayRun({
        strategyId,
        runId: id,
        mode: runResult.config?.mode || null,
        from: runResult.config?.from || null,
        to: runResult.config?.effectiveTo || runResult.config?.to || null,
        trades: score.stats.trades,
        winRate: score.stats.winRate,
        strategyPnlUsd: score.stats.strategyPnlUsd,
        strategyScore: score.total,
        executionScore,
        marketClassification: classification,
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
      const conf = confidenceScore.calculateConfidenceScore(
        replayTradesAsScored(record),
        { marketClassifications: (record?.replayHistory || []).map((row) => row.marketClassification) },
      );
      library.recordScore({ strategyId, scoreType: 'confidenceScore', value: conf.total, detail: conf.evidence, at });
      library.recordMarketDna({
        strategyId,
        classifications: (record?.replayHistory || []).map((row) => row.marketClassification),
        at,
      });

      written.push({ strategyId, trades: trades.length, strategyScore: score.total });
    }

    return { ok: true, runId: id, written, skipped, ...SAFETY };
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
        tradeId: row.tradeId,
        openedAt: text(row.openedAt),
        closedAt: text(row.closedAt),
        symbol: text(row.root || row.symbol),
        direction: text(row.side),
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
