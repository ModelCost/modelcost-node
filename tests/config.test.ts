import { describe, it, expect, afterEach } from "vitest";
import { ModelCostConfig } from "../src/config.js";

describe("ModelCostConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env after each test
    process.env = { ...originalEnv };
  });

  it("should create a valid config with required options", () => {
    const config = new ModelCostConfig({
      apiKey: "mc_test_key_123",
      orgId: "org-abc",
    });

    expect(config.apiKey).toBe("mc_test_key_123");
    expect(config.orgId).toBe("org-abc");
    expect(config.environment).toBe("production");
    expect(config.baseUrl).toBe("https://api.modelcost.ai");
    expect(config.failOpen).toBe(true);
    expect(config.flushIntervalMs).toBe(5000);
    expect(config.flushBatchSize).toBe(100);
    expect(config.syncIntervalMs).toBe(10000);
    expect(config.budgetAction).toBe("alert");
    expect(config.monthlyBudget).toBeUndefined();
  });

  it("should accept all optional configuration fields", () => {
    const config = new ModelCostConfig({
      apiKey: "mc_full_config",
      orgId: "org-full",
      environment: "staging",
      baseUrl: "https://staging.modelcost.ai",
      monthlyBudget: 1000,
      budgetAction: "block",
      failOpen: false,
      flushIntervalMs: 10000,
      flushBatchSize: 50,
      syncIntervalMs: 30000,
    });

    expect(config.environment).toBe("staging");
    expect(config.baseUrl).toBe("https://staging.modelcost.ai");
    expect(config.monthlyBudget).toBe(1000);
    expect(config.budgetAction).toBe("block");
    expect(config.failOpen).toBe(false);
    expect(config.flushIntervalMs).toBe(10000);
    expect(config.flushBatchSize).toBe(50);
    expect(config.syncIntervalMs).toBe(30000);
  });

  it("should fall back to env vars when options are not provided", () => {
    process.env["MODELCOST_API_KEY"] = "mc_env_key";
    process.env["MODELCOST_ORG_ID"] = "org-env";
    process.env["MODELCOST_ENV"] = "test";
    process.env["MODELCOST_BASE_URL"] = "https://test.modelcost.ai";

    // Pass undefined-ish values to trigger fallback
    const config = new ModelCostConfig({
      apiKey: undefined as unknown as string,
      orgId: undefined as unknown as string,
    });

    expect(config.apiKey).toBe("mc_env_key");
    expect(config.orgId).toBe("org-env");
    expect(config.environment).toBe("test");
    expect(config.baseUrl).toBe("https://test.modelcost.ai");
  });

  it("should reject an API key that does not start with mc_", () => {
    expect(
      () =>
        new ModelCostConfig({
          apiKey: "invalid_key_no_prefix",
          orgId: "org-123",
        }),
    ).toThrow("API key must start with 'mc_'");
  });

  it("should reject an empty org ID", () => {
    expect(
      () =>
        new ModelCostConfig({
          apiKey: "mc_valid_key",
          orgId: "",
        }),
    ).toThrow();
  });

  it("should reject an invalid base URL", () => {
    expect(
      () =>
        new ModelCostConfig({
          apiKey: "mc_valid_key",
          orgId: "org-123",
          baseUrl: "not-a-url",
        }),
    ).toThrow();
  });

  it("should reject negative monthly budget", () => {
    expect(
      () =>
        new ModelCostConfig({
          apiKey: "mc_valid_key",
          orgId: "org-123",
          monthlyBudget: -100,
        }),
    ).toThrow();
  });

  it("should reject invalid budget action", () => {
    expect(
      () =>
        new ModelCostConfig({
          apiKey: "mc_valid_key",
          orgId: "org-123",
          budgetAction: "explode" as "alert",
        }),
    ).toThrow();
  });
});
