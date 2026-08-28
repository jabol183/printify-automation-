import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  STAGE: z.string().default("dev"),
  SHOPIFY_SHOP: z
    .string()
    .min(1)
    .transform((value) => value.replace(/^https?:\/\//, "").replace(/\/$/, "")),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).default("2026-07"),
  SHOPIFY_LOCATION_ID: z.string().startsWith("gid://shopify/Location/"),
  SHOPIFY_TOKEN_PARAMETER: z.string().startsWith("/"),
  PRINTIFY_TOKEN_PARAMETER: z.string().startsWith("/"),
  PRINTFUL_TOKEN_PARAMETER: z.string().startsWith("/"),
  IMPORT_API_KEY_PARAMETER: z.string().startsWith("/"),
  PRINTIFY_SHOP_ID: optionalNonEmptyString,
  PRINTIFY_CURRENCY: z.string().length(3).transform((value) => value.toUpperCase()).default("USD"),
  PRINTFUL_STORE_ID: optionalNonEmptyString,
  PRINTFUL_SELLING_REGION: z.string().default("worldwide"),
  PRINTFUL_CURRENCY: z.string().length(3).transform((value) => value.toUpperCase()).default("USD"),
  MARKUP_MULTIPLIER: z.coerce.number().positive().default(1.5),
  MARKUP_FIXED_AMOUNT: z.coerce.number().nonnegative().default(5),
  IN_STOCK_QUANTITY: z.coerce.number().int().positive().default(100),
  SECRET_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(250).default(100),
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= envSchema.parse(process.env);
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
