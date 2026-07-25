'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const model = fs.readFileSync(path.join(root, 'models', 'tradingEventModel.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'stores', 'tradingEventStore.js'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'domain', 'EventDomain.js'), 'utf8');

for (const field of [
  'eventId',
  'eventType',
  'strategyId',
  'candidateId',
  'orderId',
  'executionId',
  'positionId',
  'tradeId',
  'timestamp',
  'source',
  'payload',
  'status',
  'metadata',
]) {
  assert.match(model, new RegExp(field), `TradingEventModel exposes ${field}`);
}

for (const eventType of [
  'scanner_started',
  'scanner_completed',
  'candidate_created',
  'order_pending',
  'order_submitted',
  'order_accepted',
  'order_working',
  'order_partially_filled',
  'order_filled',
  'order_cancelled',
  'order_rejected',
  'execution',
  'fill',
  'position',
  'trade',
  'learning',
  'analytics',
  'replay',
  'ai',
  'history',
  'audit',
]) {
  assert.match(model, new RegExp(eventType), `TradingEventModel supports ${eventType}`);
}

for (const source of [model, store, domain]) {
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'event architecture files do not fetch');
  assert.doesNotMatch(source, /\baxios\b/, 'event architecture files do not use axios');
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b/, 'event architecture files do not persist browser state');
}

assert.match(store, /export function createTradingEventStore/, 'TradingEventStore factory is exported');
assert.match(store, /getEventsByStrategy/, 'TradingEventStore exposes strategy selector');
assert.match(store, /getEventsByOrder/, 'TradingEventStore exposes order selector');
assert.match(store, /getEventsByExecution/, 'TradingEventStore exposes execution selector');
assert.match(store, /getEventsByPosition/, 'TradingEventStore exposes position selector');
assert.match(store, /getEventsByTrade/, 'TradingEventStore exposes trade selector');

assert.match(domain, /export function getEventTimeline/, 'EventDomain exposes timeline selector');
assert.match(domain, /export function getEventSummary/, 'EventDomain exposes summary selector');
assert.doesNotMatch(domain, /\bReact\b/, 'EventDomain is React-free');

for (const page of [
  'FuturesPaperDeskPage.jsx',
  'PaperTradingPage.jsx',
  'InteractiveBrokersPage.jsx',
  'AiControlRoomPage.jsx',
  'SupervisorBrainPage.jsx',
  'SupervisorV2Page.jsx',
  'TradingLabPage.jsx',
  'ReplayPage.jsx',
]) {
  const source = fs.readFileSync(path.join(root, 'pages', page), 'utf8');
  assert.match(source, /createTradingEventStore/, `${page} consumes TradingEventStore`);
}
