import { getConfig } from "../../config.js";
import type {
  DistributorAdapter,
  DistributorImage,
  DistributorProduct,
  DistributorVariant,
  InventorySourceVariant,
} from "../../types/distributor.js";
import { AppError } from "../../utils/errors.js";
import { fetchJson, mapWithConcurrency } from "../../utils/http.js";

interface PrintfulFile {
  type?: string;
  url?: string;
  preview_url?: string;
  thumbnail_url?: string;
}

interface PrintfulSyncVariant {
  id: number;
  external_id?: string;
  name: string;
  variant_id: number;
  retail_price?: string;
  currency?: string;
  sku?: string;
  files?: PrintfulFile[];
  options?: Array<{ id?: string; name?: string; value?: string }> | Record<string, string>;
  product?: {
    product_id?: number;
    variant_id?: number;
    name?: string;
    image?: string;
  };
  is_ignored?: boolean;
  synced?: boolean;
}

interface PrintfulStoreProduct {
  sync_product: {
    id: number;
    name: string;
    thumbnail_url?: string;
    is_ignored?: boolean;
  };
  sync_variants: PrintfulSyncVariant[];
}

interface PrintfulLegacyResponse<T> {
  result: T;
}

interface PrintfulV2Page<T> {
  data: T[] | T;
  paging?: { total?: number; offset?: number; limit?: number };
  _links?: { next?: { href?: string } };
}

interface AvailabilityRow {
  catalog_variant_id: number;
  techniques?: Array<{
    selling_regions?: Array<{ name?: string; availability?: string }>;
  }>;
}

interface CatalogProductDetails {
  brand?: string;
  type?: string;
  description?: string;
  image?: string;
}

