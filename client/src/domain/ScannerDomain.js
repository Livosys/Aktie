// Live Scanner: radarn över vad som scannas just nu.
//
// Raden är (strategi × symbol), inte strategi — en strategi som bevakar både MNQ
// och MES scannar två marknader och ska synas som två rader. Allt härleds ur
// runtime-snapshotens befintliga fält (strategyOverview, candidateQueue, scanner,
// scanHistory, brokerPositions). Ingen ny datamodell, ingen ny persistence och
// ingen ny backend — modulen läser, den frågar aldrig.

import { hasValue } from '../utils/tradingFormatters.js';
import {
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiName,
  uiStatus,
} from '../services/uiTerminologyService.js';

const DEFAULT_SCAN_INTERVAL_MS = 60_000;

// Statusarna är sorterade efter hur nära entry raden är. Första träffen vinner,
// så en strategi med öppen position rapporteras aldrig som "Scanning".
export const SCANNER_STATUS = {
  IN_POSITION: 'in_position',
  SUBMITTED: 'submitted',
  CANDIDATE: 'candidate',
  SETUP_READY: 'setup_ready',
  COOLDOWN: 'cooldown',
  SCANNING: 'scanning',
  WAITING: 'waiting',
  BLOCKED: 'blocked',
};

const STATUS_META = {
  [SCANNER_STATUS.IN_POSITION]: { label: 'In Position', dot: '🟣', tone: 'info', rank: 0, active: true },
  [SCANNER_STATUS.SUBMITTED]: { label: 'Submitted', dot: '🟢', tone: 'success', rank: 1, active: true },
  [SCANNER_STATUS.CANDIDATE]: { label: uiName(FACTORY_TERM_KEYS.CANDIDATE), dot: '🔵', tone: 'info', rank: 2, active: true },
  [SCANNER_STATUS.SETUP_READY]: { label: 'Setup Ready', dot: '🟠', tone: 'warning', rank: 3, active: true },
  [SCANNER_STATUS.COOLDOWN]: { label: 'Cooldown', dot: '⚪', tone: 'neutral', rank: 4, active: true },
  [SCANNER_STATUS.SCANNING]: { label: 'Scanning', dot: '🟢', tone: 'success', rank: 5, active: true },
  [SCANNER_STATUS.WAITING]: { label: uiStatus(FACTORY_STATUS_KEYS.WAITING), dot: '🟡', tone: 'warning', rank: 6, active: true },
  [SCANNER_STATUS.BLOCKED]: { label: 'Blocked', dot: '⚪', tone: 'neutral', rank: 7, active: false },
};

// Cooldown och trade cap är samma sak för radarn: strategin får inte ta en trade
// till just nu, men den är inte trasig. Den ska inte se ut som en blockering.
const COOLDOWN_PATTERN = /cooldown|trade_cap|daily_cap|max_trades|consecutive_loss|cool_down/i;
const SUBMITTED_PATTERN = /submit|sent|working|accepted|presubmit|pending_broker|routed/i;
const POSITION_PATTERN = /in_position|position_open|active_paper/i;

