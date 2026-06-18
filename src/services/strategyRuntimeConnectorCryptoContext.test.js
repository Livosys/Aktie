'use strict';

const assert = require('assert/strict');
const svc = require('./strategyRuntimeConnectorService');

assert.equal(
  svc._internal.cryptoSignalContextPresentForStrategy('crypto_momentum_scalper', [
    { strategy_id: 'crypto_momentum_scalper', crypto_signal_context: { market: 'crypto' } },
  ]),
  true,
  'crypto context should be detected for crypto_momentum_scalper',
);

assert.equal(
  svc._internal.cryptoSignalContextPresentForStrategy('crypto_momentum_scalper', [
    { strategy_id: 'crypto_momentum_scalper', crypto_context: { market: 'crypto' } },
  ]),
  true,
  'legacy crypto_context should also count as presence',
);

assert.equal(
  svc._internal.cryptoSignalContextPresentForStrategy('crypto_momentum_scalper', [
    { strategy_id: 'crypto_momentum_scalper' },
  ]),
  false,
  'missing crypto context should stay blocked',
);

assert.equal(
  svc._internal.cryptoSignalContextPresentForStrategy('narrow_breakout', [
    { strategy_id: 'narrow_breakout', crypto_signal_context: { market: 'crypto' } },
  ]),
  false,
  'non-crypto strategies should not be treated as crypto',
);

console.log('# strategyRuntimeConnectorCryptoContext.test.js passed.');
