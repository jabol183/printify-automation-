import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { ShopifyService } from "../src/services/shopify.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(process.env, {
    SHOPIFY_SHOP: "example.myshopify.com",
    SHOPIFY_API_VERSION: "2026-07",
    SHOPIFY_LOCATION_ID: "gid://shopify/Location/1",
    SHOPIFY_TOKEN_PARAMETER: "/test/shopify",
    PRINTIFY_TOKEN_PARAMETER: "/test/printify",
    PRINTFUL_TOKEN_PARAMETER: "/test/printful",
    IMPORT_API_KEY_PARAMETER: "/test/import",
    MARKUP_MULTIPLIER: "1.5",
    MARKUP_FIXED_AMOUNT: "5",
    IN_STOCK_QUANTITY: "100",
  });
  resetConfigForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  resetConfigForTests();
});

describe("ShopifyService", () => {
  it("uses productSet with options, variant metadata, media, and initial inventory", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        data: { productSet: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await new ShopifyService("token").upsertProduct({
      provider: "printify",
      sourceProductId: "abc",
      title: "Tee",
      descriptionHtml: "<p>Tee</p>",
      vendor: "Printify",
      tags: ["POD"],
      images: [{ url: "https://img/tee.jpg", alt: "Tee", variantIds: ["10"] }],
      variants: [{
        sourceVariantId: "10",
        sku: "TEE-10",
        cost: 10,
        currency: "USD",
        options: { Color: "Black", Size: "M" },
        imageUrl: "https://img/tee.jpg",
        available: true,
      }],
    }, "DRAFT");

    expect(result).toMatchObject({ status: "completed", variantCount: 1 });
    const variables = requestBody?.variables as { input: Record<string, unknown> };
    expect(variables.input).toMatchObject({
      handle: "pod-printify-abc",
      status: "DRAFT",
    });
    expect((variables.input.variants as Array<Record<string, unknown>>)[0]).toMatchObject({
      price: "19.99",
      sku: "TEE-10",
      inventoryQuantities: [{
        locationId: "gid://shopify/Location/1",
        name: "available",
        quantity: 100,
      }],
    });
  });
});