export const EMPTY_SCANNER_FILTERS = Object.freeze({
  status: 'all',
  symbol: 'all',
  family: 'all',
  search: '',
  activeOnly: true,
});

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function msOrNull(value) {
  if (!hasValue(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function idText(value) {
  return hasValue(value) ? String(value) : null;
}

function candidateStrategyId(candidate = {}) {
  return idText(firstValue(
    candidate.strategyId,
    candidate.strategy_id,
    candidate.resolvedStrategyId,
    candidate.canonicalStrategyId,
  ));
}

function candidateSymbol(candidate = {}) {
  return idText(firstValue(
    candidate.symbol,
    candidate.root,
    candidate.futuresSymbol,
    candidate.mappedFuturesSymbol,
    candidate.localSymbol,
  ));
}

function positionSymbol(position = {}) {
  return idText(firstValue(position.root, position.symbol, position.localSymbol));
}

// Instrumentlistan i overview-raden är redan normaliserad av backend. Vi delar
// bara på den när den kommer som sammanslagen sträng ("MNQ / MES").
function rowInstruments(overviewRow = {}) {
  const list = toArray(overviewRow.instruments).map((value) => idText(value)).filter(Boolean);
  if (list.length) return list;
  const single = idText(overviewRow.instrument);
  if (!single) return [];
  return single.split('/').map((part) => part.trim()).filter(Boolean);
}

// Scanner-kadensen mäts, den antas inte: medianavståndet mellan de senaste
// scanstarterna är sanningen om hur ofta radarn faktiskt sveper.
export function scanIntervalMs(scanHistory = []) {
  const times = toArray(scanHistory)
    .map((row) => msOrNull(row.startedAt || row.timestamp || row.createdAt))
    .filter((value) => value != null)
    .sort((a, b) => b - a)
    .slice(0, 12);
  const deltas = [];
  for (let index = 0; index < times.length - 1; index += 1) {
    const delta = times[index] - times[index + 1];
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return DEFAULT_SCAN_INTERVAL_MS;
  deltas.sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
  return Math.round(median) || DEFAULT_SCAN_INTERVAL_MS;
}

function resolveStatus({ overviewRow, candidate, position }) {
  if (position) return SCANNER_STATUS.IN_POSITION;

  const candidateStatus = String(candidate?.status || '');
  if (candidateStatus && POSITION_PATTERN.test(candidateStatus)) return SCANNER_STATUS.IN_POSITION;
  if (candidateStatus && SUBMITTED_PATTERN.test(candidateStatus)) return SCANNER_STATUS.SUBMITTED;
  if (candidate) return SCANNER_STATUS.CANDIDATE;

  if (overviewRow.entryReady === true) return SCANNER_STATUS.SETUP_READY;

  const blocker = String(firstValue(overviewRow.mainBlocker, overviewRow.reasonCode, overviewRow.paperBlockedReason) || '');
  if (blocker && COOLDOWN_PATTERN.test(blocker)) return SCANNER_STATUS.COOLDOWN;

  if (overviewRow.canTradeNow === true) return SCANNER_STATUS.SCANNING;
  // Sessionen är öppen för strategin men något villkor saknas — den bevakar,
  // den är inte trasig.
  if (overviewRow.marketOpen === true && overviewRow.status === 'READY_WAITING_FOR_SIGNAL') {
    return SCANNER_STATUS.WAITING;
  }
  if (overviewRow.marketOpen === true) return SCANNER_STATUS.WAITING;
  return SCANNER_STATUS.BLOCKED;
}

// Villkoren som backend redan räknat ut: vad som krävs, vad som saknas och vad
// som varnar. Vi hittar inte på nya regler, vi visar dem som finns.
function conditionModel(overviewRow = {}, candidate = null) {
  const required = toArray(overviewRow.requiredContext).map(String);
  const missing = new Set([
    ...toArray(overviewRow.missingComponents).map(String),
    ...toArray(overviewRow.canonicalReadiness?.evidenceGaps).map(String),
  ]);
  const met = required.filter((item) => !missing.has(item));
  const extraMissing = Array.from(missing).filter((item) => !required.includes(item));
  return {
    met,
    missing: [...required.filter((item) => missing.has(item)), ...extraMissing],
    warnings: toArray(overviewRow.warnings).map(String),
    blockedReason: firstValue(
      overviewRow.mainBlocker,
      overviewRow.reasonCode,
      overviewRow.paperBlockedReason,
      candidate?.blockedReason,
      candidate?.blockReason,
    ),
  };
}

// Indikatorvärden kommer aldrig från en ny beräkning — bara från de fält
// kandidaten eller signalen redan bär med sig.
function indicatorModel(candidate = null, overviewRow = {}) {
  const source = firstValue(
    candidate?.indicators,
    candidate?.rawSignalSummary?.indicators,
    candidate?.rawSignalSummary,
    overviewRow.latestCandidate?.indicators,
    overviewRow.latestCandidate?.rawSignalSummary,
  );
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  return Object.entries(source)
    .filter(([, value]) => value == null || typeof value !== 'object')
    .map(([label, value]) => ({ label, value }));
}

export function buildScannerRows({
  strategyOverview = [],
  candidates = [],
  brokerPositions = [],
  scanner = {},
  scanHistory = [],
  quotes = [],
  resolveStrategy = null,
  now = Date.now(),
} = {}) {
  const intervalMs = scanIntervalMs(scanHistory);
  const globalLastScanMs = msOrNull(scanner.lastScanAt);

  const candidateByKey = new Map();
  for (const candidate of toArray(candidates)) {
    const strategyId = candidateStrategyId(candidate);
    if (!strategyId) continue;
    const symbol = candidateSymbol(candidate);
    // Kandidaten indexeras både med och utan symbol: alla producenter skriver
    // inte ut futures-symbolen på kandidaten.
    if (symbol) candidateByKey.set(`${strategyId}::${symbol}`, candidate);
    if (!candidateByKey.has(strategyId)) candidateByKey.set(strategyId, candidate);
  }

  const positionsByStrategy = new Map();
  const positionsBySymbol = new Map();
  for (const position of toArray(brokerPositions)) {
    const strategyId = idText(position.strategyId);
    const symbol = positionSymbol(position);
    if (strategyId && symbol) positionsByStrategy.set(`${strategyId}::${symbol}`, position);
    if (strategyId && !positionsByStrategy.has(strategyId)) positionsByStrategy.set(strategyId, position);
    if (symbol && !positionsBySymbol.has(symbol)) positionsBySymbol.set(symbol, position);
  }

  const quoteBySymbol = new Map();
  for (const quote of toArray(quotes)) {
    const symbol = idText(firstValue(quote.root, quote.symbol, quote.localSymbol));
    if (symbol && !quoteBySymbol.has(symbol)) quoteBySymbol.set(symbol, quote);
  }

  const rows = [];
  for (const overviewRow of toArray(strategyOverview)) {
    const strategyId = idText(overviewRow.strategyId);
    if (!strategyId) continue;
    const symbols = rowInstruments(overviewRow);
    // Utan futures-mappning scannas strategin inte alls — den hör hemma i
    // strategikatalogen, inte på radarn.
    if (!symbols.length) continue;

    const strategy = typeof resolveStrategy === 'function'
      ? resolveStrategy({ strategyId })
      : null;

    for (const symbol of symbols) {
      const candidate = candidateByKey.get(`${strategyId}::${symbol}`) || candidateByKey.get(strategyId) || null;
      const openPaperPosition = overviewRow.openPaperPosition || null;
      const position = positionsByStrategy.get(`${strategyId}::${symbol}`)
        || positionsByStrategy.get(strategyId)
        || (openPaperPosition && (openPaperPosition.symbol === symbol || !openPaperPosition.symbol)
          ? openPaperPosition
          : null)
        || null;

      const status = resolveStatus({ overviewRow, candidate, position });
      const meta = STATUS_META[status];
      const lastScanMs = firstNumber(
        msOrNull(candidate?.signalTimestamp),
        msOrNull(candidate?.timestamp),
        msOrNull(candidate?.createdAt),
        globalLastScanMs,
      );

      rows.push({
        key: `${strategyId}::${symbol}`,
        strategyId,
        strategyName: firstValue(overviewRow.displayName, strategy?.strategyName, strategyId),
        strategyFamily: firstValue(overviewRow.family, overviewRow.strategyFamily, strategy?.strategyFamily),
        symbol,

        status,
        statusLabel: meta.label,
        statusDot: meta.dot,
        statusTone: meta.tone,
        statusRank: meta.rank,
        activeOnRadar: meta.active,

        direction: firstValue(
          candidate?.direction,
          overviewRow.latestCandidate?.direction,
          position?.direction,
          position?.side,
          strategy?.direction,
        ),
        score: firstNumber(
          candidate?.score,
          overviewRow.score,
          strategy?.performance?.score,
        ),
        signalStrength: firstNumber(
          candidate?.signalStrength,
          candidate?.strength,
          candidate?.confidence,
          overviewRow.canonicalReadiness?.canonicalSignal?.strength,
          overviewRow.latestCandidate?.confidence,
        ),

        lastScanAt: lastScanMs,
        // Nästa svep är en projektion av mätt kadens, inte ett schema vi äger.
        nextScanAt: globalLastScanMs != null ? globalLastScanMs + intervalMs : null,
        scanIntervalMs: intervalMs,

        candidateId: idText(firstValue(
          overviewRow.currentCandidateId,
          overviewRow.candidateId,
          candidate?.candidateId,
        )),
        position: position ? {
          symbol: firstValue(positionSymbol(position), symbol),
          direction: firstValue(position.direction, position.side),
          quantity: firstNumber(position.quantity),
          openedAt: firstValue(position.openedAt, position.entryTime),
        } : null,

        // Detaljvyn — allt nedan visas först när raden expanderas.
        marketRegime: firstValue(overviewRow.marketRegime, strategy?.marketRegime),
        session: firstValue(overviewRow.currentSession, overviewRow.currentSessionId),
        sessionAllowed: overviewRow.sessionAllowed === true,
        marketOpen: overviewRow.marketOpen === true,
        conditions: conditionModel(overviewRow, candidate),
        indicators: indicatorModel(candidate, overviewRow),
        latestSignal: firstValue(overviewRow.latestSignal, candidate?.signalSubtype, candidate?.decision),
        canonicalCandidate: overviewRow.canonicalReadiness || null,
        canonicalVerdict: firstValue(overviewRow.canonicalVerdict, overviewRow.canonicalReadiness?.verdict),
        entryContractStatus: firstValue(overviewRow.entryContractStatus, overviewRow.compatibilityStatus),
        research: {
          timeoutRate: firstNumber(overviewRow.timeoutRate),
          avgMfe: firstNumber(overviewRow.avgMfe),
          avgMae: firstNumber(overviewRow.avgMae),
          outcomeCounts: overviewRow.outcomeCounts || null,
          entryContractCandidateCount: firstNumber(overviewRow.entryContractCandidateCount),
          entryContractPassCount: firstNumber(overviewRow.entryContractPassCount),
          entryContractBlockCount: firstNumber(overviewRow.entryContractBlockCount),
        },
        quote: quoteBySymbol.get(symbol) || null,
        candidate,
      });
    }
  }

  // Närmast entry överst. Radarn ska aldrig kräva att användaren scrollar för att
  // hitta det som är på väg att hända.
  return rows.sort((a, b) => (
    a.statusRank - b.statusRank
    || (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY)
    || String(a.strategyName).localeCompare(String(b.strategyName))
  ));
}

export function summarizeScanner(rows = [], { scanner = {}, candidates = [], scanHistory = [] } = {}) {
  const list = toArray(rows);
  const strategies = new Set();
  const symbols = new Set();
  let candidateRows = 0;
  let positionRows = 0;

  for (const row of list) {
    if (row.activeOnRadar) {
      strategies.add(row.strategyId);
      symbols.add(row.symbol);
    }
    if (row.candidateId) candidateRows += 1;
    if (row.position) positionRows += 1;
  }

  // Signaler idag räknas ur scanhistoriken för innevarande dygn — samma källa
  // som scannern själv skriver.
  const today = new Date().toISOString().slice(0, 10);
  const signalsToday = toArray(scanHistory)
    .filter((entry) => String(entry.startedAt || '').slice(0, 10) === today)
    .reduce((total, entry) => total + (Number(entry.candidatesCreated) || 0), 0);

  return {
    scanningSymbols: symbols.size,
    activeStrategies: strategies.size,
    candidates: toArray(candidates).length || candidateRows,
    openPositions: positionRows,
    signalsToday,
    latestScanAt: scanner.lastScanAt || null,
    totalRows: list.length,
    activeRows: list.filter((row) => row.activeOnRadar).length,
  };
}

export function scannerFilterOptions(rows = []) {
  const symbols = new Set();
  const families = new Set();
  for (const row of toArray(rows)) {
    if (hasValue(row.symbol)) symbols.add(row.symbol);
    if (hasValue(row.strategyFamily)) families.add(row.strategyFamily);
  }
  return {
    symbols: Array.from(symbols).sort(),
    families: Array.from(families).sort(),
  };
}

export function filterScannerRows(rows = [], filters = EMPTY_SCANNER_FILTERS) {
  const search = String(filters.search || '').trim().toLowerCase();
  return toArray(rows).filter((row) => {
    if (filters.activeOnly && !row.activeOnRadar) return false;
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.symbol !== 'all' && row.symbol !== filters.symbol) return false;
    if (filters.family !== 'all' && row.strategyFamily !== filters.family) return false;
    if (search) {
      const haystack = [row.strategyId, row.strategyName, row.strategyFamily, row.symbol, row.candidateId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export const SCANNER_STATUS_FILTERS = [
  { value: 'all', label: 'Alla' },
  ...Object.entries(STATUS_META).map(([value, meta]) => ({
    value,
    label: `${meta.dot} ${meta.label}`,
  })),
];
