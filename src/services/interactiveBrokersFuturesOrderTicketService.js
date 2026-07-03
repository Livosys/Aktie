'use strict';

/**
 * IB Paper Futures — Order Ticket builder (Phase 2, PREVIEW ONLY).
 *
 * Builds a fully validated 1-contract LIMIT order ticket for MES/MNQ from the
 * verified futures live view. This is the "orderprompt" layer: it decides
 * whether a ticket WOULD be submittable and what the exact order would look
 * like — it NEVER submits, queues, arms or cancels anything.
 *
 * Hard properties:
 *   - PREVIEW ONLY. There is no submit path in this service and no route may
 *     build one from it in Phase 2. `wouldSubmit` is always false.
 *   - Never touches IB_PAPER_SUBMIT_ROUTES_ENABLED or any submit path.
 *   - Futures submit (a later phase) must use its OWN reserved flag
 *     IB_FUTURES_SUBMIT_ROUTES_ENABLED (default false, read here for status
 *     reporting only — nothing in this service acts on it).
 *   - Only MES/MNQ are allowed; ES/NQ are explicitly blocked initially.
 *   - Quantity must be exactly 1. Order type is LIMIT only (no market orders).
 *   - The limit price must derive from the verified (delayed OK) price:
 *     aligned to minTick, within MAX_LIMIT_OFFSET_TICKS of the reference and
 *     within MAX_LIMIT_DEVIATION_PCT of the reference.
 *   - Manual gate: the ticket carries a required confirmation phrase that a
 *     human must type/click in a later phase. The phrase check here only
 *     reports whether it matches — it unlocks nothing.
 *   - Every stop rule failure is a named blocker; any blocker ⇒ not ready.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const FUTURES_SUBMIT_FLAG = 'IB_FUTURES_SUBMIT_ROUTES_ENABLED'; // reserved, default OFF, unused in Phase 2

const ALLOWED_ROOTS = Object.freeze(['MES', 'MNQ']);
const BLOCKED_ROOTS = Object.freeze(['ES', 'NQ']); // explicitly blocked in the first version
const ALLOWED_SIDES = Object.freeze(['BUY', 'SELL']);
const REQUIRED_QUANTITY = 1;
const REQUIRED_ACCOUNT = 'DUQ565596';
const ORDER_TYPE = 'LMT';
const TIME_IN_FORCE = 'DAY';
const ALLOWED_PRICE_TYPES = Object.freeze(['realtime', 'delayed']); // frozen/stale/none never priceable

// Price tolerance rule: the limit price must stay glued to the verified
// reference price. Both limits apply.
const MAX_LIMIT_OFFSET_TICKS = 10;      // max |limit - reference| in ticks
const MAX_LIMIT_DEVIATION_PCT = 0.5;    // max |limit - reference| as % of reference

function envFlagEnabled(name) {
  return ['true', '1', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase());
}

function safeNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Round to the contract tick grid without float dust (prices are k*minTick).
function roundToTick(price, minTick) {
  const p = safeNum(price);
  const t = safeNum(minTick);
  if (p === null || t === null || t <= 0) return null;
  const ticks = Math.round(p / t);
  return Number((ticks * t).toFixed(10));
}

function isTickAligned(price, minTick) {
  const p = safeNum(price);
  const t = safeNum(minTick);
  if (p === null || t === null || t <= 0) return false;
  const ratio = p / t;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

/**
 * Derive the limit price from the verified reference price. Pure.
 * BUY rests below (reference - offset), SELL above (reference + offset).
 * offsetTicks is clamped to [0, MAX_LIMIT_OFFSET_TICKS].
 */
function deriveLimitPrice({ referencePrice, minTick, side, offsetTicks = 0 }) {
  const ref = safeNum(referencePrice);
  const tick = safeNum(minTick);
  if (ref === null || ref <= 0 || tick === null || tick <= 0) return null;
  if (!ALLOWED_SIDES.includes(side)) return null;
  const clamped = Math.min(Math.max(Math.trunc(safeNum(offsetTicks) ?? 0), 0), MAX_LIMIT_OFFSET_TICKS);
  const signed = side === 'BUY' ? -clamped : clamped;
  return roundToTick(ref + signed * tick, tick);
}

/**
 * Validate a limit price against the verified reference. Pure.
 * Returns [] when OK, otherwise named blockers.
 */
