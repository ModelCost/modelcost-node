import { RateLimitedError } from "./errors.js";

/**
 * Token-bucket rate limiter.
 *
 * Allows `burst` tokens to be consumed immediately, and refills at `rate`
 * tokens per second. Useful for throttling outbound API calls.
 */
export class TokenBucketRateLimiter {
  private _tokens: number;
  private _lastRefill: number;
  private readonly _rate: number;
  private readonly _burst: number;
  private readonly _strict: boolean;

  /**
   * @param rate - Tokens refilled per second
   * @param burst - Maximum tokens (bucket capacity)
   * @param strict - If true, `allow()` throws RateLimitedError instead of returning false
   */
  constructor(rate: number, burst: number, strict = false) {
    this._rate = rate;
    this._burst = burst;
    this._tokens = burst;
    this._lastRefill = Date.now();
    this._strict = strict;
  }

  /**
   * Attempt to consume one token.
   * Returns true if allowed, false if rate-limited.
   * In strict mode, throws RateLimitedError instead of returning false.
   */
  allow(): boolean {
    this._refill();

    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }

    if (this._strict) {
      const retryAfter = Math.ceil((1 - this._tokens) / this._rate);
      throw new RateLimitedError(
        `Rate limit exceeded. Retry after ${retryAfter}s.`,
        retryAfter,
        "token_bucket",
      );
    }

    return false;
  }

  /**
   * Wait until a token is available, then consume it.
   * Resolves immediately if a token is available now.
   */
  async wait(): Promise<void> {
    this._refill();

    if (this._tokens >= 1) {
      this._tokens -= 1;
      return;
    }

    // Calculate how long until 1 token is available
    const deficit = 1 - this._tokens;
    const waitMs = Math.ceil((deficit / this._rate) * 1000);

    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    this._refill();
    this._tokens -= 1;
  }

  /**
   * Get the current number of available tokens (for inspection/testing).
   */
  get availableTokens(): number {
    this._refill();
    return this._tokens;
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this._tokens = Math.min(this._burst, this._tokens + elapsed * this._rate);
    this._lastRefill = now;
  }
}
