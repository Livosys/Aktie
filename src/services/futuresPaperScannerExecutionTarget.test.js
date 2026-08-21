'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scannerModule = require('./futuresPaperScannerService');
const storageModule = require('./futuresPaperStorageService');
const reservationModule = require('./futuresPaperExecutionTargetReservationService');

function createLiveScanner(rootDir, candidates) {
  const storage = storageModule.createFuturesPaperStorageService({ rootDir });
  return scannerModule.createFuturesPaperScannerService({
    strategyPolicyService: { evaluateStrategy: (strategyId) => ({ allowed: true, identity: { canonicalStrategyId: strategyId, nativeStrategyId: strategyId, originStrategyId: strategyId }, approval: { source: 'test', entryContractReady: true } }) },
    executionTarget: 'ibkr_live',
    storageService: storage,
    executionTargetReservationService: reservationModule.createFuturesPaperExecutionTargetReservationService({
      dir: path.join(rootDir, 'execution-target-reservations'),
    }),
    priceFeedService: {
      tickQuotes: () => ({
        feed: { source: 'ibkr_realtime', simulated: false },
        quotes: [{ root: 'MNQ', source: 'ibkr_realtime', updatedAt: '2026-07-15T22:29:55.000Z' }],
      }),
      getQuotes: () => ({
        feed: { source: 'ibkr_realtime', simulated: false },
        quotes: [{ root: 'MNQ', source: 'ibkr_realtime', updatedAt: '2026-07-15T22:29:55.000Z' }],
      }),
    },
    signalProviderService: {
      getCanonicalSignals: () => ({
        signalInputs: [{ signalId: 'sig-live-1' }],
        stats: { readerSignalsRead: 0, providerSignalsRead: candidates.length, providersEvaluated: 1 },
        providerResults: { native_futures_signal_provider: { signals: candidates.length } },
      }),
    },
    signalAdapterService: {
      getFuturesCandidates: () => ({
        candidates,
        skipped: [],
        stats: { signalInputsRead: candidates.length, signalsMappedToFutures: candidates.length },
      }),
    },
  });
}

(function run() {
  const now = new Date('2026-07-15T22:30:00.000Z');
  const candidate = {
    lifecycleId: 'life-live-scan-1',
    candidateId: 'cand-live-scan-1',
    signalId: 'sig-live-scan-1',
    strategyId: 'native_futures_momentum_v1',
    symbol: 'MNQ',
    futuresSymbol: 'MNQ',
    direction: 'long',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    takeProfitPrice: 23040,
  };
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-live-scanner-target-'));
  const liveScanner = createLiveScanner(liveDir, [candidate]);

  const scan = liveScanner.runScannerOnce({ now });
  assert.equal(scan.scan.executionTarget, 'ibkr_live');
  assert.equal(scan.executionTarget, 'ibkr_live');
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].executionTarget, 'ibkr_live');
  assert.equal(scan.candidates[0].executionSource, 'ibkr_live');
  assert.equal(scan.candidates[0].paperOnly, false);
  assert.equal(scan.candidates[0].executionTargetReservation.status, 'ibkr_live_reserved_for_shadow');
  assert.equal(scan.scan.readerSignalsRead, 0);
  assert.equal(scan.scan.providerSignalsRead, 1);

  const claim = liveScanner.claimCandidateForIbkrPaper({ now, claimedBy: 'target-test' });
  assert.equal(claim.claimed, true);
  assert.equal(claim.candidate.executionTarget, 'ibkr_live');

  const oldPaperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-live-scanner-paper-queue-'));
  storageModule.writeJson(path.join(oldPaperDir, 'candidates.json'), {
    candidates: [{
      candidateId: 'old-paper-candidate',
      signalId: 'old-paper-signal',
      strategyId: 'native_futures_momentum_v1',
      symbol: 'MNQ',
      direction: 'long',
      signalTimestamp: '2026-07-15T22:29:30.000Z',
      executionTarget: 'ibkr_paper',
      status: 'READY_WAITING_FOR_SIGNAL',
    }],
  });
  const liveScannerWithPaperQueue = createLiveScanner(oldPaperDir, []);
  const noClaim = liveScannerWithPaperQueue.claimCandidateForIbkrPaper({ now, claimedBy: 'target-test' });
  assert.equal(noClaim.claimed, false);
  assert.equal(noClaim.activeQueue.length, 0);

  console.log('futuresPaperScannerExecutionTarget.test.js passed');
})();
