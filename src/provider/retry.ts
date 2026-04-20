import type { AppConfig } from '../config/schema.js';
import type { ModelProvider, ModelRequest, ModelResponse } from './types.js';

export interface RetryEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export async function invokeWithRetry(
  config: AppConfig,
  provider: ModelProvider,
  request: ModelRequest,
  onRetry?: (event: RetryEvent) => Promise<void> | void,
): Promise<ModelResponse> {
  const maxAttempts = Math.max(1, config.session.modelRetryAttempts + 1);
  let attempt = 1;
  let lastError: unknown;

  while (attempt <= maxAttempts) {
    try {
      return await provider.invoke(request);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableProviderError(error)) {
        throw error;
      }

      const delayMs = Math.max(250, config.session.modelRetryDelayMs * attempt);
      await onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      await delay(delayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableProviderError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (/status 429\b/.test(message) || /rate limit/.test(message)) {
    return true;
  }

  if (/status 5\d\d\b/.test(message) || /status 408\b/.test(message)) {
    return true;
  }

  if (/timeout|timed out|aborterror|econnreset|econnrefused|enotfound|temporar/.test(message)) {
    return true;
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
