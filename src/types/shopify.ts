import type { ProviderName } from "./distributor.js";

export interface SyncedShopifyVariant {
  variantId: string;
  inventoryItemId: string;
  currentQuantity: number;
  sku: string;
  provider: ProviderName;
  sourceProductId: string;
  sourceVariantId: string;
  catalogProductId?: string;
}

export interface SyncedVariantPage {
  variants: SyncedShopifyVariant[];
  hasNextPage: boolean;
  endCursor?: string;
}

export interface InventoryQuantityUpdate {
  inventoryItemId: string;
  currentQuantity: number;
  quantity: number;
}
