import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getConfig } from "../config.js";
import { AppError } from "../utils/errors.js";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const client = new SSMClient({});
const cache = new Map<string, CacheEntry>();

export interface AppSecrets {
  shopifyAccessToken: string;
  printifyToken: string;
  printfulToken: string;
  importApiKey: string;
}

export async function getParameters(names: string[]): Promise<Map<string, string>> {
  const now = Date.now();
  const result = new Map<string, string>();
  const missing: string[] = [];

  for (const name of names) {
    const cached = cache.get(name);
    if (cached && cached.expiresAt > now) result.set(name, cached.value);
    else missing.push(name);
  }

  if (missing.length > 0) {
    const response = await client.send(
      new GetParametersCommand({ Names: missing, WithDecryption: true }),
    );
    if (response.InvalidParameters && response.InvalidParameters.length > 0) {
      throw new AppError(
        `Missing SSM parameters: ${response.InvalidParameters.join(", ")}`,
        500,
      );
    }

    const ttl = getConfig().SECRET_CACHE_TTL_MS;
    for (const parameter of response.Parameters ?? []) {
      if (parameter.Name && parameter.Value) {
        cache.set(parameter.Name, { value: parameter.Value, expiresAt: now + ttl });
        result.set(parameter.Name, parameter.Value);
      }
    }
  }

  const unresolved = names.filter((name) => !result.has(name));
  if (unresolved.length > 0) {
    throw new AppError(`SSM returned no value for: ${unresolved.join(", ")}`, 500);
  }
  return result;
}

export async function getAppSecrets(): Promise<AppSecrets> {
  const config = getConfig();
  const names = [
    config.SHOPIFY_TOKEN_PARAMETER,
    config.PRINTIFY_TOKEN_PARAMETER,
    config.PRINTFUL_TOKEN_PARAMETER,
    config.IMPORT_API_KEY_PARAMETER,
  ];
  const parameters = await getParameters(names);
  return {
    shopifyAccessToken: parameters.get(config.SHOPIFY_TOKEN_PARAMETER)!,
    printifyToken: parameters.get(config.PRINTIFY_TOKEN_PARAMETER)!,
    printfulToken: parameters.get(config.PRINTFUL_TOKEN_PARAMETER)!,
    importApiKey: parameters.get(config.IMPORT_API_KEY_PARAMETER)!,
  };
}

export function clearSecretCacheForTests(): void {
  cache.clear();
}