function descriptionHtml(value: string | undefined): string {
  if (!value) return "";
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function imageFromFiles(files: PrintfulFile[] | undefined): string | undefined {
  const candidates = files ?? [];
  const preview = candidates.find((file) => file.type === "preview");
  return preview?.preview_url ?? preview?.thumbnail_url ?? preview?.url ??
    candidates[0]?.preview_url ?? candidates[0]?.thumbnail_url ?? candidates[0]?.url;
}

function normalizeOptionName(name: string): string {
  const value = name.trim().toLowerCase();
  if (value === "color" || value === "colour") return "Color";
  if (value === "size") return "Size";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function variantOptions(variant: PrintfulSyncVariant, productName: string): Record<string, string> {
  if (Array.isArray(variant.options) && variant.options.length > 0) {
    return Object.fromEntries(
      variant.options
        .filter((option) => option.value)
        .map((option) => [normalizeOptionName(option.name ?? option.id ?? "Option"), option.value!]),
    );
  }
  if (variant.options && typeof variant.options === "object") {
    return Object.fromEntries(
      Object.entries(variant.options).map(([key, value]) => [normalizeOptionName(key), value]),
    );
  }

  const suffix = variant.name.replace(productName, "").replace(/^\s*[-–—]\s*/, "");
  const parts = suffix.split(/\s*\/\s*/).filter(Boolean);
  if (parts.length === 1) return { Title: parts[0] ?? variant.name };
  if (parts.length >= 2) return { Color: parts[0]!, Size: parts[1]! };
  return { Title: variant.name };
}

function extractPriceMap(payloads: unknown[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const payload of payloads) {
    const page = payload as PrintfulV2Page<unknown>;
    const records = Array.isArray(page.data) ? page.data : [page.data];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const variants = (record as { variants?: unknown[] }).variants ?? [];
      for (const candidate of variants) {
        if (!candidate || typeof candidate !== "object") continue;
        const variant = candidate as {
          id?: number;
          techniques?: Array<{ price?: string; discounted_price?: string }>;
        };
        if (variant.id === undefined) continue;
        const values = (variant.techniques ?? [])
          .map((technique) => Number(technique.discounted_price ?? technique.price))
          .filter((value) => Number.isFinite(value) && value >= 0);
        if (values.length > 0) prices.set(String(variant.id), Math.min(...values));
      }
    }
  }
  return prices;
}

export class PrintfulAdapter implements DistributorAdapter {
  public readonly name = "printful" as const;
  private readonly legacyBaseUrl = "https://api.printful.com";
  private readonly v2BaseUrl = "https://api.printful.com/v2";

  public constructor(private readonly token: string) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": "printify-printful-shopify-sync/1.0",
    };
    const storeId = getConfig().PRINTFUL_STORE_ID;
    if (storeId) headers["X-PF-Store-Id"] = storeId;
    return headers;
  }

  private async getStoreProduct(productId: string): Promise<PrintfulStoreProduct> {
    const response = await fetchJson<PrintfulLegacyResponse<PrintfulStoreProduct>>(
      `${this.legacyBaseUrl}/store/products/${encodeURIComponent(productId)}`,
      { headers: this.headers() },
    );
    return response.result;
  }

  private async getV2Pages<T>(path: string): Promise<PrintfulV2Page<T>[]> {
    const pages: PrintfulV2Page<T>[] = [];
    let url: string | undefined = `${this.v2BaseUrl}${path}${path.includes("?") ? "&" : "?"}limit=100&offset=0`;
    for (let pageNumber = 0; url && pageNumber < 100; pageNumber += 1) {
      const page: PrintfulV2Page<T> = await fetchJson<PrintfulV2Page<T>>(url, {
        headers: this.headers(),
      });
      pages.push(page);
      const nextUrl = page._links?.next?.href;
      if (nextUrl) {
        url = nextUrl;
        continue;
      }
      const { total = 0, offset = 0, limit = 100 } = page.paging ?? {};
      url = offset + limit < total
        ? `${this.v2BaseUrl}${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset + limit}`
        : undefined;
    }
    return pages;
  }

  private async getCatalogCosts(catalogProductIds: string[]): Promise<Map<string, number>> {
    const config = getConfig();
    const results = await mapWithConcurrency(catalogProductIds, 3, async (id) =>
      this.getV2Pages<unknown>(
        `/catalog-products/${encodeURIComponent(id)}/prices` +
          `?selling_region_name=${encodeURIComponent(config.PRINTFUL_SELLING_REGION)}` +
          `&currency=${encodeURIComponent(config.PRINTFUL_CURRENCY)}`,
      ),
    );
    return extractPriceMap(results.flat());
  }

  private async getCatalogDetails(catalogProductId: string | undefined): Promise<CatalogProductDetails> {
    if (!catalogProductId) return {};
    const response = await fetchJson<PrintfulV2Page<CatalogProductDetails>>(
      `${this.v2BaseUrl}/catalog-products/${encodeURIComponent(catalogProductId)}` +
        `?selling_region_name=${encodeURIComponent(getConfig().PRINTFUL_SELLING_REGION)}`,
      { headers: this.headers() },
    );
    return Array.isArray(response.data) ? (response.data[0] ?? {}) : response.data;
  }

  public async getProduct(productId: string): Promise<DistributorProduct> {
    const product = await this.getStoreProduct(productId);
    const activeVariants = product.sync_variants.filter(
      (variant) => variant.is_ignored !== true && variant.synced !== false,
    );
    if (activeVariants.length === 0) throw new AppError("The Printful product has no synced variants", 422);

    const catalogProductIds = [
      ...new Set(
        activeVariants
          .map((variant) => variant.product?.product_id)
          .filter((id): id is number => id !== undefined)
          .map(String),
      ),
    ];
    const [catalogCosts, catalogDetails] = await Promise.all([
      this.getCatalogCosts(catalogProductIds),
      this.getCatalogDetails(catalogProductIds[0]),
    ]);

    const images: DistributorImage[] = [];
    const mainImage = product.sync_product.thumbnail_url ?? catalogDetails.image;
    if (mainImage) {
      images.push({
        url: mainImage,
        alt: product.sync_product.name,
        variantIds: [],
      });
    }

    const variants: DistributorVariant[] = activeVariants.map((variant) => {
      const sourceVariantId = String(variant.variant_id);
      const imageUrl = imageFromFiles(variant.files) ?? variant.product?.image;
      if (imageUrl) {
        images.push({ url: imageUrl, alt: variant.name, variantIds: [sourceVariantId] });
      }
      const cost = catalogCosts.get(sourceVariantId);
      if (cost === undefined || !Number.isFinite(cost)) {
        throw new AppError(`Printful variant ${sourceVariantId} has no catalog cost`, 502);
      }

      const normalized: DistributorVariant = {
        sourceVariantId,
        sku: variant.sku || `PFL-${product.sync_product.id}-${sourceVariantId}`,
        cost,
        currency: variant.currency ?? getConfig().PRINTFUL_CURRENCY,
        options: variantOptions(variant, product.sync_product.name),
        available: true,
      };
      if (variant.product?.product_id !== undefined) {
        normalized.catalogProductId = String(variant.product.product_id);
      }
      if (imageUrl) normalized.imageUrl = imageUrl;
      return normalized;
    });

    const uniqueImages = [...new Map(images.map((image) => [image.url, image])).values()];
    return {
      provider: this.name,
      sourceProductId: String(product.sync_product.id),
      title: product.sync_product.name,
      descriptionHtml: descriptionHtml(catalogDetails.description),
      vendor: catalogDetails.brand ? `${catalogDetails.brand} / Printful` : "Printful",
      tags: ["Printful", "POD synced", ...(catalogDetails.type ? [catalogDetails.type] : [])],
      images: uniqueImages,
      variants,
    };
  }

  public async getAvailability(
    productId: string,
    variants: InventorySourceVariant[],
  ): Promise<Map<string, boolean>> {
    const enriched = variants.map((variant) => ({ ...variant }));
    if (enriched.some((variant) => !variant.catalogProductId)) {
      const product = await this.getStoreProduct(productId);
      const catalogByVariant = new Map(
        product.sync_variants.map((variant) => [
          String(variant.variant_id),
          variant.product?.product_id === undefined ? undefined : String(variant.product.product_id),
        ]),
      );
      for (const variant of enriched) {
        const catalogProductId = catalogByVariant.get(variant.sourceVariantId);
        if (!variant.catalogProductId && catalogProductId) {
          variant.catalogProductId = catalogProductId;
        }
      }
    }

    const groups = new Map<string, InventorySourceVariant[]>();
    for (const variant of enriched) {
      if (!variant.catalogProductId) continue;
      const group = groups.get(variant.catalogProductId) ?? [];
      group.push(variant);
      groups.set(variant.catalogProductId, group);
    }

    const entries = [...groups.entries()];
    const pagesByProduct = await mapWithConcurrency(entries, 3, async ([catalogProductId]) =>
      this.getV2Pages<AvailabilityRow>(
        `/catalog-products/${encodeURIComponent(catalogProductId)}/availability` +
          `?selling_region_name=${encodeURIComponent(getConfig().PRINTFUL_SELLING_REGION)}`,
      ),
    );
    const result = new Map<string, boolean>();

    entries.forEach(([catalogProductId, group], index) => {
      const pages = pagesByProduct[index] ?? [];
      const rows = pages.flatMap((page) => (Array.isArray(page.data) ? page.data : [page.data]));
      const statusByVariant = new Map(
        rows.map((row) => [
          String(row.catalog_variant_id),
          (row.techniques ?? []).some((technique) =>
            (technique.selling_regions ?? []).some((region) => {
              const status = region.availability?.toLowerCase().replace(/[_-]/g, " ").trim();
              return status === "in stock" || status === "available";
            }),
          ),
        ]),
      );
      for (const variant of group) {
        if (
          variant.catalogProductId === catalogProductId &&
          statusByVariant.has(variant.sourceVariantId)
        ) {
          result.set(variant.sourceVariantId, statusByVariant.get(variant.sourceVariantId)!);
        }
      }
    });

    return result;
  }
}
