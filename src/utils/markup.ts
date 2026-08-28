export interface MarkupSettings {
  multiplier: number;
  fixedAmount: number;
}

/** Applies the requested formula: ceil((cost * multiplier) + fixed) - 0.01. */
export function calculateShopifyPrice(cost: number, settings: MarkupSettings): string {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new RangeError("Distributor cost must be a finite, non-negative number");
  }

  const markedUp = cost * settings.multiplier + settings.fixedAmount;
  return Math.max(0, Math.ceil(markedUp) - 0.01).toFixed(2);
}
