'use strict';
const fs   = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  agent_mode: 'config_only',
});

const DATA_FILE = path.resolve(__dirname, '../../data/config/blocker-config.json');

const CONFIGURABLE_BLOCKERS = [
  { key: 'low_confidence',      label: 'Låg styrka',              desc: 'Signal under confidence-tröskel' },
  { key: 'memory_block',        label: 'Minnesblockning',         desc: 'Historiskt minne blockerar' },
  { key: 'market_gate_block',   label: 'Marknadsgrind',           desc: 'Marknaden är för stökig' },
  { key: 'mixed_market',        label: 'Blandad marknad',         desc: 'Motstridiga signaler på marknaden' },
  { key: 'weak_volume',         label: 'Svag volym',              desc: 'Volym bekräftar inte signalen' },
  { key: 'cooldown',            label: 'Cooldown',                desc: 'Väntar mellan trades' },
  { key: 'tradingagents_observe', label: 'Tradingagenter OBSERVE', desc: 'Agenter rekommenderar avvakta' },
  { key: 'risk_warning',        label: 'Riskvarning',             desc: 'Riskmotorn varnar' },
  { key: 'spread_warning',      label: 'Spreadvarning',           desc: 'Spreaden är ovanligt hög' },
];

const ALWAYS_HARD_BLOCKERS = [
  { key: 'execution_safety',     label: 'Execution Safety',       reason: 'Säkerhetsmotor — kan aldrig kringgås' },
  { key: 'kill_switch',          label: 'Kill Switch',            reason: 'Nödstopp — kan aldrig kringgås' },
  { key: 'stale_data',           label: 'Inaktuell data',         reason: 'Data för gammal — kan inte handla' },
  { key: 'provider_down',        label: 'Datakälla nere',         reason: 'Leverantör otillgänglig' },
  { key: 'system_error',         label: 'Systemfel',              reason: 'Internt fel — kan inte handla' },
  { key: 'live_trading_disabled', label: 'Live trading avstängt', reason: 'Systemet är i testläge' },
];

const HARD_BLOCKER_KEYS = new Set(ALWAYS_HARD_BLOCKERS.map(b => b.key));

const DEFAULT_CONFIG = {
  discoveryMode: false,
  blockers: Object.fromEntries(CONFIGURABLE_BLOCKERS.map(b => [b.key, 'block'])),
};

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { ...DEFAULT_CONFIG, updatedAt: null };
  }
}

function save(data) {
  data.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getBlockerConfig() {
  const data = load();
  const blockers = Object.assign({}, DEFAULT_CONFIG.blockers, data.blockers || {});
  return {
    discoveryMode: data.discoveryMode ?? DEFAULT_CONFIG.discoveryMode,
    blockers,
    configurableBlockers: CONFIGURABLE_BLOCKERS,
    alwaysHardBlockers: ALWAYS_HARD_BLOCKERS,
    safetyNote: 'Execution Safety, Kill Switch, Stale Data, Provider Down och System Error kan ALDRIG mjukas upp.',
    updatedAt: data.updatedAt,
    ...SAFETY,
  };
}

function updateBlockerConfig(updates) {
  if (updates.blockers) {
    for (const key of Object.keys(updates.blockers)) {
      if (HARD_BLOCKER_KEYS.has(key)) {
        return { ok: false, error: `${key} kan inte ändras — alltid block`, ...SAFETY };
      }
    }
  }
  const data = load();
  if (updates.discoveryMode !== undefined) data.discoveryMode = updates.discoveryMode;
  if (updates.blockers) data.blockers = Object.assign({}, data.blockers || {}, updates.blockers);
  save(data);
  return { ok: true, ...getBlockerConfig() };
}

module.exports = {
  SAFETY,
  CONFIGURABLE_BLOCKERS,
  ALWAYS_HARD_BLOCKERS,
  getBlockerConfig,
  updateBlockerConfig,
};
