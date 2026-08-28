import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { EventBridgeHandler } from "aws-lambda";
import { getConfig } from "../config.js";
import { createDistributorAdapter } from "../services/distributors/factory.js";
import { getAppSecrets } from "../services/secretStore.js";
import { ShopifyService } from "../services/shopify.js";
import type { ProviderName } from "../types/distributor.js";
import type { SyncedShopifyVariant } from "../types/shopify.js";
import { AppError, errorMessage } from "../utils/errors.js";
import { mapWithConcurrency } from "../utils/http.js";

interface SyncDetail {
  cursor?: string;
  runId?: string;
  pageNumber?: number;
}

interface GroupedVariants {
  provider: ProviderName;
  sourceProductId: string;
  variants: SyncedShopifyVariant[];
}

const lambda = new LambdaClient({});

function groupVariants(variants: SyncedShopifyVariant[]): GroupedVariants[] {
  const groups = new Map<string, GroupedVariants>();
  for (const variant of variants) {
    const key = `${variant.provider}:${variant.sourceProductId}`;
    const group = groups.get(key) ?? {
      provider: variant.provider,
      sourceProductId: variant.sourceProductId,
      variants: [],
    };
    group.variants.push(variant);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const handler: EventBridgeHandler<"Scheduled Event", SyncDetail, void> = async (event) => {
  const detail = event.detail ?? {};
  const runId = detail.runId ?? event.id ?? randomUUID();
  const pageNumber = detail.pageNumber ?? 1;
  const startedAt = Date.now();

  try {
    const config = getConfig();
    const secrets = await getAppSecrets();
    const shopify = new ShopifyService(secrets.shopifyAccessToken);
    const page = await shopify.getSyncedVariantPage(detail.cursor);
    const groups = groupVariants(page.variants);

    const availabilityResults = await mapWithConcurrency(groups, 3, async (group) => {
      const adapter = createDistributorAdapter(group.provider, secrets);
      const availability = await adapter.getAvailability(
        group.sourceProductId,
        group.variants.map((variant) => ({
          sourceVariantId: variant.sourceVariantId,
          ...(variant.catalogProductId ? { catalogProductId: variant.catalogProductId } : {}),
        })),
      );
      return { group, availability };
    });

    const updates = availabilityResults.flatMap(({ group, availability }) =>
      group.variants.flatMap((variant) => {
        const available = availability.get(variant.sourceVariantId);
        if (available === undefined) {
          console.warn(JSON.stringify({
            event: "availability_missing",
            runId,
            provider: variant.provider,
            sourceProductId: variant.sourceProductId,
            sourceVariantId: variant.sourceVariantId,
          }));
          return [];
        }
        const quantity = available ? config.IN_STOCK_QUANTITY : 0;
        return quantity === variant.currentQuantity
          ? []
          : [{
              inventoryItemId: variant.inventoryItemId,
              currentQuantity: variant.currentQuantity,
              quantity,
            }];
      }),
    );

    const changed = await shopify.setInventoryQuantities(
      updates,
      `${runId}:page:${pageNumber}:${detail.cursor ?? "start"}`,
    );

    if (page.hasNextPage) {
      if (!page.endCursor) throw new AppError("Shopify indicated another page without a cursor", 502);
      const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
      if (!functionName) throw new AppError("AWS_LAMBDA_FUNCTION_NAME is unavailable", 500);
      const nextDetail: SyncDetail = {
        cursor: page.endCursor,
        runId,
        pageNumber: pageNumber + 1,
      };
      await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({
          id: runId,
          source: "pod-sync.pagination",
          "detail-type": "Scheduled Event",
          detail: nextDetail,
        })),
      }));
    }

    console.info(JSON.stringify({
      event: "inventory_sync_page_completed",
      runId,
      pageNumber,
      scanned: page.variants.length,
      changed,
      hasNextPage: page.hasNextPage,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "inventory_sync_page_failed",
      runId,
      pageNumber,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    }));
    throw error;
  }
};
