import { describe, expect, it } from "vitest";
import { calculateShopifyPrice } from "../src/utils/markup.js";

describe("calculateShopifyPrice", () => {
  it("applies the requested multiplier, fixed amount, and .99 ending", () => {
    expect(calculateShopifyPrice(10, { multiplier: 1.5, fixedAmount: 5 })).toBe("19.99");
    expect(calculateShopifyPrice(10.01, { multiplier: 1.5, fixedAmount: 5 })).toBe("20.99");
  });

  it("rejects invalid costs", () => {
    expect(() => calculateShopifyPrice(-1, { multiplier: 1.5, fixedAmount: 5 })).toThrow();
    expect(() => calculateShopifyPrice(Number.NaN, { multiplier: 1.5, fixedAmount: 5 })).toThrow();
  });
});
