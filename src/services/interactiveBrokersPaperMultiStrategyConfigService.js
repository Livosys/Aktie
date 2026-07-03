'use strict';

/**
 * IB Paper Multi-Strategy Test Mode - config resolver (read-only).
 *
 * This module only reads env and returns safe defaults. It never writes env,
 * touches state, opens a broker connection, or sends/cancels orders.
 */

const MODE_FLAG = 'IB_PAPER_MULTI_STRATEGY_TEST_MODE';
const ETF_FLAG = 'IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF';
const SUBMIT_ROUTES_FLAG = 'IB_PAPER_SUBMIT_ROUTES_ENABLED';

const DEFAULT_LIMITS = Object.freeze({
  maxCandidates: 20,
  globalDailyCap: 10,
  perStrategyDailyCap: 3,
  forceQuantity: 1,
  bracketRequired: true,
  entryOnlyBlocked: true,
  openOrderPositionGuard: true,
  duplicateGuardMinutes: 30,
  cryptoBlocked: true,
});

function readFlag(name, env = process.env) {
  return ['true', '1', 'yes', 'on'].includes(String(env?.[name] ?? '').trim().toLowerCase());
}

function getIbPaperMultiStrategyConfig(env = process.env) {
  return {
    enabled: readFlag(MODE_FLAG, env),
    includeEtf: readFlag(ETF_FLAG, env),
    ...DEFAULT_LIMITS,
  };
}

function getIbPaperMultiStrategyLimits(env = process.env) {
  const cfg = getIbPaperMultiStrategyConfig(env);
  return {
    maxCandidates: cfg.maxCandidates,
    globalDailyCap: cfg.globalDailyCap,
    perStrategyDailyCap: cfg.perStrategyDailyCap,
    forceQuantity: cfg.forceQuantity,
    bracketRequired: cfg.bracketRequired,
    entryOnlyBlocked: cfg.entryOnlyBlocked,
    openOrderPositionGuard: cfg.openOrderPositionGuard,
    duplicateGuardMinutes: cfg.duplicateGuardMinutes,
    includeEtf: cfg.includeEtf,
    cryptoBlocked: cfg.cryptoBlocked,
  };
}

module.exports = {
  MODE_FLAG,
  ETF_FLAG,
  SUBMIT_ROUTES_FLAG,
  DEFAULT_LIMITS,
  readFlag,
  getIbPaperMultiStrategyConfig,
  getIbPaperMultiStrategyLimits,
};
