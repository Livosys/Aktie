'use strict';

const path = require('path');
const marketDataStore = require('../../data/marketDataStore');
const validator = require('./ibHistoricalBackfillValidator');
const futuresMarketHours = require('../futuresMarketHoursService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  source: 'ib_historical_dataset_manifest',
});

const ROOTS = Object.freeze(['MNQ', 'MES']);

function iso(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function contractKey(contract = {}, root = '') {
  const conId = contract.conId == null ? '' : String(contract.conId).trim();
  const localSymbol = contract.localSymbol == null ? '' : String(contract.localSymbol).trim();
  const rawExpiry = String(contract.expiry || contract.lastTradeDateOrContractMonth || '').trim();
  const compact = rawExpiry.match(/^(\d{4})(\d{2})(\d{2})/);
  const expiry = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : rawExpiry.slice(0, 10);
  return [root, conId || localSymbol || 'unknown-conid', expiry || 'unknown-expiry'].join(':');
}

function readManifest(root, loader) {
  try { return typeof loader === 'function' ? loader(root) : null; } catch (_) { return null; }
}

function buildRootManifest(root, { dataStore = marketDataStore, manifestLoader = null } = {}) {
  const listed = dataStore.listAvailableDates(root) || {};
  const dates = [...new Set([...(listed.raw || []), ...(listed['2m'] || [])])].sort();
  const importManifest = readManifest(root, manifestLoader || dataStore.loadIbImportManifest?.bind(dataStore));
  const days = [];
  const identities = new Set();
  const qualityIssues = [];
  const barsByTradingDay = new Map();

  for (const date of dates) {
    let bars = [];
    try { bars = dataStore.loadRawBars(root, date, date, 'ib') || []; } catch (err) {
      qualityIssues.push({ date, issue: 'raw_read_failed', detail: err.message });
    }
    for (const bar of bars) {
      const timestamp = bar.ts || bar.t || bar.timestamp;
      const tradingDay = bar.tradingDay
        || futuresMarketHours.buildFuturesSessionMetadata(timestamp)?.tradingDay
        || date;
      if (!barsByTradingDay.has(tradingDay)) barsByTradingDay.set(tradingDay, []);
      barsByTradingDay.get(tradingDay).push({ ...bar, __sourceDate: date });
    }
  }

  for (const [date, bars] of [...barsByTradingDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = bars[0]?.ts || bars[0]?.t || bars[0]?.timestamp || null;
    const last = bars.at(-1)?.ts || bars.at(-1)?.t || bars.at(-1)?.timestamp || null;
    const rowIdentities = [...new Set(bars.map((bar) => bar.contractKey).filter(Boolean))];
    const sourceDates = [...new Set(bars.map((bar) => bar.__sourceDate).filter(Boolean))].sort();
    rowIdentities.forEach((value) => identities.add(value));
    const window = futuresMarketHours.getCanonicalTradingDayWindow(date);
    const validation = window
      ? validator.validateBars(bars, {
        from: window.startUtc,
        to: window.endUtc,
        session: 'cme_globex',
        timezone: 'UTC',
      })
      : { ok: false, errors: ['invalid_canonical_trading_day'], gaps: { ok: false, missingCount: null }, duplicateCount: null, monotonic: false, timezone: { ok: false }, session: { ok: false } };
    const structuralErrors = validation.errors.filter((error) => error !== 'missing_expected_minutes');
    structuralErrors.forEach((issue) => qualityIssues.push({ date, issue }));
    days.push({
      date,
      tradingDay: date,
      sourceDates,
      barCount1m: bars.length,
      firstTimestamp: iso(first),
      lastTimestamp: iso(last),
      contractIdentities: rowIdentities,
      completeness: bars.length === 0 ? 'missing' : (validation.gaps.ok && structuralErrors.length === 0 ? 'complete' : 'partial'),
      quality: structuralErrors.length ? 'degraded' : (validation.gaps.ok ? 'complete' : 'partial'),
      validation: {
        duplicateCount: validation.duplicateCount,
        missingCount: validation.gaps.missingCount,
        monotonic: validation.monotonic,
        timezoneOk: validation.timezone.ok,
        sessionOk: validation.session.ok,
      },
    });
  }

  const manifestContract = importManifest?.contract || null;
  if (manifestContract) identities.add(contractKey(manifestContract, root));
  const populated = days.filter((day) => day.barCount1m > 0);
  const completeDays = days.filter((day) => day.completeness === 'complete').map((day) => day.date);
  const partialDays = days.filter((day) => day.completeness === 'partial').map((day) => day.date);
  const allBars = [...barsByTradingDay.values()].flat();
  const exactRows = allBars.filter((bar) => bar.contractKey);
  const contractDates = typeof dataStore.listAvailableContractDates === 'function'
    ? dataStore.listAvailableContractDates(root, 'ib')
    : {};
  const contractCoverage = Object.keys(contractDates).sort().map((identity) => {
    const contractBars = [];
    for (const date of contractDates[identity]) {
      try {
        contractBars.push(...(dataStore.loadRawBars(root, date, date, 'ib', { contractKey: identity }) || []));
      } catch (err) {
        qualityIssues.push({ contractKey: identity, date, issue: 'contract_read_failed', detail: err.message });
      }
    }
    const tradingDays = [...new Set(contractBars.map((bar) => bar.tradingDay).filter(Boolean))].sort();
    return {
      contractKey: identity,
      dates: contractDates[identity],
      tradingDays,
      barCount1m: contractBars.length,
      provenanceQuality: contractBars.length && contractBars.every((bar) => bar.contractKey === identity)
        ? 'exact_provenance' : 'ambiguous',
      source: 'ibkr',
    };
  });
  const provenanceQuality = !populated.length || !allBars.length
    ? 'manifest_only'
    : (exactRows.length === allBars.length ? 'exact_provenance' : (exactRows.length ? 'ambiguous' : 'manifest_only'));

  return {
    root,
    source: 'ibkr',
    timeframes: ['1m', '2m'],
    contractProvenance: {
      identities: [...identities].sort(),
      manifestContract,
      perBarIdentity: populated.length > 0 && exactRows.length === allBars.length,
      provenanceQuality,
      status: identities.size === 0 ? 'missing' : (provenanceQuality === 'exact_provenance' ? 'complete' : 'manifest_only'),
      contractCoverage,
    },
    coverage: {
      earliest: populated[0]?.firstTimestamp || null,
      latest: populated.at(-1)?.lastTimestamp || null,
      calendarDates: dates,
      completeDays,
      partialDays,
    },
    quality: {
      status: qualityIssues.length ? 'degraded' : 'ok',
      issues: qualityIssues,
    },
    days,
    importManifest: importManifest ? {
      provider: importManifest.provider || null,
      importedAt: importManifest.importedAt || null,
      dates: importManifest.dates || [],
    } : null,
  };
}

function buildIbHistoricalDatasetManifest({ roots = ROOTS, dataStore = marketDataStore, manifestLoader = null, now = new Date() } = {}) {
  const normalizedRoots = roots.map((root) => String(root).trim().toUpperCase()).filter(Boolean);
  return {
    manifestVersion: 'ib-historical-dataset-manifest-v1',
    generatedAt: new Date(now).toISOString(),
    roots: normalizedRoots.map((root) => buildRootManifest(root, { dataStore, manifestLoader })),
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  ROOTS,
  buildIbHistoricalDatasetManifest,
  _internal: { contractKey, buildRootManifest },
};
