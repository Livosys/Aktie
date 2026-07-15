'use strict';

const RETIRED_ERROR = 'internal_futures_simulation_retired';
const DISABLED_ERROR = 'internal_futures_simulation_disabled';
const LEGACY_SOURCE = 'internal_legacy_simulation';

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
  internal_futures_simulation_enabled: false,
  paperOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  broker_enabled: false,
  source: 'futures_internal_simulation_retirement',
});

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function isInternalFuturesSimulationEnabled(options = {}) {
  if (options.allowInternalSimulationForTests === true) return true;
  if (options.internalSimulationEnabled === true) return true;
  return envBool('INTERNAL_FUTURES_SIMULATION_ENABLED', false);
}

function buildRetiredMutationResponse({ action = 'internal_futures_simulation_mutation' } = {}) {
  return {
    ok: false,
    error: DISABLED_ERROR,
    code: RETIRED_ERROR,
    blocker: DISABLED_ERROR,
    blockedReason: DISABLED_ERROR,
    action,
    readOnly: true,
    legacySource: LEGACY_SOURCE,
    executionSource: LEGACY_SOURCE,
    executionTarget: 'ibkr_paper',
    internalSimulationRetired: true,
    ...SAFETY,
  };
}

function buildReadOnlyLegacyMetadata() {
  return {
    readOnly: true,
    activeRuntime: false,
    legacySource: LEGACY_SOURCE,
    source: LEGACY_SOURCE,
    executionSource: LEGACY_SOURCE,
    internalSimulationRetired: true,
    executionTarget: 'ibkr_paper',
  };
}

function buildRuntimeState(options = {}) {
  const enabled = isInternalFuturesSimulationEnabled(options);
  return {
    enabled,
    activeRuntime: enabled === true,
    retired: enabled !== true,
    blocker: enabled ? null : DISABLED_ERROR,
    code: enabled ? null : RETIRED_ERROR,
    executionTarget: 'ibkr_paper',
    legacySource: LEGACY_SOURCE,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  RETIRED_ERROR,
  DISABLED_ERROR,
  LEGACY_SOURCE,
  envBool,
  isInternalFuturesSimulationEnabled,
  buildRetiredMutationResponse,
  buildReadOnlyLegacyMetadata,
  buildRuntimeState,
};