function validateLimitPrice({ limitPrice, referencePrice, minTick }) {
  const blockers = [];
  const limit = safeNum(limitPrice);
  const ref = safeNum(referencePrice);
  const tick = safeNum(minTick);
  if (limit === null || limit <= 0) return ['limit_price_missing'];
  if (ref === null || ref <= 0) return ['no_usable_price'];
  if (tick === null || tick <= 0) return ['min_tick_unknown'];
  if (!isTickAligned(limit, tick)) blockers.push('limit_price_not_tick_aligned');
  const offsetTicks = Math.abs(limit - ref) / tick;
  if (offsetTicks > MAX_LIMIT_OFFSET_TICKS + 1e-6) blockers.push('limit_price_out_of_tolerance');
  const deviationPct = (Math.abs(limit - ref) / ref) * 100;
  if (deviationPct > MAX_LIMIT_DEVIATION_PCT + 1e-9) blockers.push('limit_price_out_of_tolerance');
  return [...new Set(blockers)];
}

/** The phrase a human must type in the manual gate (later phase). Pure. */
function buildConfirmationPhrase({ root, side, quantity, limitPrice }) {
  return `PAPER ${side} ${quantity} ${root} LMT ${limitPrice}`;
}

/**
 * Evaluate every stop rule and assemble the ticket. Pure — all inputs injected.
 *
 * @param {object} opts
 * @param {string} opts.root            requested symbol root (MES/MNQ)
 * @param {string} opts.side            BUY | SELL (explicit, never guessed)
 * @param {number} opts.quantity        must be exactly 1
 * @param {number} [opts.limitPrice]    explicit limit; derived when omitted
 * @param {number} [opts.offsetTicks]   passive offset used when deriving
 * @param {string} [opts.orderType]     must be LMT (anything else blocked)
 * @param {string} [opts.confirmationPhrase] human-typed phrase (reported only)
 * @param {object} opts.contract        matching contract from the live view
 * @param {object} opts.safetyStatus    current runtime safety flags
 * @param {string} opts.account         active paper account id
 * @param {boolean} opts.paperSubmitRoutesEnabled  IB_PAPER_SUBMIT_ROUTES_ENABLED runtime value
 */
