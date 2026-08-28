export const PROVIDERS = ["printify", "printful"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface DistributorImage {
  url: string;
  alt: string;
  variantIds: string[];
}

export interface DistributorVariant {
  sourceVariantId: string;
  catalogProductId?: string;
  sku: string;
  barcode?: string;
  cost: number;
  currency: string;
  options: Record<string, string>;
  imageUrl?: string;
  available: boolean;
}

export interface DistributorProduct {
  provider: ProviderName;
  sourceProductId: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  tags: string[];
  images: DistributorImage[];
  variants: DistributorVariant[];
}

export interface InventorySourceVariant {
  sourceVariantId: string;
  catalogProductId?: string;
}

export interface DistributorAdapter {
  readonly name: ProviderName;
  getProduct(productId: string): Promise<DistributorProduct>;
  getAvailability(
    productId: string,
    variants: InventorySourceVariant[],
  ): Promise<Map<string, boolean>>;
}
