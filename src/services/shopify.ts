import { createHash } from "node:crypto";
import { getConfig } from "../config.js";
import type { DistributorProduct, ProviderName } from "../types/distributor.js";
import type {
  InventoryQuantityUpdate,
  SyncedShopifyVariant,
  SyncedVariantPage,
} from "../types/shopify.js";
import { AppError } from "../utils/errors.js";
import { fetchJson } from "../utils/http.js";
import { calculateShopifyPrice } from "../utils/markup.js";

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
    };
  };
}

interface UserError {
  field?: string[];
  message: string;
  code?: string;
}

export interface ProductUpsertResult {
  productId?: string;
  operationId?: string;
  status: "completed" | "accepted";
  variantCount: number;
}

const PRODUCT_SET_MUTATION = `#graphql
  mutation UpsertPodProduct(
    $identifier: ProductSetIdentifiers!,
    $input: ProductSetInput!,
    $synchronous: Boolean!
  ) {
    productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
      product { id }
      productSetOperation { id status }
      userErrors { code field message }
    }
  }
`;

const SYNCED_VARIANTS_QUERY = `#graphql
  query SyncedVariants($first: Int!, $after: String, $locationId: ID!) {
    productVariants(first: $first, after: $after, query: "product_status:active") {
      nodes {
        id
        sku
        inventoryItem {
          id
          tracked
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
        provider: metafield(namespace: "pod_sync", key: "provider") { value }
        sourceProductId: metafield(namespace: "pod_sync", key: "source_product_id") { value }
        sourceVariantId: metafield(namespace: "pod_sync", key: "source_variant_id") { value }
        catalogProductId: metafield(namespace: "pod_sync", key: "catalog_product_id") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SET_INVENTORY_MUTATION = `#graphql
  mutation SetPodInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { code field message }
    }
  }
`;

const PRODUCT_OPERATION_QUERY = `#graphql
  query ProductSetOperation($id: ID!) {
    productOperation(id: $id) {
      ... on ProductSetOperation {
        id
        status
        product { id }
        userErrors { code field message }
      }
    }
  }