function buildOrderTicket(opts = {}) {
  const {
    root: rawRoot,
    side: rawSide,
    quantity: rawQuantity,
    limitPrice: rawLimitPrice,
    offsetTicks = 0,
    orderType: rawOrderType,
    confirmationPhrase = null,
    contract = null,
    safetyStatus = null,
    account = null,
    paperSubmitRoutesEnabled = false,
    now = new Date(),
  } = opts;

  const root = String(rawRoot ?? '').trim().toUpperCase();
  const side = String(rawSide ?? '').trim().toUpperCase();
  const quantity = safeNum(rawQuantity);
  const orderType = String(rawOrderType ?? ORDER_TYPE).trim().toUpperCase();
  const blockers = [];

  // ── Symbol rules ───────────────────────────────────────────────────────────
  if (!root) blockers.push('symbol_missing');
  else if (BLOCKED_ROOTS.includes(root)) blockers.push('symbol_blocked_initial_version');
  else if (!ALLOWED_ROOTS.includes(root)) blockers.push('symbol_not_allowed');

  // ── Side / quantity / order type ───────────────────────────────────────────
  if (!ALLOWED_SIDES.includes(side)) blockers.push('side_invalid');
  if (quantity !== REQUIRED_QUANTITY) blockers.push('quantity_not_exactly_one');
  if (orderType !== ORDER_TYPE) blockers.push('order_type_not_allowed');

  // ── Account rule ───────────────────────────────────────────────────────────
  if (String(account ?? '').trim() !== REQUIRED_ACCOUNT) blockers.push('account_mismatch');

  // ── Contract verification rules ────────────────────────────────────────────
  const contractRoot = String(contract?.root ?? '').trim().toUpperCase();
  const verified = contract?.contractMonthVerified === true;
  const priceType = contract?.priceType ?? null;
  const referencePrice = safeNum(contract?.price);
  const minTick = safeNum(contract?.minTick);
  if (!contract || (root && contractRoot !== root)) blockers.push('contract_not_found');
  else {
    if (!verified) blockers.push('contract_not_verified');
    if (contract.hasUsablePrice !== true || referencePrice === null || referencePrice <= 0) {
      blockers.push('no_usable_price');
    } else if (!ALLOWED_PRICE_TYPES.includes(priceType)) {
      // priceable data must be realtime or delayed — never frozen/stale/unknown
      blockers.push('price_type_not_allowed');
    }
    if (minTick === null || minTick <= 0) blockers.push('min_tick_unknown');
  }

  // ── Safety rules: any drift from the locked paper-only state blocks ────────
  const safetyLocked = !!safetyStatus
    && safetyStatus.mode === 'paper_only'
    && safetyStatus.actions_allowed === false
    && safetyStatus.can_place_orders === false
    && safetyStatus.live_trading_enabled === false
    && safetyStatus.broker_enabled === false;
  if (!safetyLocked) blockers.push('safety_state_changed');

  // ── Limit price: explicit or derived from the verified reference ───────────
  let limitPrice = safeNum(rawLimitPrice);
  const canPrice = referencePrice !== null && referencePrice > 0 && minTick !== null && minTick > 0;
  if (limitPrice === null && canPrice && ALLOWED_SIDES.includes(side)) {
    limitPrice = deriveLimitPrice({ referencePrice, minTick, side, offsetTicks });
  }
  if (canPrice) {
    blockers.push(...validateLimitPrice({ limitPrice, referencePrice, minTick }));
  } else if (limitPrice === null) {
    blockers.push('limit_price_missing');
  }

  // ── Phase-2 structural blockers: submit does not exist yet ─────────────────
  blockers.push('futures_submit_routes_not_implemented');
  const futuresSubmitFlagEnabled = envFlagEnabled(FUTURES_SUBMIT_FLAG);
  if (!futuresSubmitFlagEnabled) blockers.push('futures_submit_routes_disabled');

  const uniqueBlockers = [...new Set(blockers)];
  // "Ready" here means: every USER-fixable stop rule passed; only the Phase-2
  // structural locks remain. It still submits nothing.
  const structural = new Set(['futures_submit_routes_not_implemented', 'futures_submit_routes_disabled']);
  const readyForManualConfirmation = uniqueBlockers.every((b) => structural.has(b));

  const requiredConfirmationPhrase = readyForManualConfirmation && limitPrice !== null
    ? buildConfirmationPhrase({ root, side, quantity: REQUIRED_QUANTITY, limitPrice })
    : null;
  const confirmationMatches = requiredConfirmationPhrase !== null
    && String(confirmationPhrase ?? '').trim() === requiredConfirmationPhrase;

  return {
    ok: true,
    readOnly: true,
    previewOnly: true,
    phase: 'fas2_order_ticket_preview',
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    request: { root, side, quantity, orderType, limitPrice: safeNum(rawLimitPrice), offsetTicks },
    ticket: {
      account: REQUIRED_ACCOUNT,
      root,
      localSymbol: contract?.localSymbol ?? null,
      conId: contract?.conId ?? null,
      contractMonth: contract?.contractMonth ?? null,
      exchange: contract?.exchange ?? 'CME',
      currency: contract?.currency ?? 'USD',
      side: ALLOWED_SIDES.includes(side) ? side : null,
      quantity: REQUIRED_QUANTITY,
      orderType: ORDER_TYPE,
      timeInForce: TIME_IN_FORCE,
      limitPrice,
      referencePrice,
      referencePriceType: priceType,
      minTick,
      tolerance: { maxOffsetTicks: MAX_LIMIT_OFFSET_TICKS, maxDeviationPct: MAX_LIMIT_DEVIATION_PCT },
    },
    manualGate: {
      required: true,
      requiredConfirmationPhrase,
      confirmationProvided: confirmationPhrase !== null && String(confirmationPhrase).trim() !== '',
      confirmationMatches,
      note: 'Manuell bekräftelse krävs alltid. Frasen låser INTE upp något i Fas 2 — submit-vägen finns inte.',
    },
    blockers: uniqueBlockers,
    readyForManualConfirmation,
    wouldSubmit: false,
    submitRoutesEnabled: paperSubmitRoutesEnabled === true,
    futuresSubmitRoutesEnabled: futuresSubmitFlagEnabled,
    allowedRoots: [...ALLOWED_ROOTS],
    blockedRoots: [...BLOCKED_ROOTS],
    safety: { ...SAFETY },
  };
}

module.exports = {
  SAFETY,
  FUTURES_SUBMIT_FLAG,
  ALLOWED_ROOTS,
  BLOCKED_ROOTS,
  REQUIRED_QUANTITY,
  REQUIRED_ACCOUNT,
  MAX_LIMIT_OFFSET_TICKS,
  MAX_LIMIT_DEVIATION_PCT,
  buildOrderTicket,
  _internal: {
    deriveLimitPrice,
    validateLimitPrice,
    buildConfirmationPhrase,
    roundToTick,
    isTickAligned,
  },
};
