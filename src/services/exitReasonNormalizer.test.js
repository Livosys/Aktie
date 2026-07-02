'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeExitReasonFields } = require('./exitReasonNormalizer');

test('legacy STOP_HIT maps to stop_hit + legacy_static_exit', () => {
  const out = normalizeExitReasonFields({ exitReason: 'STOP_HIT', exitReasonCode: null });
  assert.strictEqual(out.normalizedExitReasonCode, 'stop_hit');
  assert.strictEqual(out.normalizedExitSource, 'legacy_static_exit');
  assert.strictEqual(out.normalizedExitReasonLabel, 'Stop loss');
});

test('legacy TARGET_HIT maps to target_hit', () => {
  const out = normalizeExitReasonFields({ exitReason: 'TARGET_HIT' });
  assert.strictEqual(out.normalizedExitReasonCode, 'target_hit');
  assert.strictEqual(out.normalizedExitSource, 'legacy_static_exit');
});

test('legacy TIMEOUT maps to timeout', () => {
  const out = normalizeExitReasonFields({ exitReason: 'TIMEOUT', result: 'TIMEOUT' });
  assert.strictEqual(out.normalizedExitReasonCode, 'timeout');
  assert.strictEqual(out.normalizedExitSource, 'legacy_static_exit');
});

test('existing exitReasonCode is preserved (not overridden)', () => {
  const out = normalizeExitReasonFields({
    exitReason: 'EXIT_ENGINE_TIGHTENED_STOP',
    exitReasonCode: 'tightened_stop',
    exitSource: 'exit_engine_v1',
  });
  assert.strictEqual(out.normalizedExitReasonCode, 'tightened_stop');
  assert.strictEqual(out.normalizedExitSource, 'exit_engine_v1');
});

test('missing exit fields -> unknown', () => {
  const out = normalizeExitReasonFields({});
  assert.strictEqual(out.normalizedExitReasonCode, 'unknown');
  assert.strictEqual(out.normalizedExitSource, 'unknown');
  assert.strictEqual(out.normalizedExitReasonLabel, 'Okänd');
});

test('null/"none" exitReasonCode falls through to legacy exitReason', () => {
  const out = normalizeExitReasonFields({ exitReason: 'STOP_HIT', exitReasonCode: 'none' });
  assert.strictEqual(out.normalizedExitReasonCode, 'stop_hit');
});

test('original fields are preserved and input is not mutated', () => {
  const input = { exitReason: 'STOP_HIT', exitReasonCode: null, pnlPct: -0.2, symbol: 'TSLA' };
  const out = normalizeExitReasonFields(input);
  // originals preserved on the copy
  assert.strictEqual(out.exitReason, 'STOP_HIT');
  assert.strictEqual(out.exitReasonCode, null);
  assert.strictEqual(out.exitReasonSv, null);
  assert.strictEqual(out.exitSource, null);
  assert.strictEqual(out.pnlPct, -0.2);
  assert.strictEqual(out.symbol, 'TSLA');
  // input untouched (no normalized* leaked onto original)
  assert.strictEqual('normalizedExitReasonCode' in input, false);
  assert.notStrictEqual(out, input);
});

test('defensive: engine reason without code is derived from EXIT_ENGINE_ prefix', () => {
  const out = normalizeExitReasonFields({ exitReason: 'EXIT_ENGINE_MOMENTUM_FADE' });
  assert.strictEqual(out.normalizedExitReasonCode, 'momentum_fade');
  assert.strictEqual(out.normalizedExitSource, 'exit_engine_v1');
});
