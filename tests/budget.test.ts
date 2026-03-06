import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "./setup.js";
import { ModelCostConfig } from "../src/config.js";
import { ModelCostClient } from "../src/client.js";
import { BudgetManager } from "../src/budget.js";

const TEST_CONFIG = new ModelCostConfig({
  apiKey: "mc_test_budget_key",
  orgId: "org-budget-test",
});

describe("BudgetManager", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("should check budget via the API client", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const manager = new BudgetManager(10_000);

    const result = await manager.check(client, "org-budget-test", "chatbot", 5.0);

    expect(result.allowed).toBe(true);
    client.close();
  });

  it("should sync budget status from the server", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const manager = new BudgetManager(10_000);

    await manager.sync(client, "org-budget-test");

    const cached = manager.getCached("org-budget-test");
    expect(cached).toBeDefined();
    expect(cached!.totalBudgetUsd).toBe(500);
    expect(cached!.totalSpendUsd).toBe(123.45);
    expect(cached!.policies).toHaveLength(1);

    client.close();
  });

  it("should update local spend optimistically", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const manager = new BudgetManager(10_000);

    // First sync to populate cache
    await manager.sync(client, "org-budget-test");

    const beforeSpend = manager.getCached("org-budget-test")!.totalSpendUsd;

    // Update local spend
    manager.updateLocalSpend("org-budget-test", "chatbot", 10.0);

    const afterSpend = manager.getCached("org-budget-test")!.totalSpendUsd;
    expect(afterSpend).toBeCloseTo(beforeSpend + 10.0, 2);

    client.close();
  });

  it("should handle updateLocalSpend when no cache exists", () => {
    const manager = new BudgetManager(10_000);

    // Should not throw when no cache entry
    expect(() => {
      manager.updateLocalSpend("org-unknown", "chatbot", 5.0);
    }).not.toThrow();
  });

  it("should re-sync when cache is stale", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    // Use a very short sync interval so it's always stale
    const manager = new BudgetManager(0);

    const result = await manager.check(client, "org-budget-test", "chatbot", 1.0);
    expect(result.allowed).toBe(true);

    // Cache should have been populated by the sync
    const cached = manager.getCached("org-budget-test");
    expect(cached).toBeDefined();

    client.close();
  });

  it("should clear all cached state", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const manager = new BudgetManager(10_000);

    await manager.sync(client, "org-budget-test");
    expect(manager.getCached("org-budget-test")).toBeDefined();

    manager.clear();
    expect(manager.getCached("org-budget-test")).toBeUndefined();

    client.close();
  });
});
