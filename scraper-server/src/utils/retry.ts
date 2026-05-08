import { config } from "../config.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitter?: boolean;
  retryableCheck?: (error: unknown) => boolean;
  context?: string;
}

// ─────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: config.scraper.maxRetries,
  baseDelay: config.scraper.retryBaseDelay,
  maxDelay: 30000,
  jitter: true,
  retryableCheck: isRetryableError,
  context: "unknown",
};

// ─────────────────────────────────────────────
// RETRYABLE ERROR DETECTION
// ─────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors
    if (message.includes("timeout")) return true;
    if (message.includes("net::err")) return true;
    if (message.includes("navigation")) return true;
    if (message.includes("connection")) return true;
    if (message.includes("socket")) return true;
    // Rate limiting
    if (message.includes("429")) return true;
    if (message.includes("rate limit")) return true;
    // Server errors
    if (message.includes("500")) return true;
    if (message.includes("502")) return true;
    if (message.includes("503")) return true;
    if (message.includes("504")) return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// DELAY CALCULATION
// ─────────────────────────────────────────────

function calculateDelay(attempt: number, baseDelay: number, maxDelay: number, jitter: boolean): number {
  // Exponential backoff: baseDelay * 2^attempt
  let delay = baseDelay * Math.pow(2, attempt);

  // Cap at maxDelay
  delay = Math.min(delay, maxDelay);

  // Add jitter: random value between 0 and 25% of delay
  if (jitter) {
    const jitterRange = delay * 0.25;
    delay += Math.random() * jitterRange;
  }

  return Math.floor(delay);
}

// ─────────────────────────────────────────────
// RETRY WITH BACKOFF
// ─────────────────────────────────────────────

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      if (!opts.retryableCheck(error)) {
        logger.error(`[${opts.context}] Non-retryable error on attempt ${attempt + 1}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Don't sleep on the last attempt
      if (attempt < opts.maxRetries) {
        const delay = calculateDelay(attempt, opts.baseDelay, opts.maxDelay, opts.jitter);
        logger.warn(`[${opts.context}] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed, retrying in ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  logger.error(`[${opts.context}] All ${opts.maxRetries + 1} attempts exhausted`, {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError;
}

// ─────────────────────────────────────────────
// SIMPLE SLEEP
// ─────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// RANDOM DELAY (for anti-detection)
// ─────────────────────────────────────────────

export function randomDelay(baseMs: number = config.rateLimit.delayMs, jitterMs: number = config.rateLimit.jitterMs): Promise<void> {
  const delay = baseMs + Math.random() * jitterMs;
  return sleep(delay);
}