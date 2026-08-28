import { createHash, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { createDistributorAdapter } from "../services/distributors/factory.js";
import { getAppSecrets } from "../services/secretStore.js";
import { ShopifyService } from "../services/shopify.js";
import { AppError, errorMessage } from "../utils/errors.js";

const bodySchema = z.object({
  provider: z.enum(["printify", "printful"]),
  productId: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  status: z.enum(["ACTIVE", "DRAFT", "active", "draft"]).default("DRAFT").transform((value) => value.toUpperCase() as "ACTIVE" | "DRAFT"),
});

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function secureEqual(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedHash = createHash("sha256").update(received).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const requestId = event.requestContext.requestId;
  try {
    const secrets = await getAppSecrets();
    const apiKey = event.headers["x-import-key"] ?? event.headers["X-Import-Key"];
    if (!secureEqual(apiKey, secrets.importApiKey)) {
      return json(401, { error: "Unauthorized", requestId });
    }
    if (!event.body) throw new AppError("A JSON request body is required", 400);
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      throw new AppError("Request body must be valid JSON", 400);
    }
    const input = bodySchema.parse(parsedJson);
    const adapter = createDistributorAdapter(input.provider, secrets);
    const product = await adapter.getProduct(input.productId);
    const shopify = new ShopifyService(secrets.shopifyAccessToken);
    let result = await shopify.upsertProduct(
      product,
      input.status,
    );
    if (result.status === "accepted" && result.operationId) {
      result = await shopify.awaitProductOperation(result.operationId, result.variantCount);
    }

    console.info(JSON.stringify({
      event: "product_imported",
      requestId,
      provider: input.provider,
      sourceProductId: input.productId,
      result,
    }));
    return json(result.status === "accepted" ? 202 : 200, {
      ...result,
      provider: input.provider,
      sourceProductId: input.productId,
      requestId,
    });
  } catch (error) {
    const statusCode = error instanceof z.ZodError
      ? 400
      : error instanceof AppError
        ? error.statusCode
        : 500;
    console.error(JSON.stringify({
      event: "product_import_failed",
      requestId,
      statusCode,
      error: errorMessage(error),
    }));
    return json(statusCode, {
      error: statusCode >= 500 ? "Product import failed" : errorMessage(error),
      requestId,
    });
  }
};
