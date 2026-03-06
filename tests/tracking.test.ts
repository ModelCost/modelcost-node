import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "./setup.js";
import { ModelCostConfig } from "../src/config.js";
import { ModelCostClient } from "../src/client.js";
import { CostTracker, calculateCost, MODEL_PRICING } from "../src/tracking.js";

const TEST_CONFIG = new ModelCostConfig({
  apiKey: "mc_test_tracking_key",
  orgId: "org-tracking-test",
});

describe("calculateCost", () => {
  it("should calculate cost for gpt-4o with 150 input and 50 output tokens", () => {
    const cost = calculateCost("gpt-4o", 150, 50);
    const pricing = MODEL_PRICING.get("gpt-4o")!;

    const expectedInputCost = (150 / 1000) * pricing.inputCostPer1k;
    const expectedOutputCost = (50 / 1000) * pricing.outputCostPer1k;
    const expectedTotal = expectedInputCost + expectedOutputCost;

    expect(cost).toBeCloseTo(expectedTotal, 6);
    // gpt-4o: input=0.005/1k, output=0.015/1k
    // (150/1000)*0.005 + (50/1000)*0.015 = 0.00075 + 0.00075 = 0.0015
    expect(cost).toBeCloseTo(0.0015, 6);
  });

  it("should return 0 for an unknown model", () => {
    const cost = calculateCost("unknown-model-xyz", 1000, 1000);
    expect(cost).toBe(0);
  });

  it("should calculate cost for gpt-4", () => {
    const cost = calculateCost("gpt-4", 1000, 1000);
    // input: (1000/1000)*0.03 = 0.03, output: (1000/1000)*0.06 = 0.06
    expect(cost).toBeCloseTo(0.09, 6);
  });

  it("should calculate cost for claude-sonnet-4", () => {
    const cost = calculateCost("claude-sonnet-4", 1000, 1000);
    // input: (1000/1000)*0.003 = 0.003, output: (1000/1000)*0.015 = 0.015
    expect(cost).toBeCloseTo(0.018, 6);
  });

  it("should calculate cost for gemini-1.5-flash", () => {
    const cost = calculateCost("gemini-1.5-flash", 10000, 5000);
    // input: (10000/1000)*0.000075 = 0.00075
    // output: (5000/1000)*0.0003 = 0.0015
    expect(cost).toBeCloseTo(0.00225, 6);
  });

  it("should handle zero tokens", () => {
    const cost = calculateCost("gpt-4o", 0, 0);
    expect(cost).toBe(0);
  });
});

describe("CostTracker", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("should buffer records and flush them", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const tracker = new CostTracker(100);

    tracker.record({
      apiKey: "mc_test_tracking_key",
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });

    tracker.record({
      apiKey: "mc_test_tracking_key",
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 200,
      outputTokens: 100,
    });

    expect(tracker.bufferSize).toBe(2);

    await tracker.flush(client);

    expect(tracker.bufferSize).toBe(0);

    client.close();
  });

  it("should auto-flush when batch size is reached", () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const tracker = new CostTracker(2); // Batch size of 2

    tracker.record(
      {
        apiKey: "mc_test_tracking_key",
        timestamp: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
      },
      client,
    );

    expect(tracker.bufferSize).toBe(1);

    // This should trigger auto-flush
    tracker.record(
      {
        apiKey: "mc_test_tracking_key",
        timestamp: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 20,
        outputTokens: 10,
      },
      client,
    );

    // Buffer should be drained (flush is async, but splice is synchronous)
    expect(tracker.bufferSize).toBe(0);

    client.close();
  });

  it("should handle flush with empty buffer", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const tracker = new CostTracker(100);

    await expect(tracker.flush(client)).resolves.toBeUndefined();

    client.close();
  });

  it("should start and stop auto-flush", () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const tracker = new CostTracker(100);

    // Should not throw
    tracker.startAutoFlush(client, 1000);
    tracker.stopAutoFlush();

    // Should be safe to stop twice
    tracker.stopAutoFlush();

    client.close();
  });
});
