'use strict';
const fs   = require('fs');
const path = require('path');

const ALPACA_ROOT    = path.resolve(__dirname, '../../data/market-data/alpaca');
const BINANCE_ROOT   = path.resolve(__dirname, '../../data/market-data/binance');
// IB futures raw 1m bars (MNQ/MES) — same layout as alpaca/binance raw
const IB_ROOT        = path.resolve(__dirname, '../../data/market-data/ib');
// Shared 2m candle store (used by both Alpaca and Binance going forward)
const CANDLES_2M_ROOT = path.resolve(__dirname, '../../data/market-data/candles-2m');

// Legacy alias — code that hasn't been updated still uses DATA_ROOT
const DATA_ROOT = ALPACA_ROOT;

// ── Path helpers ──────────────────────────────────────────────────────────────

function rawDir(symbol, source = 'alpaca') {
  const root = source === 'binance' ? BINANCE_ROOT : (source === 'ib' ? IB_ROOT : ALPACA_ROOT);
  return path.join(root, 'raw', symbol);
}
function candles2mDir(symbol) { return path.join(CANDLES_2M_ROOT, symbol); }
// Legacy Alpaca-only 2m path — kept for backward-compat reads
function legacyCandles2mDir(symbol) { return path.join(ALPACA_ROOT, 'candles-2m', symbol); }

