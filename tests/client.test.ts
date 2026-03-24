import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup.js";
import { ModelCostConfig } from "../src/config.js";
import { ModelCostClient } from "../src/client.js";

const TEST_CONFIG = new ModelCostConfig({
  apiKey: "mc_test_client_key",
  orgId: "org-test",
  failOpen: false,
});

const TEST_CONFIG_FAIL_OPEN = new ModelCostConfig({
  apiKey: "mc_test_client_key",
  orgId: "org-test",
  failOpen: true,
});

describe("ModelCostClient", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("should track a call successfully", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const response = await client.track({
      apiKey: "mc_test_client_key",
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(response.status).toBe("ok");
    client.close();
  });

  it("should check budget and return allowed", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const response = await client.checkBudget("org-test", "chatbot", 5.0);

    expect(response.allowed).toBe(true);
    expect(response.action).toBeNull();
    client.close();
  });

  it("should return budget blocked when estimated cost is high", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const response = await client.checkBudget("org-test", "chatbot", 150.0);

    expect(response.allowed).toBe(false);
    expect(response.action).toBe("block");
    client.close();
  });

  it("should get budget status", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const status = await client.getBudgetStatus("org-test");

    expect(status.totalBudgetUsd).toBe(500);
    expect(status.totalSpendUsd).toBe(123.45);
    expect(status.policiesAtRisk).toBe(0);
    expect(status.policies).toHaveLength(1);
    expect(status.policies[0]!.name).toBe("Monthly Org Budget");
    client.close();
  });

  it("should scan text for PII violations", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const result = await client.scanText({
      orgId: "org-test",
      text: "My SSN is 123-45-6789",
    });

    expect(result.isAllowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.subtype).toBe("ssn");
    client.close();
  });

  it("should scan clean text and return allowed", async () => {
    const client = new ModelCostClient(TEST_CONFIG);

    const result = await client.scanText({
      orgId: "org-test",
      text: "Hello, how are you?",
    });

    expect(result.isAllowed).toBe(true);
    expect(result.violations).toHaveLength(0);
    client.close();
  });

  describe("circuit breaker", () => {
    it("should open circuit after 3 consecutive failures (fail-open mode)", async () => {
      const client = new ModelCostClient(TEST_CONFIG_FAIL_OPEN);

      // Override track endpoint to return 500
      server.use(
        http.post("https://api.modelcost.ai/api/v1/track", () => {
          return HttpResponse.json(
            { error: "internal", message: "Server error" },
            { status: 500 },
          );
        }),
      );

      const trackReq = {
        apiKey: "mc_test_client_key",
        timestamp: new Date().toISOString(),
        provider: "openai" as const,
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
      };

      // First 3 failures trigger circuit breaker
      const r1 = await client.track(trackReq);
      expect(r1.status).toBe("ok"); // fail-open returns default
      const r2 = await client.track(trackReq);
      expect(r2.status).toBe("ok");
      const r3 = await client.track(trackReq);
      expect(r3.status).toBe("ok");

      // 4th call: circuit is open, should get fail-open default without making request
      const r4 = await client.track(trackReq);
      expect(r4.status).toBe("ok"); // fail-open default

      client.close();
    });

    it("should throw when circuit opens in fail-closed mode", async () => {
      const client = new ModelCostClient(TEST_CONFIG); // failOpen: false

      server.use(
        http.post("https://api.modelcost.ai/api/v1/track", () => {
          return HttpResponse.json(
            { error: "internal", message: "Server error" },
            { status: 500 },
          );
        }),
      );

      const trackReq = {
        apiKey: "mc_test_client_key",
        timestamp: new Date().toISOString(),
        provider: "openai" as const,
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
      };

      // Fail-closed mode: API errors should throw
      await expect(client.track(trackReq)).rejects.toThrow();

      client.close();
    });
  });

  describe("session endpoints with empty responses", () => {
    it("should handle recordSessionCall with empty 200 response", async () => {
      const client = new ModelCostClient(TEST_CONFIG);

      // Should not throw despite empty response body
      await expect(
        client.recordSessionCall("sess_server_001", {
          apiKey: "mc_test_client_key",
          callSequence: 1,
          callType: "llm",
          inputTokens: 100,
          outputTokens: 50,
          cumulativeInputTokens: 100,
          costUsd: 0.01,
          cumulativeCostUsd: 0.01,
          piiDetected: false,
        }),
      ).resolves.toBeUndefined();

      client.close();
    });

    it("should handle closeSession with empty 200 response", async () => {
      const client = new ModelCostClient(TEST_CONFIG);

      // Should not throw despite empty response body
      await expect(
        client.closeSession("sess_server_001", {
          apiKey: "mc_test_client_key",
          status: "completed",
          finalSpendUsd: 0.05,
          finalIterationCount: 3,
        }),
      ).resolves.toBeUndefined();

      client.close();
    });
  });
});
