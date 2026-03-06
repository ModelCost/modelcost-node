import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { server } from "../setup.js";
import { ModelCostConfig } from "../../src/config.js";
import { ModelCostClient } from "../../src/client.js";
import { BudgetManager } from "../../src/budget.js";
import { CostTracker } from "../../src/tracking.js";
import { PiiScanner } from "../../src/pii.js";
import { TokenBucketRateLimiter } from "../../src/rate-limiter.js";
import { OpenAIProvider } from "../../src/providers/openai.js";

const TEST_CONFIG = new ModelCostConfig({
  apiKey: "mc_test_openai_key",
  orgId: "org-openai-test",
});

/**
 * Minimal mock of an OpenAI-like client.
 */
function createMockOpenAIClient(mockResponse: Record<string, unknown>) {
  return {
    chat: {
      completions: {
        create: async (_params: unknown) => mockResponse,
      },
    },
  };
}

describe("OpenAIProvider", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("should return 'openai' as provider name", () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const provider = new OpenAIProvider(
      client,
      TEST_CONFIG,
      new BudgetManager(10_000),
      new CostTracker(100),
      new PiiScanner(),
      new TokenBucketRateLimiter(100, 100),
    );

    expect(provider.getProviderName()).toBe("openai");
    client.close();
  });

  it("should extract usage from an OpenAI-style response", () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const provider = new OpenAIProvider(
      client,
      TEST_CONFIG,
      new BudgetManager(10_000),
      new CostTracker(100),
      new PiiScanner(),
      new TokenBucketRateLimiter(100, 100),
    );

    const usage = provider.extractUsage({
      usage: {
        prompt_tokens: 150,
        completion_tokens: 75,
        total_tokens: 225,
      },
      model: "gpt-4o",
    });

    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(75);
    client.close();
  });

  it("should handle missing usage gracefully", () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const provider = new OpenAIProvider(
      client,
      TEST_CONFIG,
      new BudgetManager(10_000),
      new CostTracker(100),
      new PiiScanner(),
      new TokenBucketRateLimiter(100, 100),
    );

    const usage = provider.extractUsage({});

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    client.close();
  });

  it("should wrap an OpenAI client and intercept create calls", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const costTracker = new CostTracker(100);
    const provider = new OpenAIProvider(
      client,
      TEST_CONFIG,
      new BudgetManager(10_000),
      costTracker,
      new PiiScanner(),
      new TokenBucketRateLimiter(100, 100),
    );

    const mockClient = createMockOpenAIClient({
      id: "chatcmpl-123",
      model: "gpt-4o",
      usage: {
        prompt_tokens: 50,
        completion_tokens: 25,
        total_tokens: 75,
      },
      choices: [
        {
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
    });

    const wrapped = provider.wrap(mockClient) as typeof mockClient;
    const response = await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(response.model).toBe("gpt-4o");
    expect(response.usage).toBeDefined();

    // Cost tracker should have recorded the call
    expect(costTracker.bufferSize).toBe(1);

    client.close();
  });

  it("should preserve non-intercepted properties on the client", async () => {
    const client = new ModelCostClient(TEST_CONFIG);
    const provider = new OpenAIProvider(
      client,
      TEST_CONFIG,
      new BudgetManager(10_000),
      new CostTracker(100),
      new PiiScanner(),
      new TokenBucketRateLimiter(100, 100),
    );

    const mockClient = {
      ...createMockOpenAIClient({ model: "gpt-4o", usage: { prompt_tokens: 0, completion_tokens: 0 } }),
      models: { list: () => [{ id: "gpt-4o" }] },
      customProp: "test-value",
    };

    const wrapped = provider.wrap(mockClient) as typeof mockClient;

    expect(wrapped.customProp).toBe("test-value");
    expect(wrapped.models.list()).toEqual([{ id: "gpt-4o" }]);

    client.close();
  });
});
