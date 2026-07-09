'use strict';

const assert = require('assert');
const scope = require('./researchMarketScope');

// --- allowed index ETFs ---
assert.equal(scope.isResearchAllowedSymbol('SPY'), true, 'SPY should be allowed');
assert.equal(scope.isResearchAllowedSymbol('QQQ'), true, 'QQQ should be allowed');

// --- allowed mega-cap stocks ---
for (const sym of ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'TSLA']) {
  assert.equal(scope.isResearchAllowedSymbol(sym), true, `${sym} should be allowed`);
}

// --- allowed crypto majors ---
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  assert.equal(scope.isResearchAllowedSymbol(sym), true, `${sym} should be allowed`);
}

// --- blocked index ETFs ---
assert.equal(scope.isResearchAllowedSymbol('IWM'), false, 'IWM should be blocked');
assert.equal(scope.isResearchAllowedSymbol('DIA'), false, 'DIA should be blocked');

// --- blocked leveraged ETFs ---
for (const sym of ['TQQQ', 'SQQQ', 'SOXL', 'SOXS']) {
  assert.equal(scope.isResearchAllowedSymbol(sym), false, `${sym} should be blocked`);
}

// --- blocked misspelled group-like token ---
assert.equal(scope.isResearchAllowedSymbol('NADAQ100'), false, 'NADAQ100 (misspelled) should be blocked');

// --- blocked unknown symbol ---
assert.equal(scope.isResearchAllowedSymbol('FOOBAR'), false, 'unknown symbol should be blocked');

// --- blocked crypto outside the 3 majors ---
for (const sym of ['XRPUSDT', 'DOGEUSDT', 'ADAUSDT']) {
  assert.equal(scope.isResearchAllowedSymbol(sym), false, `${sym} should be blocked (crypto outside majors)`);
}

// --- lowercase / whitespace normalization ---
assert.equal(scope.isResearchAllowedSymbol('aapl'), true, 'lowercase aapl should normalize + be allowed');
assert.equal(scope.isResearchAllowedSymbol('  spy  '), true, 'padded spy should normalize + be allowed');
assert.equal(scope.isResearchAllowedSymbol('btcusdt'), true, 'lowercase btcusdt should normalize + be allowed');
assert.equal(scope.normalizeResearchSymbol('  aapl '), 'AAPL', 'normalize should trim + uppercase');
assert.equal(scope.normalizeResearchSymbol(null), '', 'normalize null -> empty string');
assert.equal(scope.normalizeResearchSymbol(undefined), '', 'normalize undefined -> empty string');

// --- group resolution ---
assert.equal(scope.getResearchSymbolGroup('SPY'), 'sp500', 'SPY -> sp500');
assert.equal(scope.getResearchSymbolGroup('QQQ'), 'nasdaq100', 'QQQ -> nasdaq100');
assert.equal(scope.getResearchSymbolGroup('aapl'), 'nasdaq100', 'aapl -> nasdaq100');
assert.equal(scope.getResearchSymbolGroup('BTCUSDT'), 'crypto', 'BTCUSDT -> crypto');
assert.equal(scope.getResearchSymbolGroup('IWM'), null, 'IWM -> null (outside scope)');

// --- group allow-list ---
assert.equal(scope.isResearchAllowedGroup('sp500'), true);
assert.equal(scope.isResearchAllowedGroup('nasdaq100'), true);
assert.equal(scope.isResearchAllowedGroup('crypto'), true);
assert.equal(scope.isResearchAllowedGroup('stocks'), false);
assert.equal(scope.isResearchAllowedGroup('leveraged_etf'), false);
assert.equal(scope.isResearchAllowedGroup('CRYPTO'), true, 'group check is case-insensitive');

// --- filterResearchSymbols preserves order + removes blocked ---
const filtered = scope.filterResearchSymbols(['SPY', 'IWM', 'AAPL', 'TQQQ', 'BTCUSDT', 'FOOBAR', 'QQQ']);
assert.deepEqual(filtered, ['SPY', 'AAPL', 'BTCUSDT', 'QQQ'], 'filter keeps order, drops blocked');

// filter normalizes + de-dupes while preserving first-seen order
const filtered2 = scope.filterResearchSymbols(['aapl', 'AAPL', ' spy ', 'nvda']);
assert.deepEqual(filtered2, ['AAPL', 'SPY', 'NVDA'], 'filter normalizes + de-dupes');

// filter on empty / nullish input
assert.deepEqual(scope.filterResearchSymbols([]), [], 'empty input -> empty');
assert.deepEqual(scope.filterResearchSymbols(null), [], 'null input -> empty');

// --- partitionResearchSymbols surfaces blocked reasons ---
const part = scope.partitionResearchSymbols(['SPY', 'IWM', 'BTCUSDT', 'DOGEUSDT']);
assert.deepEqual(part.allowed, ['SPY', 'BTCUSDT'], 'partition allowed set');
assert.equal(part.blocked.length, 2, 'partition blocked count');
assert.equal(part.blocked[0].normalized, 'IWM');
assert.equal(part.blocked[0].reason, 'outside_research_scope');

// --- getResearchMarketGroups ---
const groups = scope.getResearchMarketGroups();
assert.deepEqual(groups.map((g) => g.id), ['sp500', 'nasdaq100', 'crypto'], 'research market groups');
assert.equal(groups.every((g) => typeof g.label === 'string' && g.label.length > 0), true, 'groups have labels');

// --- exported constants ---
assert.equal(scope.RESEARCH_ALLOWED_SYMBOLS.length, 13, 'exactly 13 allowed symbols');
assert.deepEqual(scope.RESEARCH_ALLOWED_GROUPS, ['sp500', 'nasdaq100', 'crypto']);

console.log('# researchMarketScope tests passed.');
