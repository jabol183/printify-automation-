import { AppError, errorMessage } from "./errors.js";

export interface FetchJsonOptions extends RequestInit {
  attempts?: number;
  timeoutMs?: number;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(8_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { attempts = 4, timeoutMs = 20_000, ...requestInit } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        ...requestInit,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }

      if (response.ok) return body as T;

      const failure = new AppError(
        `HTTP ${response.status} from ${new URL(url).host}`,
        response.status,
        body,
      );
      if (!isRetryableStatus(response.status) || attempt === attempts - 1) throw failure;
      lastError = failure;
    } catch (error) {
      lastError = error;
      if (error instanceof AppError && !isRetryableStatus(error.statusCode)) throw error;
      if (attempt === attempts - 1) break;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
  }

  throw new AppError(`Request failed after ${attempts} attempts: ${errorMessage(lastError)}`, 502);
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) result[index] = await mapper(value, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return result;
}
