'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'FuturesPaperDeskPage.jsx'), 'utf8');
const terminology = fs.readFileSync(path.join(__dirname, '../services/uiTerminologyService.js'), 'utf8');
const tradeJournal = fs.readFileSync(path.join(__dirname, '../components/trading/TradeJournal.jsx'), 'utf8');
const positionDesk = fs.readFileSync(path.join(__dirname, '../components/trading/PositionDeskPanel.jsx'), 'utf8');
const formatters = fs.readFileSync(path.join(__dirname, '../utils/tradingFormatters.js'), 'utf8');
const visibleStringSource = [...source.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)]
  .map((match) => match[2])
  .join('\n');

assert.match(terminology, /Handelstest använder IBKR Paper Trading/);
assert.match(terminology, /Inga riktiga pengar används/);
assert.match(terminology, /riktiga konton är blockerade/);
assert.match(source, /const PRODUCT_TABS = \[/);
assert.match(source, /const LEGACY_TABS = \[/);
assert.match(source, /const DEFAULT_TAB = 'oversikt'/);

for (const label of [
  'PAPER_DESK_COPY.tabs.today',
  'PAPER_DESK_COPY.tabs.positions',
  'PAPER_DESK_COPY.tabs.recentTrades',
  'PAPER_DESK_COPY.tabs.approval',
  'Visa teknisk information',
  'IBKR Paper-konto',
  // Positioner är en trading desk; brokeravstämningen ligger under teknisk drift.
  'Brokerpositioner',
  // En sida, ett ansvar — flikarna heter efter vad de faktiskt visar.
  'Brokerordrar',
  'Brokeravslut',
  'Teknisk drift',
  'IBKR orderstatus',
  'Historiskt sim-arkiv',
]) {
  assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const productTabBlock = source.slice(
  source.indexOf('const PRODUCT_TABS = ['),
  source.indexOf('];', source.indexOf('const PRODUCT_TABS = [')),
);
for (const forbiddenProductTerm of ['Replay', 'Runtime', 'Execution', 'Batch', 'CandidateDNA', 'libraryRunId', 'ReplaySession']) {
  assert.doesNotMatch(productTabBlock, new RegExp(forbiddenProductTerm, 'i'));
}

for (const marker of [
  'data-paper-performance-kpis',
  'data-paper-daily-state',
  'data-paper-strategy-spotlight',
  'data-paper-leaderboard',
  'data-paper-open-positions',
  'data-paper-recent-trades',
  'data-paper-needs-you',
  'data-paper-broker-status',
]) {
  assert.match(source, new RegExp(marker), `${marker} saknas`);
}

const overviewOrder = [
  '<PaperPerformanceKpis',
  '<PaperDeskDailyState',
  '<PaperNeedsYou',
  '<PaperStrategyGroupPanel',
  '<PaperLeaderboardPanel',
  '<PaperOpenPositionsPreview',
  '<PaperRecentTradesPreview',
  '<PaperBrokerStatus',
  '<details',
].map((needle) => source.indexOf(needle));
assert.equal(overviewOrder.every((index) => index >= 0), true, 'översiktens huvudytor saknas');
assert.deepEqual([...overviewOrder].sort((a, b) => a - b), overviewOrder, 'översikten följer inte handelsbordets läsordning');
assert.match(source, /kpis=\{kpis\}/, 'KPI-raden ska vara synlig även i standardvyn');
assert.doesNotMatch(source, /ContextNavigation compact actions=\{paperContextActions\}/, 'den gamla fyrknappstoppen får inte finnas kvar');

for (const productText of [
  'Paper Trading aktivt',
  'AI handlar',
  'AI väntar',
  'Väntar på godkännande',
  'Inga positioner',
  'Det som är ute i marknaden',
  'Senaste affärerna',
  'En sak att ta ställning till',
  'Kopplingen till paperkontot',
  'Kontrollera brokerstatus',
  'Dagens strategier',
  '🏆 Bäst idag',
  '🔥 AI testar nu',
  '⭐ Redo för Paper',
  '⚠ Behöver uppmärksamhet',
  'Topplistor',
  'Mest lovande strategier',
  'Bäst resultat',
  'Högst vinstprocent',
  'Störst förbättring',
  'Mest lovande strategi',
  'Öppna strategi',
]) {
  assert.match(terminology, new RegExp(productText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const required of [
  'PAPER_DESK_COPY',
  'uiCopy',
  'summarizeTrades',
  'summarizePaperKpis',
  'latestClosedTrades',
  'buildDeskStatus',
  'buildDeskAction',
  'brokerStateLabel',
  'brokerStatusItems',
  'dailyDeskResult',
  'tradeSummary',
  'paperPerformance',
  'performanceReferenceMs',
  "const currency = account.currency || executionData.account?.currency || 'USD';",
  'Resultatöversikt',
  'FuturesPaperStrategyApprovalPanel currency={currency}',
  'Kontovärde',
  'Tillgängligt',
  'Köpkraft',
  'Orealiserat resultat',
  'Realiserat resultat',
  'Dagens brokerresultat',
  'Totalt resultat sedan första paper-traden',
  'Totala vinster',
  'Totala förluster',
  'Win rate',
  'Antal avslutade trades',
  'Dagens resultat',
  'Veckans resultat',
  'Månadens resultat',
  'Totalt sedan start',
  'Öppna brokerpositioner',
  'Öppna brokerordrar',
  'brokerOrderIntents',
  'orderLifecycleRows',
  'mergeOrderLifecycleRows',
  'Avstämning',
  'brokerMirrorSourceText',
  'Arkiverad simulering',
  'Äldre interna simuleringar',
  'fmtMoney(row.realizedPnlSek, currency)',
  'paperStrategySections',
  'buildPaperStrategySections',
  'primaryStrategyId',
  // Steg 3: Positioner är en live trading desk byggd på befintlig snapshot.
  'PositionDeskPanel',
  'buildPositionDeskRows',
  'summarizePositionDesk',
  'positionDeskRows',
  'positionDeskSummary',
  'Brokerkälla ·',
  'Orderkoppling',
  'Skuggläge',
  'Orderskick',
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const removedVisibleTerm of [
  'Broker Orders',
  'Executions',
  'IBKR Paper Execution',
  'source=internal_legacy_simulation',
  'Broker mirror · source=',
  'Strategy Dashboard',
  'Central operating console',
  'Scannerläge',
  'simulated_fallback',
  'paper-only prisfeed',
]) {
  assert.doesNotMatch(
    visibleStringSource,
    new RegExp(removedVisibleTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
}

for (const visibleComponentText of [
  'Affärsjournal',
  'En rad = en affär',
  'Öppna affärer',
  'Vinstgrad',
  'Orealiserat resultat',
  'Positioner i vinst',
  'Positioner i förlust',
  'Hämtar brokerdata',
]) {
  assert.match(`${tradeJournal}\n${positionDesk}\n${formatters}`, new RegExp(visibleComponentText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

// Positioner får inte återfå brokerdiagnostiken: positionskorten, den råa
// avstämningen och kontopanelerna ligger på teknisk drift respektive IBKR Paper-konto.
for (const movedOffPositions of [
  'Live Position System',
  'PositionCard',
  'stablePositionKey',
]) {
  assert.doesNotMatch(source, new RegExp(movedOffPositions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

// Ingen ny datakälla: sidan hämtar fortfarande bara runtime och execution status.
const fetchedUrls = [...source.matchAll(/useJson\('([^']+)'/g)].map((match) => match[1]);
assert.deepEqual(fetchedUrls, [
  '/api/futures-paper/runtime',
  '/api/futures-paper/ibkr-paper-execution/status?connect=false',
]);

for (const mutatingMethod of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.doesNotMatch(source, new RegExp(`method:\\s*['"\`]${mutatingMethod}['"\`]`));
}

for (const retiredActiveSurface of [
  '/api/futures-paper/account/reset',
  '/api/futures-paper/account/set-balance',
  '/api/futures-paper/manual/open',
  '/api/futures-paper/manual/close',
  '/api/futures-paper/candidates/simulate',
  '/api/futures-paper/simulation/tick',
  '/api/futures-paper/auto-simulation',
  'Sim-equity',
  'Sim-PnL',
  'falskt kapital',
  'återställ simulerat konto',
]) {
  assert.doesNotMatch(source, new RegExp(retiredActiveSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

console.log('FuturesPaperDeskPage.source.test.js passed');
