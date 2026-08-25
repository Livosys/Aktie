'use strict';

/**
 * Futures Max Open Positions Reservation Service — ATOMIC max-10 enforcement
 *
 * Guarantees: logicalOpenTrades + reservedSlots <= 10 ATOMICALLY
 *
 * Model:
 * - getPositionCount(): current open contracts (from broker)
 * - pendingEntries(): already-submitted orders awaiting fills
 * - reservedSlots: pre-allocated slots for candidates being submitted
 * - Invariant: open + pending + reserved <= 10 (always true after check+reserve)
 *
 * CRITICAL: check+reserve is atomic (protected by process-local mutex).
 * No two candidates can both reserve slots simultaneously — only one can pass.
 *
 * Reservation lifecycle:
 * 1. candidate calls tryReserveSlot() → atomic check + reserve
 * 2. if reserved: candidate submits order
 * 3. on success: slot ownership transfers to pending order count
 * 4. on failure: slot is released immediately, available for next candidate
 */

// Process-local mutex: ensures only ONE tryReserveSlot at a time
let reservationLocked = false;
let lockWaiters = [];

async function acquireLock() {
  while (reservationLocked) {
    // Simple backoff: wait a tiny bit for lock to release
    await new Promise(resolve => {
      lockWaiters.push(resolve);
      setTimeout(() => {
        const idx = lockWaiters.indexOf(resolve);
        if (idx !== -1) lockWaiters.splice(idx, 1);
        resolve();
      }, 1);
    });
  }
  reservationLocked = true;
}

function releaseLock() {
  reservationLocked = false;
  const waiter = lockWaiters.shift();
  if (waiter) waiter();
}

// In-memory reservation tracking
const reservedSlots = new Map(); // candidateId → { candidateId, reservedAt, intentId }

/**
 * ATOMIC: check + reserve exactly 1 slot
 * Returns { reserved: true, slotId } OR { reserved: false, reason: "..." }
 */
async function tryReserveSlot({
  candidateId = null,
  intentId = null,
  getOpenCount = null,  // callable: () => number (from broker)
  getPendingCount = null, // callable: () => number (from reconciliation)
  maxSlots = 10,
  now = new Date(),
} = {}) {
  if (!candidateId || !getOpenCount || !getPendingCount) {
    return { reserved: false, reason: 'missing_required_parameters' };
  }

  // ATOMIC CRITICAL SECTION — only one candidate can enter
  await acquireLock();
  try {
    // Check current state
    const openCount = getOpenCount();
    const pendingCount = getPendingCount();
    const currentReserved = reservedSlots.size;
    const totalCommitted = openCount + pendingCount + currentReserved;

    // Verify invariant holds
    if (totalCommitted > maxSlots) {
      return {
        reserved: false,
        reason: 'max_open_positions_exceeded',
        state: { openCount, pendingCount, reservedCount: currentReserved, totalCommitted, maxSlots },
      };
    }

    // Check if we can reserve
    if (totalCommitted >= maxSlots) {
      return {
        reserved: false,
        reason: 'slot_limit_reached',
        state: { openCount, pendingCount, reservedCount: currentReserved, totalCommitted, maxSlots },
      };
    }

    // Reserve exactly 1 slot for this candidate
    const reservation = {
      candidateId,
      intentId,
      reservedAt: now.toISOString(),
      slotIndex: currentReserved, // 0-based position in queue
    };
    reservedSlots.set(candidateId, reservation);

    return {
      reserved: true,
      slotIndex: reservation.slotIndex,
      newTotal: totalCommitted + 1,
      state: { openCount, pendingCount, reservedCount: currentReserved + 1 },
    };
  } finally {
    releaseLock();
  }
}

/**
 * Release a reserved slot (called after failure/rejection/timeout)
 */
async function releaseReservation({ candidateId = null } = {}) {
  await acquireLock();
  try {
    if (reservedSlots.has(candidateId)) {
      reservedSlots.delete(candidateId);
      return { released: true };
    }
    return { released: false, reason: 'reservation_not_found' };
  } finally {
    releaseLock();
  }
}

/**
 * Transfer reservation to pending (called after successful submit)
 * Caller must track the pending count themselves via reconciliation
 */
async function transferToOwnership({ candidateId = null } = {}) {
  await acquireLock();
  try {
    if (reservedSlots.has(candidateId)) {
      const reservation = reservedSlots.get(candidateId);
      reservedSlots.delete(candidateId);
      return { transferred: true, reservation };
    }
    return { transferred: false, reason: 'reservation_not_found' };
  } finally {
    releaseLock();
  }
}

/**
 * Get current reservation state (for diagnostics/testing)
 */
function getReservationState() {
  return {
    lockedByAnotherThread: reservationLocked,
    waitersCount: lockWaiters.length,
    reservedSlots: Array.from(reservedSlots.values()),
    reservedCount: reservedSlots.size,
  };
}

/**
 * Clear all reservations (emergency/testing only)
 * Used during startup/reconciliation to ensure stale reservations don't leak
 */
function clearAllReservations() {
  const cleared = reservedSlots.size;
  reservedSlots.clear();
  return { cleared };
}

module.exports = {
  tryReserveSlot,
  releaseReservation,
  transferToOwnership,
  getReservationState,
  clearAllReservations,
};
