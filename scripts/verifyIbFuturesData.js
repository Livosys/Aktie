'use strict';

/**
 * FAS 1 — IB Futures Data Verification Probe (READ-ONLY).
 *
 * Verifierar mot IB Gateway (paper, 127.0.0.1:4002) att vi kan hämta:
 *   - contract details (front month) för MNQ/MES/ES/NQ
 *   - realtime snapshot (reqMktData) + marketDataType (realtime/delayed)
 *   - historical bars: 1 min, 2 mins, 5 mins, 15 mins, 1 hour, 1 day
 *   - historical ticks (reqHistoricalTicks)
 *   - continuous contract (CONTFUT) för historikdjup
 *
 * HÅRDA REGLER:
 *   - Endast queries. Ingen order, ingen submit, ingen arm, ingen risk.
 *   - Egen clientId (default 957) så att den aldrig krockar med appens id.
 *   - Sekventiella requests med paus för att respektera IB pacing limits.
 *   - Skriver rapport till scratchpad/ib-futures-data-verification.json.
 *
 * Körning:  node scripts/verifyIbFuturesData.js [--symbols MNQ,MES,ES,NQ] [--deep]
 */

const fs = require('fs');
const path = require('path');
const { IBApi, EventName } = require('@stoqey/ib');

const HOST = process.env.IB_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(process.env.IB_GATEWAY_PORT || 4002);
const CLIENT_ID = Number(process.env.IB_VERIFY_CLIENT_ID || 957);
const REPORT_FILE = path.resolve(__dirname, '../scratchpad/ib-futures-data-verification.json');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const SYMBOLS = String(argValue('--symbols', 'MNQ,MES,ES,NQ')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const DEEP = args.includes('--deep');

const BAR_SIZES = [
  { barSize: '1 min', duration: '1 D' },
  { barSize: '2 mins', duration: '1 D' },
  { barSize: '5 mins', duration: '2 D' },
  { barSize: '15 mins', duration: '1 W' },
  { barSize: '1 hour', duration: '1 W' },
  { barSize: '1 day', duration: '1 Y' },
];

// Djupprober: hur långt bak finns 1m/2m-data för aktiva kontraktet + CONTFUT.
const DEPTH_PROBES = [
  { barSize: '1 min', duration: '1 W' },
  { barSize: '1 min', duration: '1 M' },
  { barSize: '2 mins', duration: '1 M' },
  { barSize: '1 day', duration: '3 Y', contfut: true },
];

const PACING_MS = 2000; // konservativ paus mellan historical-requests
const REQUEST_TIMEOUT_MS = 25000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function buildFutContract(symbol) {
  return { symbol, secType: 'FUT', exchange: 'CME', currency: 'USD' };
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    host: HOST,
    port: PORT,
    clientId: CLIENT_ID,
    readOnly: true,
    safety: {
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    },
    connection: { connected: false, error: null },
    marketDataTypeRequested: 1,
    symbols: {},
    pacing: { pauseMsBetweenHistoricalRequests: PACING_MS },
    notes: [],
  };

  const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
  let nextReqId = 9000;
  const pending = new Map(); // reqId -> {resolve, reject, rows, kind, timer}

  function track(reqId, kind) {
    return new Promise((resolve) => {
      const entry = {
        kind,
        rows: [],
        done: (result) => {
          clearTimeout(entry.timer);
          pending.delete(reqId);
          resolve(result);
        },
      };
      entry.timer = setTimeout(() => entry.done({ ok: false, error: 'timeout', rows: entry.rows }), REQUEST_TIMEOUT_MS);
      pending.set(reqId, entry);
    });
  }

  ib.on(EventName.error, (err, code, reqId) => {
    const message = err instanceof Error ? err.message : String(err);
    const entry = pending.get(reqId);
    // Informational codes (2104/2106/2158 = data farm OK) ska inte fälla en request.
    const informational = [2104, 2106, 2107, 2108, 2158, 2119].includes(Number(code));
    if (entry && !informational) {
      entry.done({ ok: false, error: message, code: Number(code) || null, rows: entry.rows });
    } else if (!entry && !informational) {
      report.notes.push({ type: 'error', code: Number(code) || null, message });
    }
  });

  ib.on(EventName.contractDetails, (reqId, details) => {
    const entry = pending.get(reqId);
    if (entry) entry.rows.push(details);
  });
  ib.on(EventName.contractDetailsEnd, (reqId) => {
    const entry = pending.get(reqId);
    if (entry) entry.done({ ok: true, rows: entry.rows });
  });

  ib.on(EventName.historicalData, (reqId, time, open, high, low, close, volume) => {
    const entry = pending.get(reqId);
    if (!entry) return;
    if (String(time).startsWith('finished')) {
      entry.done({ ok: true, rows: entry.rows });
      return;
    }
    entry.rows.push({ time, open, high, low, close, volume });
  });

  ib.on(EventName.historicalTicksLast, (reqId, ticks, done) => {
    const entry = pending.get(reqId);
    if (!entry) return;
    entry.rows.push(...(ticks || []));
    if (done) entry.done({ ok: true, rows: entry.rows });
  });

  // Snapshot ticks: samla last/bid/ask/close + marketDataType per reqId.
  const snapshotState = new Map();
  ib.on(EventName.marketDataType, (reqId, mdType) => {
    const s = snapshotState.get(reqId);
    if (s) s.marketDataType = mdType;
  });
  ib.on(EventName.tickPrice, (reqId, field, value) => {
    const s = snapshotState.get(reqId);
    if (!s || !(value > 0)) return;
    // 1/66=bid 2/67=ask 4/68=last 9/75=close (66-76 = delayed varianter)
    if (field === 4 || field === 68) s.last = value;
    else if (field === 1 || field === 66) s.bid = value;
    else if (field === 2 || field === 67) s.ask = value;
    else if (field === 9 || field === 75) s.close = value;
    if (field >= 66 && field <= 76) s.sawDelayedField = true;
  });
  ib.on(EventName.tickSnapshotEnd, (reqId) => {
    const entry = pending.get(reqId);
    if (entry) entry.done({ ok: true, rows: [snapshotState.get(reqId) || {}] });
  });

  const connected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    ib.once(EventName.nextValidId, () => { clearTimeout(timer); resolve(true); });
    ib.once(EventName.connected, () => {});
    try { ib.connect(); } catch (_) { clearTimeout(timer); resolve(false); }
  });

  report.connection.connected = connected;
  if (!connected) {
    report.connection.error = 'ib_gateway_unreachable_or_not_logged_in';
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: false, error: report.connection.error, reportFile: REPORT_FILE }, null, 2));
    process.exit(2);
  }

  // Begär realtime; IB nedgraderar själv till delayed om prenumeration saknas.
  ib.reqMarketDataType(1);

  for (const symbol of SYMBOLS) {
    const symReport = { contract: null, snapshot: null, historical: {}, ticks: null, depth: {} };
    report.symbols[symbol] = symReport;

    // 1) Contract details → front month (närmast lastTradeDate i framtiden)
    const cdReqId = nextReqId++;
    const cdPromise = track(cdReqId, 'contractDetails');
    ib.reqContractDetails(cdReqId, buildFutContract(symbol));
    const cd = await cdPromise;
    if (!cd.ok || !cd.rows.length) {
      symReport.contract = { ok: false, error: cd.error || 'no_contract_details', code: cd.code || null };
      continue;
    }
    const sorted = cd.rows
      .map((d) => d.contract || d)
      .filter((c) => c && c.lastTradeDateOrContractMonth)
      .sort((a, b) => String(a.lastTradeDateOrContractMonth).localeCompare(String(b.lastTradeDateOrContractMonth)));
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const front = sorted.find((c) => String(c.lastTradeDateOrContractMonth).slice(0, 8) >= today) || sorted[0];
    symReport.contract = {
      ok: true,
      count: cd.rows.length,
      conId: front.conId,
      localSymbol: front.localSymbol,
      lastTradeDate: front.lastTradeDateOrContractMonth,
      exchange: front.exchange,
    };
    const contract = { conId: front.conId, exchange: front.exchange || 'CME', secType: 'FUT', symbol, currency: 'USD' };

    // 2) Snapshot market data
    const mdReqId = nextReqId++;
    snapshotState.set(mdReqId, { marketDataType: null, sawDelayedField: false });
    const mdPromise = track(mdReqId, 'snapshot');
    ib.reqMktData(mdReqId, contract, '', true, false);
    const md = await mdPromise;
    const snap = snapshotState.get(mdReqId) || {};
    symReport.snapshot = {
      ok: md.ok && (snap.last != null || snap.bid != null || snap.close != null),
      error: md.ok ? null : md.error,
      code: md.code || null,
      marketDataType: snap.marketDataType,
      marketDataTypeLabel: { 1: 'realtime', 2: 'frozen', 3: 'delayed', 4: 'delayed_frozen' }[snap.marketDataType] || 'unknown',
      sawDelayedField: snap.sawDelayedField === true,
      last: snap.last ?? null,
      bid: snap.bid ?? null,
      ask: snap.ask ?? null,
      close: snap.close ?? null,
    };
    snapshotState.delete(mdReqId);
    await sleep(500);

    // 3) Historical bars per barSize
    for (const { barSize, duration } of BAR_SIZES) {
      const hReqId = nextReqId++;
      const hPromise = track(hReqId, 'historical');
      ib.reqHistoricalData(hReqId, contract, '', duration, barSize, 'TRADES', 0, 2, false);
      const h = await hPromise;
      symReport.historical[barSize] = {
        ok: h.ok && h.rows.length > 0,
        bars: h.rows.length,
        firstBar: h.rows[0]?.time || null,
        lastBar: h.rows[h.rows.length - 1]?.time || null,
        error: h.ok ? null : h.error,
        code: h.code || null,
      };
      await sleep(PACING_MS);
    }

    // 4) Historical ticks (senaste 1000 trades)
    const tReqId = nextReqId++;
    const tPromise = track(tReqId, 'historicalTicks');
    try {
      ib.reqHistoricalTicks(tReqId, contract, '', new Date().toISOString().slice(0, 10).replace(/-/g, '') + ' 23:59:59', 1000, 'TRADES', 0, false);
      const t = await tPromise;
      symReport.ticks = { ok: t.ok && t.rows.length > 0, count: t.rows.length, error: t.ok ? null : t.error, code: t.code || null };
    } catch (err) {
      symReport.ticks = { ok: false, error: err.message };
    }
    await sleep(PACING_MS);

    // 5) Djupprober (endast --deep, och endast första symbolen för pacing)
    if (DEEP && symbol === SYMBOLS[0]) {
      for (const probe of DEPTH_PROBES) {
        const dReqId = nextReqId++;
        const dPromise = track(dReqId, 'depth');
        const target = probe.contfut
          ? { symbol, secType: 'CONTFUT', exchange: 'CME', currency: 'USD' }
          : contract;
        ib.reqHistoricalData(dReqId, target, '', probe.duration, probe.barSize, 'TRADES', 0, 2, false);
        const d = await dPromise;
        symReport.depth[`${probe.contfut ? 'CONTFUT ' : ''}${probe.barSize} ${probe.duration}`] = {
          ok: d.ok && d.rows.length > 0,
          bars: d.rows.length,
          firstBar: d.rows[0]?.time || null,
          lastBar: d.rows[d.rows.length - 1]?.time || null,
          error: d.ok ? null : d.error,
          code: d.code || null,
        };
        await sleep(PACING_MS);
      }
    }
  }

  try { ib.disconnect(); } catch (_) { /* ignore */ }

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  const summary = {};
  for (const [symbol, r] of Object.entries(report.symbols)) {
    summary[symbol] = {
      contract: r.contract?.ok === true ? r.contract.localSymbol : `FAIL:${r.contract?.error}`,
      snapshot: r.snapshot?.ok === true ? `${r.snapshot.marketDataTypeLabel} last=${r.snapshot.last}` : `FAIL:${r.snapshot?.error || 'no_price'}`,
      historical: Object.fromEntries(Object.entries(r.historical).map(([k, v]) => [k, v.ok ? `${v.bars} bars` : `FAIL:${v.error}`])),
      ticks: r.ticks?.ok === true ? `${r.ticks.count} ticks` : `FAIL:${r.ticks?.error}`,
    };
  }
  console.log(JSON.stringify({ ok: true, reportFile: REPORT_FILE, summary }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
