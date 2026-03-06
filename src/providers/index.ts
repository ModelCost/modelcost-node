export type { BaseProvider, ExtractedUsage } from "./base.js";
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { GoogleProvider } from "./google.js";

import type { ModelCostClient } from "../client.js";
import type { ModelCostConfig } from "../config.js";
import { BudgetManager } from "../budget.js";
import { CostTracker } from "../tracking.js";
import { PiiScanner } from "../pii.js";
import { TokenBucketRateLimiter } from "../rate-limiter.js";
import type { SessionContext } from "../session.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import type { BaseProvider } from "./base.js";

/**
 * Detect the provider from a client object by duck-typing.
 */
function detectProvider(client: unknown): string | null {
  const obj = client as Record<string, unknown>;
  if (obj["chat"] && typeof obj["chat"] === "object") {
    const chat = obj["chat"] as Record<string, unknown>;
    if (chat["completions"]) return "openai";
  }
  if (obj["messages"] && typeof obj["messages"] === "object") {
    return "anthropic";
  }
  if (typeof obj["getGenerativeModel"] === "function") {
    return "google";
  }
  return null;
}

/**
 * Create the appropriate provider wrapper for a given AI client.
 */
export function createProviderForClient(
  client: unknown,
  apiClient: ModelCostClient,
  config: ModelCostConfig,
  budgetManager: BudgetManager,
  costTracker: CostTracker,
  piiScanner: PiiScanner,
  rateLimiter: TokenBucketRateLimiter,
  session?: SessionContext,
): BaseProvider {
  const providerName = detectProvider(client);

  switch (providerName) {
    case "openai":
      return new OpenAIProvider(
        apiClient,
        config,
        budgetManager,
        costTracker,
        piiScanner,
        rateLimiter,
        session,
      );
    case "anthropic":
      return new AnthropicProvider(
        apiClient,
        config,
        budgetManager,
        costTracker,
        piiScanner,
        rateLimiter,
        session,
      );
    case "google":
      return new GoogleProvider(
        apiClient,
        config,
        budgetManager,
        costTracker,
        piiScanner,
        rateLimiter,
        session,
      );
    default:
      throw new Error(
        `Unsupported AI client. Could not detect provider from client object. ` +
          `Supported providers: openai, anthropic, google.`,
      );
  }
}
