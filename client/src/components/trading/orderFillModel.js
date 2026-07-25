import {
  firstNumber,
  firstValue,
} from '../../models/strategyViewModel.js';
import {
  getOrderSummary,
  lifecycleLabel,
  lifecycleStatus,
  stableOrderKey,
} from '../../domain/OrderDomain.js';
import {
  getFillSummary,
  stableFillKey,
} from '../../domain/ExecutionDomain.js';
import {
  createStrategyStore,
  resolveStrategy,
} from '../../stores/strategyStore.js';

export { firstNumber, firstValue };
export { lifecycleLabel, lifecycleStatus, stableOrderKey, stableFillKey };

export function buildStrategyContextMaps(args = {}) {
  return createStrategyStore(args);
}

export function resolveStrategyContext(source = {}, strategyStore = null) {
  return resolveStrategy(source, strategyStore);
}

export function normalizeOrderView({
  order = {},
  orderStatus = null,
  strategyStore,
  strategyViewModelMaps,
  strategyContextMaps,
  reconciliation = null,
  snapshotAt = null,
} = {}) {
  const source = { ...order, ...(orderStatus || {}) };
  const strategy = resolveStrategyContext(source, strategyStore || strategyViewModelMaps || strategyContextMaps);
  return getOrderSummary({ order, orderStatus, strategy, reconciliation, snapshotAt });
}

export function normalizeFillView({
  fill = {},
  strategyStore,
  strategyViewModelMaps,
  strategyContextMaps,
} = {}) {
  const strategy = resolveStrategyContext(fill, strategyStore || strategyViewModelMaps || strategyContextMaps);
  return getFillSummary(fill, strategy);
}
