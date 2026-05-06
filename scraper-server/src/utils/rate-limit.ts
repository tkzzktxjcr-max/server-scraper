import { config } from "../config.js";
import { sleep } from "./retry.js";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

export function checkRateLimit(clientId: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(clientId);
  const windowMs = config.rateLimit.windowMs;
  const maxRequests = config.rateLimit.maxRequests;

  if (!entry || now > entry.resetTime) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetIn: windowMs };
  }

  if (entry.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: entry.resetTime - now,
    };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: maxRequests - entry.count,
    resetIn: entry.resetTime - now,
  };
}

/**
 * Delay with configurable base + random jitter for anti-detection
 */
export async function requestDelay(): Promise<void> {
  const baseMs = config.rateLimit.delayMs;
  const jitterMs = config.rateLimit.jitterMs;
  const totalDelay = baseMs + Math.random() * jitterMs;
  await sleep(totalDelay);
}