import { getConfig } from "../../config.js";
import type {
  DistributorAdapter,
  DistributorImage,
  DistributorProduct,
  DistributorVariant,
  InventorySourceVariant,
} from "../../types/distributor.js";
import { AppError } from "../../utils/errors.js";
import { fetchJson } from "../../utils/http.js";

interface PrintifyOptionValue {
  id: number;
  title: string;
}

interface PrintifyOption {
  name: string;
  values: PrintifyOptionValue[];
}

interface PrintifyVariant {
  id: number;
  sku?: string;
  cost?: number;
  price?: number;
  options: number[];
  is_enabled?: boolean;
  is_available?: boolean;
}

interface PrintifyImage {
  src: string;
  variant_ids?: number[];
  is_default?: boolean;
  position?: string;
}

interface PrintifyProductResponse {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  options?: PrintifyOption[];
  variants?: PrintifyVariant[];
  images?: PrintifyImage[];
  print_provider_id?: number;
}

function normalizeOptionName(name: string): string {
  const singular = name.toLowerCase() === "colors" ? "Color" : name.toLowerCase() === "sizes" ? "Size" : name;
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function optionMap(options: PrintifyOption[]): Map<number, { name: string; value: string }> {
  const map = new Map<number, { name: string; value: string }>();
  for (const option of options) {
    for (const value of option.values) {
      map.set(value.id, { name: normalizeOptionName(option.name), value: value.title });
    }
  }
  return map;
}

export class PrintifyAdapter implements DistributorAdapter {
  public readonly name = "printify" as const;
  private readonly baseUrl = "https://api.printify.com/v1";

  public constructor(private readonly token: string) {}

  private async request<T>(path: string): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json;charset=utf-8",
        "User-Agent": "printify-printful-shopify-sync/1.0",
      },
    });
  }

  private shopId(): string {
    const shopId = getConfig().PRINTIFY_SHOP_ID;
    if (!shopId) throw new AppError("PRINTIFY_SHOP_ID is required for Printify imports", 500);
    return shopId;
  }

  private async fetchProduct(productId: string): Promise<PrintifyProductResponse> {
    return this.request<PrintifyProductResponse>(
      `/shops/${encodeURIComponent(this.shopId())}/products/${encodeURIComponent(productId)}.json`,
    );
  }

  public async getProduct(productId: string): Promise<DistributorProduct> {
    const product = await this.fetchProduct(productId);
    const options = optionMap(product.options ?? []);
    const imageByVariant = new Map<string, string>();
    const images: DistributorImage[] = (product.images ?? []).map((image) => {
      const variantIds = (image.variant_ids ?? []).map(String);
      for (const variantId of variantIds) {
        if (!imageByVariant.has(variantId) || image.is_default) {
          imageByVariant.set(variantId, image.src);
        }
      }
      return {
        url: image.src,
        alt: `${product.title}${image.position ? ` - ${image.position}` : ""}`,
        variantIds,
      };
    });

    const variants: DistributorVariant[] = (product.variants ?? []).map((variant) => {
      const variantOptions: Record<string, string> = {};
      for (const optionId of variant.options) {
        const option = options.get(optionId);
        if (option) variantOptions[option.name] = option.value;
      }
      const cents = variant.cost;
      if (cents === undefined) {
        throw new AppError(`Printify variant ${variant.id} has no provider cost`, 502);
      }
      const normalized: DistributorVariant = {
        sourceVariantId: String(variant.id),
        sku: variant.sku || `PFY-${product.id}-${variant.id}`,
        cost: cents / 100,
        currency: getConfig().PRINTIFY_CURRENCY,
        options: variantOptions,
        available: variant.is_enabled !== false && variant.is_available !== false,
      };
      const imageUrl = imageByVariant.get(String(variant.id));
      if (imageUrl) normalized.imageUrl = imageUrl;
      return normalized;
    });

    if (variants.length === 0) throw new AppError("The Printify product has no variants", 422);
    return {
      provider: this.name,
      sourceProductId: product.id,
      title: product.title,
      descriptionHtml: product.description ?? "",
      vendor: product.print_provider_id ? `Printify provider ${product.print_provider_id}` : "Printify",
      tags: [...new Set([...(product.tags ?? []), "Printify", "POD synced"])],
      images,
      variants,
    };
  }

  public async getAvailability(
    productId: string,
    variants: InventorySourceVariant[],
  ): Promise<Map<string, boolean>> {
    const product = await this.fetchProduct(productId);
    const requested = new Set(variants.map((variant) => variant.sourceVariantId));
    return new Map(
      (product.variants ?? [])
        .filter((variant) => requested.has(String(variant.id)))
        .map((variant) => [
          String(variant.id),
          variant.is_enabled !== false && variant.is_available !== false,
        ]),
    );
  }
}