`;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 240);
}

function metafield(key: string, value: string): Record<string, string> {
  return { namespace: "pod_sync", key, type: "single_line_text_field", value };
}

function optionOrder(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "color" || lower === "colour") return 0;
  if (lower === "size") return 1;
  return 2;
}

function deterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function throwUserErrors(action: string, errors: UserError[]): void {
  if (errors.length === 0) return;
  throw new AppError(
    `${action} failed: ${errors.map((error) => error.message).join("; ")}`,
    502,
    errors,
  );
}

export class ShopifyService {
  private readonly config = getConfig();

  public constructor(private readonly accessToken: string) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = `https://${this.config.SHOPIFY_SHOP}/admin/api/${this.config.SHOPIFY_API_VERSION}/graphql.json`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetchJson<GraphqlResponse<T>>(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
          "User-Agent": "printify-printful-shopify-sync/1.0",
        },
        body: JSON.stringify({ query, variables }),
      });

      const errors = response.errors ?? [];
      const throttled = errors.some((error) => error.extensions?.code === "THROTTLED");
      if (throttled && attempt < 4) {
        const throttle = response.extensions?.cost?.throttleStatus;
        const restoreRate = Math.max(1, throttle?.restoreRate ?? 50);
        const missing = Math.max(1, 100 - (throttle?.currentlyAvailable ?? 0));
        await new Promise((resolve) => setTimeout(resolve, Math.ceil((missing / restoreRate) * 1_000)));
        continue;
      }
      if (errors.length > 0) {
        throw new AppError(`Shopify GraphQL error: ${errors.map((error) => error.message).join("; ")}`, 502, errors);
      }
      if (!response.data) throw new AppError("Shopify returned no GraphQL data", 502);
      return response.data;
    }
    throw new AppError("Shopify remained throttled after retries", 429);
  }

  public async upsertProduct(
    product: DistributorProduct,
    requestedStatus: "ACTIVE" | "DRAFT",
  ): Promise<ProductUpsertResult> {
    const optionNames = [
      ...new Set(product.variants.flatMap((variant) => Object.keys(variant.options))),
    ].sort((a, b) => optionOrder(a) - optionOrder(b) || a.localeCompare(b));
    if (optionNames.length > 3) {
      throw new AppError(`Shopify supports at most 3 options; received ${optionNames.length}`, 422);
    }
    if (optionNames.length === 0) optionNames.push("Title");

    const fileByUrl = new Map(
      product.images.map((image) => [
        image.url,
        { originalSource: image.url, alt: image.alt, contentType: "IMAGE" },
      ]),
    );
    for (const variant of product.variants) {
      if (variant.imageUrl && !fileByUrl.has(variant.imageUrl)) {
        fileByUrl.set(variant.imageUrl, {
          originalSource: variant.imageUrl,
          alt: `${product.title} - ${Object.values(variant.options).join(" / ")}`,
          contentType: "IMAGE",
        });
      }
    }

    const productOptions = optionNames.map((name, index) => ({
      name,
      position: index + 1,
      values: [
        ...new Set(
          product.variants.map((variant) =>
            name === "Title" ? "Default Title" : (variant.options[name] ?? "Default"),
          ),
        ),
      ].map((value) => ({ name: value })),
    }));

    const variants = product.variants.map((variant, index) => {
      const input: Record<string, unknown> = {
        position: index + 1,
        optionValues: optionNames.map((name) => ({
          optionName: name,
          name: name === "Title" ? "Default Title" : (variant.options[name] ?? "Default"),
        })),
        price: calculateShopifyPrice(variant.cost, {
          multiplier: this.config.MARKUP_MULTIPLIER,
          fixedAmount: this.config.MARKUP_FIXED_AMOUNT,
        }),
        sku: variant.sku,
        inventoryPolicy: "DENY",
        inventoryItem: {
          tracked: true,
          requiresShipping: true,
          sku: variant.sku,
          cost: variant.cost.toFixed(2),
        },
        inventoryQuantities: [
          {
            locationId: this.config.SHOPIFY_LOCATION_ID,
            name: "available",
            quantity: variant.available ? this.config.IN_STOCK_QUANTITY : 0,
          },
        ],
        metafields: [
          metafield("provider", product.provider),
          metafield("source_product_id", product.sourceProductId),
          metafield("source_variant_id", variant.sourceVariantId),
          ...(variant.catalogProductId
            ? [metafield("catalog_product_id", variant.catalogProductId)]
            : []),
        ],
      };
      if (variant.barcode) input.barcode = variant.barcode;
      if (variant.imageUrl) input.file = fileByUrl.get(variant.imageUrl);
      return input;
    });

    const handle = `pod-${product.provider}-${slug(product.sourceProductId)}`;
    const synchronous = product.variants.length <= 100 && fileByUrl.size <= 100;
    const data = await this.graphql<{
      productSet: {
        product?: { id: string };
        productSetOperation?: { id: string; status: string };
        userErrors: UserError[];
      };
    }>(PRODUCT_SET_MUTATION, {
      identifier: { handle },
      synchronous,
      input: {
        handle,
        title: product.title,
        descriptionHtml: product.descriptionHtml,
        vendor: product.vendor,
        tags: product.tags,
        status: requestedStatus,
        files: [...fileByUrl.values()],
        productOptions,
        variants,
        metafields: [
          metafield("provider", product.provider),
          metafield("source_product_id", product.sourceProductId),
        ],
      },
    });
    throwUserErrors("Shopify productSet", data.productSet.userErrors);

    if (synchronous) {
      if (!data.productSet.product?.id) throw new AppError("Shopify did not return the product ID", 502);
      return {
        productId: data.productSet.product.id,
        status: "completed",
        variantCount: product.variants.length,
      };
    }
    if (!data.productSet.productSetOperation?.id) {
      throw new AppError("Shopify did not return the asynchronous product operation ID", 502);
    }
    return {
      operationId: data.productSet.productSetOperation.id,
      status: "accepted",
      variantCount: product.variants.length,
    };
  }

  public async getSyncedVariantPage(after?: string): Promise<SyncedVariantPage> {
    interface Node {
      id: string;
      sku: string;
      inventoryItem: {
        id: string;
        tracked: boolean;
        inventoryLevel?: { quantities: Array<{ name: string; quantity: number }> };
      };
      provider?: { value: string };
      sourceProductId?: { value: string };
      sourceVariantId?: { value: string };
      catalogProductId?: { value: string };
    }
    const data = await this.graphql<{
      productVariants: {
        nodes: Node[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(SYNCED_VARIANTS_QUERY, {
      first: this.config.SYNC_PAGE_SIZE,
      after: after ?? null,
      locationId: this.config.SHOPIFY_LOCATION_ID,
    });

    const variants: SyncedShopifyVariant[] = [];
    for (const node of data.productVariants.nodes) {
      const provider = node.provider?.value as ProviderName | undefined;
      const sourceProductId = node.sourceProductId?.value;
      const sourceVariantId = node.sourceVariantId?.value;
      const inventoryLevel = node.inventoryItem.inventoryLevel;
      if (
        (provider !== "printify" && provider !== "printful") ||
        !sourceProductId ||
        !sourceVariantId ||
        !node.inventoryItem.tracked ||
        !inventoryLevel
      ) continue;
      const currentQuantity = inventoryLevel.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0;
      const variant: SyncedShopifyVariant = {
        variantId: node.id,
        inventoryItemId: node.inventoryItem.id,
        currentQuantity,
        sku: node.sku,
        provider,
        sourceProductId,
        sourceVariantId,
      };
      if (node.catalogProductId?.value) variant.catalogProductId = node.catalogProductId.value;
      variants.push(variant);
    }

    const page: SyncedVariantPage = {
      variants,
      hasNextPage: data.productVariants.pageInfo.hasNextPage,
    };
    if (data.productVariants.pageInfo.endCursor) {
      page.endCursor = data.productVariants.pageInfo.endCursor;
    }
    return page;
  }

  public async awaitProductOperation(
    operationId: string,
    variantCount: number,
    timeoutMs = 30_000,
  ): Promise<ProductUpsertResult> {
    const deadline = Date.now() + timeoutMs;
    do {
      const data = await this.graphql<{
        productOperation?: {
          id: string;
          status: "CREATED" | "ACTIVE" | "COMPLETE";
          product?: { id: string };
          userErrors: UserError[];
        };
      }>(PRODUCT_OPERATION_QUERY, { id: operationId });
      if (!data.productOperation) throw new AppError("Shopify product operation was not found", 502);
      if (data.productOperation.status === "COMPLETE") {
        throwUserErrors("Asynchronous Shopify productSet", data.productOperation.userErrors);
        if (!data.productOperation.product?.id) {
          throw new AppError("Completed Shopify product operation has no product ID", 502);
        }
        return {
          productId: data.productOperation.product.id,
          operationId,
          status: "completed",
          variantCount,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } while (Date.now() < deadline);

    return { operationId, status: "accepted", variantCount };
  }

  public async setInventoryQuantities(
    updates: InventoryQuantityUpdate[],
    idempotencySeed: string,
  ): Promise<number> {
    let changed = 0;
    for (let offset = 0; offset < updates.length; offset += 100) {
      const chunk = updates.slice(offset, offset + 100);
      if (chunk.length === 0) continue;
      const data = await this.graphql<{
        inventorySetQuantities: { userErrors: UserError[] };
      }>(SET_INVENTORY_MUTATION, {
        idempotencyKey: deterministicUuid(`${idempotencySeed}:${offset}`),
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `pod-sync://availability/${encodeURIComponent(idempotencySeed)}/${offset}`,
          quantities: chunk.map((update) => ({
            inventoryItemId: update.inventoryItemId,
            locationId: this.config.SHOPIFY_LOCATION_ID,
            quantity: update.quantity,
            changeFromQuantity: update.currentQuantity,
          })),
        },
      });
      throwUserErrors("Shopify inventorySetQuantities", data.inventorySetQuantities.userErrors);
      changed += chunk.length;
    }
    return changed;
  }
}
