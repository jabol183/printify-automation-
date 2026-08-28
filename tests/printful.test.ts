import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { PrintfulAdapter } from "../src/services/distributors/printful.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(process.env, {
    SHOPIFY_SHOP: "example.myshopify.com",
    SHOPIFY_LOCATION_ID: "gid://shopify/Location/1",
    SHOPIFY_TOKEN_PARAMETER: "/test/shopify",
    PRINTIFY_TOKEN_PARAMETER: "/test/printify",
    PRINTFUL_TOKEN_PARAMETER: "/test/printful",
    IMPORT_API_KEY_PARAMETER: "/test/import",
    PRINTFUL_CURRENCY: "USD",
    PRINTFUL_SELLING_REGION: "worldwide",
  });
  resetConfigForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  resetConfigForTests();
});

describe("PrintfulAdapter", () => {
  it("uses v2 catalog cost and maps sync product data", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/store/products/42")) {
        return new Response(JSON.stringify({ result: {
          sync_product: { id: 42, name: "Mountain tee", thumbnail_url: "https://img/main.jpg" },
          sync_variants: [{
            id: 500,
            external_id: "ext-500",
            name: "Mountain tee - Navy / L",
            variant_id: 4011,
            retail_price: "25.00",
            currency: "USD",
            files: [{ type: "preview", preview_url: "https://img/navy-l.jpg" }],
            product: { product_id: 71, variant_id: 4011 },
            synced: true,
          }],
        } }), { status: 200 });
      }
      if (url.includes("/catalog-products/71/prices")) {
        return new Response(JSON.stringify({
          data: {
            variants: [{
              id: 4011,
              techniques: [{ price: "12.50", discounted_price: "11.50" }],
            }],
          },
          paging: { total: 1, offset: 0, limit: 100 },
        }), { status: 200 });
      }
      if (url.includes("/catalog-products/71?")) {
        return new Response(JSON.stringify({
          data: {
            brand: "Gildan",
            type: "T-Shirt",
            description: "A soft shirt.",
            image: "https://img/catalog.jpg",
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const product = await new PrintfulAdapter("secret").getProduct("42");
    expect(product.variants[0]).toMatchObject({
      sourceVariantId: "4011",
      catalogProductId: "71",
      cost: 11.5,
      options: { Color: "Navy", Size: "L" },
      imageUrl: "https://img/navy-l.jpg",
    });
    expect(product.descriptionHtml).toBe("<p>A soft shirt.</p>");
    expect(product.vendor).toBe("Gildan / Printful");
  });
});