function dirForTimeframe(symbol, timeframe) {
  return timeframe === 'raw' ? rawDir(symbol) : candles2mDir(symbol);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function filePath(dir, date) { return path.join(dir, `${date}.jsonl`); }

function contractKeyFromRows(rows = []) {
  const keys = [...new Set(rows.map((row) => row && row.contractKey).filter(Boolean))];
  return keys.length === 1 ? keys[0] : null;
}

function contractDir(dir, contractKey) {
  if (!contractKey) return dir;
  return path.join(dir, 'contracts', encodeURIComponent(String(contractKey)));
}

function contractFilePath(dir, date, contractKey) {
  return filePath(contractDir(dir, contractKey), date);
}

// ── JSONL read / write ────────────────────────────────────────────────────────

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  try {
    return fs.readFileSync(fp, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function timestampMs(row = {}) {
  const raw = row.ts || row.t || row.timestamp;
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeTimestamp(row = {}) {
  const ms = timestampMs(row);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeStoredCandle(row = {}) {
  const ts = normalizeTimestamp(row);
  if (!ts) return null;
  return { ...row, ts, t: ts };
}

// ── Vad som gör två rader till SAMMA bar ─────────────────────────────────────
//
// Nyckeln var tidigare `contract:<contractKey>|<ts>` för rader som bar en
// kontraktsnyckel och `legacy:<ts>` för rader utan. Den skilde alltså på vilken
// KATALOG raden kom ur, inte på vilket kontrakt den beskriver.
//
// Följden var att en sammanslagen läsning returnerade samma fysiska bar två
// gånger — en gång ur rotfilen (kalenderpartitionerad, ingen contractKey) och en
// gång ur kontraktskatalogen (handelsdagspartitionerad, med nyckel). Mätt
// 2026-08-20 för MNQ 2026-08-17: 2 760 rader där lagret innehåller 1 380 barer,
// varav 120 tidsstämplar förekom dubbelt i två olika fältformer med identiska
// priser.
//
// Identiteten är kontraktet plus tidsstämpeln. conId finns i BÅDA formerna —
// som tal i rotfilen, som sträng i kontraktsfilen — och normaliseras därför till
// text. Saknas conId helt faller nyckeln tillbaka på contractKey och sist på
// tidsstämpeln ensam, vilket är det gamla beteendet för rader som inte bär
// någon kontraktsidentitet alls.
function contractIdentityOf(row = {}) {
  const conId = row.conId ?? row.contract?.conId ?? null;
  const text = conId == null ? '' : String(conId).trim();
  if (text) return `conid:${text}`;
  if (row.contractKey) return `contract:${row.contractKey}`;
  return 'legacy';
}

// Vid krock vinner raden med exakt härkomst. Kontraktsraden bär contractKey,
// tradingDay, session och provenanceQuality; rotraden bär dem inte. Att låta
// inläsningsordningen avgöra hade gjort resultatet beroende av vilken katalog
// som råkade läsas sist.
function provenanceRank(row = {}) {
  return row.contractKey ? 1 : 0;
}

function dedupeByTimestamp(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const normalized = normalizeStoredCandle(row);
    if (!normalized) continue;
    const identity = `${contractIdentityOf(normalized)}|${normalized.ts}`;
    const existing = merged.get(identity);
    if (existing && provenanceRank(existing) >= provenanceRank(normalized)) continue;
    merged.set(identity, normalized);
  }
  return [...merged.values()].sort((a, b) => timestampMs(a) - timestampMs(b));
}

function writeSorted(fp, bars) {
  const sorted = dedupeByTimestamp(bars);

  try {
    const lines = sorted.map((b) => JSON.stringify(b)).join('\n') + '\n';
    fs.writeFileSync(fp, lines, 'utf8');
    return sorted.length;
  } catch (err) {
    console.warn(`[MarketDataStore] Write failed (${fp}):`, err.message);
    return 0;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save raw 1m bars for a symbol/date.
 * Merges with existing file to avoid duplicates.
 * @param {string} source - 'alpaca' | 'binance' (default 'alpaca')
 * Returns number of bars written, or -1 on error.
 */
function saveRawBars(symbol, date, bars, source = 'alpaca', options = {}) {
  try {
    const dir = rawDir(symbol, source);
    ensureDir(dir);
    const contractKey = options.contractKey || (source === 'ib' ? contractKeyFromRows(bars) : null);
    if (source === 'ib' && contractKey && bars.some((bar) => bar.contractKey && bar.contractKey !== contractKey)) return -1;
    const fp       = contractFilePath(dir, date, contractKey);
    ensureDir(path.dirname(fp));
    const existing = readJsonl(fp);
    return writeSorted(fp, [...existing, ...bars]);
  } catch (err) {
    console.warn(`[MarketDataStore] saveRawBars(${symbol}, ${date}):`, err.message);
    return -1;
  }
}

/**
 * Save 2m candles for a symbol/date to the shared candles-2m store.
 * Also mirrors to legacy alpaca/candles-2m path so existing code keeps working.
 * Returns number of candles written, or -1 on error.
 */
function saveCandles2m(symbol, date, bars, options = {}) {
  try {
    const dir = candles2mDir(symbol);
    ensureDir(dir);
    const contractKey = options.contractKey || contractKeyFromRows(bars);
    if (contractKey && bars.some((bar) => bar.contractKey && bar.contractKey !== contractKey)) return -1;
    const fp       = contractFilePath(dir, date, contractKey);
    ensureDir(path.dirname(fp));
    const existing = readJsonl(fp);
    return writeSorted(fp, [...existing, ...bars]);
  } catch (err) {
    console.warn(`[MarketDataStore] saveCandles2m(${symbol}, ${date}):`, err.message);
    return -1;
  }
}

/**
 * Load candles for a symbol across a date range.
 * For '2m' timeframe: checks new shared path first, falls back to legacy alpaca/candles-2m/.
 *
 * @param {string} symbol
 * @param {string} start     - "YYYY-MM-DD"
 * @param {string} end       - "YYYY-MM-DD"
 * @param {string} timeframe - "raw" | "2m"  (default "2m")
 * @returns {Array} sorted bars
 */
function loadCandles(symbol, start, end, timeframe = '2m') {
  const dates = getDatesInRange(start, end);
  const all   = [];

  for (const date of dates) {
    let bars = [];
    if (timeframe === '2m') {
      const newPath    = filePath(candles2mDir(symbol), date);
      const legacyPath = filePath(legacyCandles2mDir(symbol), date);
      if (fs.existsSync(newPath)) {
        bars = readJsonl(newPath);
      } else if (fs.existsSync(legacyPath)) {
        bars = readJsonl(legacyPath);
      }
    } else {
      bars = readJsonl(filePath(dirForTimeframe(symbol, timeframe), date));
    }
    all.push(...bars);
  }

  return dedupeByTimestamp(all);
}

/**
 * Check whether any data exists for a symbol/date/timeframe.
 */
// Read-only availability probe over a date range. Used by replay to detect
// symbols that have NO candles (e.g. MNQ/MES before a futures provider is wired)
// so it can surface a clear "needs data" state instead of a silent empty run.
function hasCandlesInRange(symbol, start, end, timeframe = '2m') {
  const dates = getDatesInRange(start, end);
  let candleCount = 0;
  let firstDate = null;
  let lastDate = null;
  for (const date of dates) {
    const n = countCandles(symbol, date, timeframe);
    if (n > 0) {
      candleCount += n;
      if (!firstDate) firstDate = date;
      lastDate = date;
    }
  }
  return { available: candleCount > 0, candleCount, firstDate, lastDate };
}

function hasData(symbol, date, timeframe = '2m') {
  if (timeframe === '2m') {
    const newPath    = filePath(candles2mDir(symbol), date);
    const legacyPath = filePath(legacyCandles2mDir(symbol), date);
    if (fs.existsSync(newPath)    && readJsonl(newPath).length    > 0) return true;
    if (fs.existsSync(legacyPath) && readJsonl(legacyPath).length > 0) return true;
    return false;
  }
  const fp = filePath(dirForTimeframe(symbol, timeframe), date);
  return fs.existsSync(fp) && readJsonl(fp).length > 0;
}

function readdirDates(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace('.jsonl', ''))
      .sort();
  } catch { return []; }
}

function readdirContractDates(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(path.join(dir, 'contracts'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readdirDates(path.join(dir, 'contracts', entry.name)));
  } catch { return []; }
}

/**
 * List all dates that have data for a symbol.
 * 2m: merges shared + legacy paths (deduped, sorted).
 * raw: merges alpaca, binance, and IB raw paths.
 * @returns {{ raw: string[], '2m': string[] }}
 */
function listAvailableDates(symbol) {
  const raw2m   = readdirDates(candles2mDir(symbol));
  const legacy2m = readdirDates(legacyCandles2mDir(symbol));
  const merged2m = [...new Set([...raw2m, ...legacy2m])].sort();

  const rawAlpaca  = readdirDates(rawDir(symbol, 'alpaca'));
  const rawBinance = readdirDates(rawDir(symbol, 'binance'));
  const rawIb      = [...new Set([
    ...readdirDates(rawDir(symbol, 'ib')),
    ...readdirContractDates(rawDir(symbol, 'ib')),
  ])];
  const mergedRaw  = [...new Set([...rawAlpaca, ...rawBinance, ...rawIb])].sort();

  return { raw: mergedRaw, '2m': merged2m };
}

function listAvailableContractDates(symbol, source = 'ib') {
  const dir = rawDir(symbol, source);
  const base = path.join(dir, 'contracts');
  const result = {};
  if (!fs.existsSync(base)) return result;
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const key = decodeURIComponent(entry.name);
      result[key] = readdirDates(path.join(base, entry.name));
    }
  } catch { /* best effort read-only index */ }
  return result;
}

/**
 * List all symbols that have any market data stored.
 * Checks: shared 2m, legacy alpaca 2m, alpaca raw, binance raw.
 */
function listSymbols() {
  const symbols = new Set();
  const dirs = [
    CANDLES_2M_ROOT,
    path.join(ALPACA_ROOT,  'candles-2m'),
    path.join(ALPACA_ROOT,  'raw'),
    path.join(BINANCE_ROOT, 'raw'),
    path.join(IB_ROOT,      'raw'),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      try { fs.readdirSync(dir).forEach((s) => symbols.add(s)); } catch { /* ignore */ }
    }
  }
  return [...symbols].sort();
}

/**
 * Count candles for a symbol/date/timeframe.
 * For 2m: checks shared path first, then legacy.
 */
function countCandles(symbol, date, timeframe = '2m') {
  if (timeframe === '2m') {
    const newPath    = filePath(candles2mDir(symbol), date);
    const legacyPath = filePath(legacyCandles2mDir(symbol), date);
    if (fs.existsSync(newPath))    return readJsonl(newPath).length;
    if (fs.existsSync(legacyPath)) return readJsonl(legacyPath).length;
    return 0;
  }
  const fp = filePath(dirForTimeframe(symbol, timeframe), date);
  return readJsonl(fp).length;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getDatesInRange(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end   + 'T00:00:00Z');
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

// IB import-manifest per symbol: kontrakt, expiry, datum och importtid så att
// candles från olika kontrakt aldrig blandas utan metadata.
function ibManifestPath(symbol) {
  return path.join(IB_ROOT, 'manifest', `${symbol}.json`);
}

function saveIbImportManifest(symbol, manifest = {}) {
  try {
    const fp = ibManifestPath(symbol);
    ensureDir(path.dirname(fp));
    const existing = loadIbImportManifest(symbol) || {};
    const mergedDates = [...new Set([...(existing.dates || []), ...(manifest.dates || [])])].sort();
    const next = { ...existing, ...manifest, dates: mergedDates };
    fs.writeFileSync(fp, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn(`[MarketDataStore] saveIbImportManifest(${symbol}):`, err.message);
    return false;
  }
}

function loadIbImportManifest(symbol) {
  try {
    const fp = ibManifestPath(symbol);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Läs RÅ barer för en källa över ett datumintervall.
 *
 * loadCandles kan bara nå alpaca-raw eftersom dirForTimeframe har 'alpaca' som
 * default. Den historiska feeden behöver IB:s 1-minutersbarer — samma barer som
 * live-feeden håller i minnet — och de ligger under ib/raw. Additiv funktion:
 * inga befintliga anropare berörs.
 */
function loadRawBars(symbol, start, end, source = 'ib', options = {}) {
  const dates = getDatesInRange(start, end);
  const all = [];
  const rootDir = rawDir(symbol, source);
  const exactContractKey = options.contractKey || options.contract?.contractKey || null;
  const contractDirs = exactContractKey
    ? [contractDir(rootDir, exactContractKey)]
    : (source === 'ib' ? (() => {
      try {
        const base = path.join(rootDir, 'contracts');
        return fs.existsSync(base)
          ? fs.readdirSync(base, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(base, entry.name))
          : [];
      } catch { return []; }
    })() : []);
  for (const date of dates) {
    if (!exactContractKey) all.push(...readJsonl(filePath(rootDir, date)));
    for (const dir of contractDirs) all.push(...readJsonl(filePath(dir, date)));
  }
  return dedupeByTimestamp(all);
}

/**
 * När lagret senast SKREV till ett dygn, i millisekunder. Null om inget finns.
 *
 * Behövs för att kunna avgöra om ett dygn fortfarande tas emot. Den löpande
 * IB-infångningen underhåller ett rullande fönster av de senaste dygnen och
 * skriver om deras filer långt efter att sessionen stängt — mätt 2026-08-20
 * skrevs fyra dygn (17, 18, 19, 20) inom samma sekund. Ett dygn som "finns" är
 * alltså inte nödvändigtvis ett dygn som ligger stilla.
 *
 * Läser både rotfilen och kontraktskatalogerna och tar den senaste av dem: det
 * är först när INGEN av dem rörs som dygnet faktiskt ligger stilla.
 */
function lastModifiedMs(symbol, date, source = 'ib') {
  const dir = rawDir(symbol, source);
  const candidates = [filePath(dir, date)];
  const contractsBase = path.join(dir, 'contracts');
  try {
    if (fs.existsSync(contractsBase)) {
      for (const entry of fs.readdirSync(contractsBase, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(filePath(path.join(contractsBase, entry.name), date));
      }
    }
  } catch { /* best effort read-only */ }

  let newest = null;
  for (const fp of candidates) {
    try {
      const stat = fs.statSync(fp);
      if (newest == null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch { /* filen finns inte för det här dygnet */ }
  }
  return newest;
}

/**
 * Ett avtryck av allt lagret har för en symbol.
 *
 * Barfilerna skrivs bara till — en dag läggs till, eller dagens pågående fil
 * växer. Två avtryck som är lika kan därför inte dölja olika innehåll, och det
 * gör avtrycket till en korrekt cachenyckel för allt som HÄRLEDS ur lagret
 * (Market DNA-katalogen, Market Intelligence). Skillnaden mot en TTL är att
 * det här aldrig kan servera ett gammalt svar för nya barer.
 *
 * Kostar en readdir per katalog och en stat per fil — mätt några millisekunder
 * mot de 12,7 sekunder katalogbygget tar.
 */
function fingerprintSymbol(symbol, source = 'ib') {
  const dirs = [rawDir(symbol, source)];
  const contractsBase = path.join(rawDir(symbol, source), 'contracts');
  try {
    if (fs.existsSync(contractsBase)) {
      for (const entry of fs.readdirSync(contractsBase, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(contractsBase, entry.name));
      }
    }
  } catch { /* best effort read-only */ }

  const parts = [];
  for (const dir of dirs.sort()) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch { continue; }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        parts.push(`${dir}/${name}:${stat.size}:${stat.mtimeMs}`);
      } catch { /* försvann mellan readdir och stat */ }
    }
  }
  return parts.join('|');
}

/**
 * Avtryck PER DYGN för en symbol: { '2026-08-19': 'storlek:mtime|...' }.
 *
 * Ett avtryck över hela lagret duger som cachenyckel bara så länge lagret står
 * still. Under handelsdagen växer dagens fil varannan minut, och ett samlat
 * avtryck gör då varje härlett svar kallt hela dagen. Per dygn ändras bara den
 * dag som faktiskt fick nya barer, och allt som räknats för de stängda dygnen
 * står kvar.
 */
function fingerprintByDate(symbol, source = 'ib') {
  const dirs = [rawDir(symbol, source)];
  const contractsBase = path.join(rawDir(symbol, source), 'contracts');
  try {
    if (fs.existsSync(contractsBase)) {
      for (const entry of fs.readdirSync(contractsBase, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(contractsBase, entry.name));
      }
    }
  } catch { /* best effort read-only */ }

  const byDate = new Map();
  for (const dir of dirs.sort()) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch { continue; }
    for (const name of names) {
      const date = name.slice(0, -6);
      try {
        const stat = fs.statSync(path.join(dir, name));
        byDate.set(date, `${byDate.get(date) || ''}|${stat.size}:${stat.mtimeMs}`);
      } catch { /* försvann mellan readdir och stat */ }
    }
  }
  return byDate;
}

/** Avtryck för flera symboler. Se fingerprintSymbol. */
function fingerprint(symbols = [], source = 'ib') {
  return symbols.map((symbol) => `${symbol}=${fingerprintSymbol(symbol, source)}`).join('||');
}

module.exports = {
  fingerprint,
  fingerprintByDate,
  fingerprintSymbol,
  lastModifiedMs,
  saveRawBars,
  saveCandles2m,
  loadCandles,
  loadRawBars,
  hasData,
  hasCandlesInRange,
  listAvailableDates,
  listAvailableContractDates,
  listSymbols,
  countCandles,
  getDatesInRange,
  saveIbImportManifest,
  loadIbImportManifest,
  _internal: {
    normalizeTimestamp,
    dedupeByTimestamp,
    contractKeyFromRows,
    contractIdentityOf,
    provenanceRank,
    contractFilePath,
    readdirContractDates,
    listAvailableContractDates,
  },
};
