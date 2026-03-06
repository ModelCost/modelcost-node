import { describe, it, expect } from "vitest";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { RateLimitedError } from "../src/errors.js";

describe("TokenBucketRateLimiter", () => {
  it("should allow requests within burst capacity", () => {
    const limiter = new TokenBucketRateLimiter(10, 5);

    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
  });

  it("should deny requests when tokens are exhausted", () => {
    const limiter = new TokenBucketRateLimiter(10, 2);

    expect(limiter.allow()).toBe(true); // 1 remaining
    expect(limiter.allow()).toBe(true); // 0 remaining
    expect(limiter.allow()).toBe(false); // denied
  });

  it("should refill tokens over time", async () => {
    const limiter = new TokenBucketRateLimiter(100, 1);

    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);

    // Wait for refill (100 tokens/sec = 1 token every 10ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(limiter.allow()).toBe(true);
  });

  it("should throw RateLimitedError in strict mode", () => {
    const limiter = new TokenBucketRateLimiter(1, 1, true);

    expect(limiter.allow()).toBe(true);

    expect(() => limiter.allow()).toThrow(RateLimitedError);
    try {
      limiter.allow();
    } catch (e) {
      const err = e as RateLimitedError;
      expect(err.limitDimension).toBe("token_bucket");
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("should wait until a token is available", async () => {
    const limiter = new TokenBucketRateLimiter(100, 1);

    limiter.allow(); // consume the one token

    const start = Date.now();
    await limiter.wait();
    const elapsed = Date.now() - start;

    // Should have waited roughly 10ms (100 tokens/sec = 10ms per token)
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(100);
  });

  it("should resolve wait immediately when tokens are available", async () => {
    const limiter = new TokenBucketRateLimiter(10, 5);

    const start = Date.now();
    await limiter.wait();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it("should not exceed burst capacity on refill", async () => {
    const limiter = new TokenBucketRateLimiter(1000, 3);

    // Wait a long time for lots of refill
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not have more than burst
    expect(limiter.availableTokens).toBeLessThanOrEqual(3);
  });
});
