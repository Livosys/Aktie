'use strict';

// Central, paper-only kontraktskatalog för Futures Paper.
// Enda källan för point value, tick, tick value och simulerad courtage/fee per
// side. Ingen riktig marknadsdata, ingen broker, ingen order — bara siffror som
// futures-paper-simuleringen använder för PnL och avgifter.

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_contract_catalog',
});

// pointValueUsd = tickValueUsd / tickSize för samtliga kontrakt.
// defaultCommissionPerSideUsd = simulerad courtage/fee per köp respektive sälj.
const FUTURES_CONTRACTS = Object.freeze({
  MNQ: Object.freeze({
    root: 'MNQ',
    name: 'Micro E-mini Nasdaq-100',
    underlying: 'Nasdaq 100',
    exchange: 'CME',
    contractClass: 'micro',
    pointValueUsd: 2,
    tickSize: 0.25,
    tickValueUsd: 0.50,
    defaultCommissionPerSideUsd: 1.22,
  }),
  MES: Object.freeze({
    root: 'MES',
    name: 'Micro E-mini S&P 500',
    underlying: 'S&P 500',
    exchange: 'CME',
    contractClass: 'micro',
    pointValueUsd: 5,
    tickSize: 0.25,
    tickValueUsd: 1.25,
    defaultCommissionPerSideUsd: 1.22,
  }),
  NQ: Object.freeze({
    root: 'NQ',
    name: 'E-mini Nasdaq-100',
    underlying: 'Nasdaq 100',
    exchange: 'CME',
    contractClass: 'mini',
    pointValueUsd: 20,
    tickSize: 0.25,
    tickValueUsd: 5.00,
    defaultCommissionPerSideUsd: 2.25,
  }),
  ES: Object.freeze({
    root: 'ES',
    name: 'E-mini S&P 500',
    underlying: 'S&P 500',
    exchange: 'CME',
    contractClass: 'mini',
    pointValueUsd: 50,
    tickSize: 0.25,
    tickValueUsd: 12.50,
    defaultCommissionPerSideUsd: 2.25,
  }),
});

// Längsta root först så att t.ex. MNQ/MES matchas före NQ/ES.
const ROOTS_BY_LENGTH = Object.freeze(
  Object.keys(FUTURES_CONTRACTS).sort((a, b) => b.length - a.length),
);

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normalizeRoot(root, symbol = '') {
  const explicit = String(root || '').trim().toUpperCase();
  if (FUTURES_CONTRACTS[explicit]) return explicit;
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  for (const candidate of ROOTS_BY_LENGTH) {
    if (sym.startsWith(candidate)) return candidate;
  }
  return null;
}

function getContract(root, symbol = '') {
  const normalized = normalizeRoot(root, symbol);
  return normalized ? FUTURES_CONTRACTS[normalized] : null;
}

function isSupportedRoot(root, symbol = '') {
  return normalizeRoot(root, symbol) !== null;
}

function getPointValueUsd(root, symbol = '') {
  const contract = getContract(root, symbol);
  return contract ? contract.pointValueUsd : null;
}

function getTickSize(root, symbol = '') {
  const contract = getContract(root, symbol);
  return contract ? contract.tickSize : null;
}

function getTickValueUsd(root, symbol = '') {
  const contract = getContract(root, symbol);
  return contract ? contract.tickValueUsd : null;
}

function getCommissionPerSideUsd(root, symbol = '') {
  const contract = getContract(root, symbol);
  return contract ? contract.defaultCommissionPerSideUsd : null;
}

// Simulerad avgift för ett antal sidor (1 = bara open eller bara close).
function commissionUsd(root, contracts = 1, sides = 1, symbol = '') {
  const perSide = getCommissionPerSideUsd(root, symbol);
  const size = Number(contracts);
  const sideCount = Number(sides);
  if (perSide == null || !Number.isFinite(size) || size <= 0 || !Number.isFinite(sideCount) || sideCount <= 0) {
    return 0;
  }
  return round(perSide * size * sideCount, 2);
}

// Uppskattad round trip-kostnad (open + close) i USD.
function roundTripCostUsd(root, contracts = 1, symbol = '') {
  return commissionUsd(root, contracts, 2, symbol);
}

function listContracts() {
  return Object.values(FUTURES_CONTRACTS).map((contract) => ({
    ...contract,
    estRoundTripCostUsd: roundTripCostUsd(contract.root, 1),
  }));
}

module.exports = {
  SAFETY,
  FUTURES_CONTRACTS,
  round,
  normalizeRoot,
  getContract,
  isSupportedRoot,
  getPointValueUsd,
  getTickSize,
  getTickValueUsd,
  getCommissionPerSideUsd,
  commissionUsd,
  roundTripCostUsd,
  listContracts,
};
