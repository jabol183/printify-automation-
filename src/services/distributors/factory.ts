import type { DistributorAdapter, ProviderName } from "../../types/distributor.js";
import type { AppSecrets } from "../secretStore.js";
import { PrintfulAdapter } from "./printful.js";
import { PrintifyAdapter } from "./printify.js";

export function createDistributorAdapter(
  provider: ProviderName,
  secrets: AppSecrets,
): DistributorAdapter {
  return provider === "printify"
    ? new PrintifyAdapter(secrets.printifyToken)
    : new PrintfulAdapter(secrets.printfulToken);
}
