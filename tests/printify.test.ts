import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { PrintifyAdapter } from "../src/services/distributors/printify.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(process.env, {
    SHOPIFY_SHOP: "example.myshopify.com",
    SHOPIFY_LOCATION_ID: "gid://shopify/Location/1",
    SHOPIFY_TOKEN_PARAMETER: "/test/shopify",
    PRINTIFY_TOKEN_PARAMETER: "/test/printify",
    PRINTFUL_TOKEN_PARAMETER: "/test/printful",
    IMPORT_API_KEY_PARAMETER: "/test/import",
    PRINTIFY_SHOP_ID: "123",
  });
  resetConfigForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  resetConfigForTests();
});

describe("PrintifyAdapter", () => {
  it("normalizes option IDs, cents, images, and availability", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "abc",
      title: "Logo tee",
      description: "<p>Soft tee</p>",
      tags: ["tee"],
      options: [
        { name: "Colors", values: [{ id: 10, title: "Black" }] },
        { name: "Sizes", values: [{ id: 20, title: "M" }] },
      ],
      variants: [{
        id: 99,
        sku: "TEE-BLK-M",
        cost: 1250,
        options: [10, 20],
        is_enabled: true,
        is_available: true,
      }],
      images: [{ src: "https://example.com/tee.png", variant_ids: [99], is_default: true }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const product = await new PrintifyAdapter("secret").getProduct("abc");
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({
      sourceVariantId: "99",
      sku: "TEE-BLK-M",
      cost: 12.5,
      options: { Color: "Black", Size: "M" },
      available: true,
      imageUrl: "https://example.com/tee.png",
    });
  });
});
