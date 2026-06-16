'use strict';

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const MIN_APPROVED = 1;
const HARD_MAX_APPROVED = 10;
const DEFAULT_MAX_APPROVED = 4;

const DATA_FILE = path.resolve(__dirname, '../../data/automation/paper-allowlist-config.json');

const DEFAULT_CONFIG = Object.freeze({
  maxApproved: DEFAULT_MAX_APPROVED,
  updatedAt: null,
  updatedBy: 'system',
  reason: 'default',
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function readConfigFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { config: { ...DEFAULT_CONFIG }, warning: 'paper_allowlist_config_missing' };
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { config: { ...DEFAULT_CONFIG }, warning: 'paper_allowlist_config_invalid' };
    }

    const rawMaxApproved = Number(parsed.maxApproved);
    const invalid = !Number.isInteger(rawMaxApproved) || rawMaxApproved < MIN_APPROVED || rawMaxApproved > HARD_MAX_APPROVED;
    const config = {
      maxApproved: invalid ? DEFAULT_MAX_APPROVED : rawMaxApproved,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === 'string' && parsed.updatedBy.trim() ? parsed.updatedBy.trim() : DEFAULT_CONFIG.updatedBy,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : DEFAULT_CONFIG.reason,
    };

    return invalid
      ? { config, warning: 'paper_allowlist_config_recovered_from_invalid_value' }
      : { config };
  } catch (_) {
    return { config: { ...DEFAULT_CONFIG }, warning: 'paper_allowlist_config_corrupt' };
  }
}

function writeConfigFile(config) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function normalizeMaxApproved(value) {
  const raw = Number(value);
  if (!Number.isInteger(raw)) {
    return { ok: false, error: 'maxApproved måste vara ett heltal.' };
  }
  if (raw < MIN_APPROVED || raw > HARD_MAX_APPROVED) {
    return { ok: false, error: `maxApproved måste vara mellan ${MIN_APPROVED} och ${HARD_MAX_APPROVED}.` };
  }
  return { ok: true, value: raw };
}

function getPaperAllowlistConfig() {
  const { config, warning } = readConfigFile();
  return {
    ok: true,
    maxApproved: config.maxApproved,
    hardMaxApproved: HARD_MAX_APPROVED,
    minApproved: MIN_APPROVED,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    reason: config.reason,
    ...(warning ? { warning } : {}),
    safety: SAFETY,
  };
}

function updatePaperAllowlistConfig(input = {}) {
  const parsed = normalizeMaxApproved(input.maxApproved);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, ...SAFETY };
  }

  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim()
    : 'manual_ui_config';
  const updatedBy = typeof input.updatedBy === 'string' && input.updatedBy.trim()
    ? input.updatedBy.trim()
    : 'manual_ui_config';

  const current = readConfigFile();
  const currentConfig = current.config || { ...DEFAULT_CONFIG };
  if (currentConfig.maxApproved === parsed.value && currentConfig.reason === reason && currentConfig.updatedBy === updatedBy) {
    return {
      ok: true,
      changed: false,
      ...getPaperAllowlistConfig(),
    };
  }

  const next = {
    maxApproved: parsed.value,
    updatedAt: nowIso(),
    updatedBy,
    reason,
  };
  writeConfigFile(next);

  return {
    ok: true,
    changed: true,
    ...getPaperAllowlistConfig(),
  };
}

module.exports = {
  SAFETY,
  MIN_APPROVED,
  HARD_MAX_APPROVED,
  DEFAULT_MAX_APPROVED,
  DEFAULT_CONFIG,
  getPaperAllowlistConfig,
  updatePaperAllowlistConfig,
};
