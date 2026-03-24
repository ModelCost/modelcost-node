import type { BaseProvider, ExtractedUsage } from "./base.js";
import type { ModelCostClient } from "../client.js";
import type { ModelCostConfig } from "../config.js";
import { BudgetExceededError, PiiDetectedError } from "../errors.js";
import { BudgetManager } from "../budget.js";
import { CostTracker, calculateCost } from "../tracking.js";
import { PiiScanner } from "../pii.js";
import { TokenBucketRateLimiter } from "../rate-limiter.js";
import type { Provider } from "../models/common.js";
import type { SessionContext } from "../session.js";

/**
 * Typings for the subset of the OpenAI client we interact with.
 * We use structural typing so the SDK does not depend on the openai package.
 */
interface OpenAIPromptTokensDetails {
  cached_tokens?: number;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: OpenAIPromptTokensDetails;
}

interface OpenAIChatResponse {
  usage?: OpenAIUsage;
  model?: string;
  [key: string]: unknown;
}

interface OpenAIChatCompletions {
  create: (...args: unknown[]) => Promise<OpenAIChatResponse>;
}

interface OpenAIChat {
  completions: OpenAIChatCompletions;
}

interface OpenAILikeClient {
  chat: OpenAIChat;
  [key: string]: unknown;
}

/**
 * Provider wrapper for OpenAI-compatible clients.
 *
 * Intercepts `client.chat.completions.create()` calls to:
 * 1. Run a budget pre-check
 * 2. Scan prompt messages for PII
 * 3. Enforce rate limits
 * 4. Extract usage from the response and record the cost
 */
export class OpenAIProvider implements BaseProvider {
  private readonly _client: ModelCostClient;
  private readonly _config: ModelCostConfig;
  private readonly _budgetManager: BudgetManager;
  private readonly _costTracker: CostTracker;
  private readonly _piiScanner: PiiScanner;
  private readonly _rateLimiter: TokenBucketRateLimiter;
  private readonly _session?: SessionContext;

  constructor(
    apiClient: ModelCostClient,
    config: ModelCostConfig,
    budgetManager: BudgetManager,
    costTracker: CostTracker,
    piiScanner: PiiScanner,
    rateLimiter: TokenBucketRateLimiter,
    session?: SessionContext,
  ) {
    this._client = apiClient;
    this._config = config;
    this._budgetManager = budgetManager;
    this._costTracker = costTracker;
    this._piiScanner = piiScanner;
    this._rateLimiter = rateLimiter;
    this._session = session;
  }

  getProviderName(): string {
    return "openai";
  }

  extractUsage(response: unknown): ExtractedUsage {
    const res = response as OpenAIChatResponse;
    const promptTokens = res.usage?.prompt_tokens ?? 0;
    const cachedTokens = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const regularInput = Math.max(0, promptTokens - cachedTokens);
    return {
      inputTokens: regularInput,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: cachedTokens,
    };
  }

  wrap(client: unknown): unknown {
    const openaiClient = client as OpenAILikeClient;
    const self = this;

    // Create a proxy for the chat.completions object
    const completionsProxy = new Proxy(openaiClient.chat.completions, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (...args: unknown[]) => {
            const params = (args[0] ?? {}) as Record<string, unknown>;
            const model = (params["model"] as string) ?? "unknown";

            // 1. Rate limit check
            await self._rateLimiter.wait();

            // 2. PII / governance scan on messages
            const messages = params["messages"] as
              | Array<{ content?: string }>
              | undefined;
            if (messages) {
              for (const msg of messages) {
                if (typeof msg.content === "string") {
                  const scanResult = self._piiScanner.scan(msg.content);
                  if (scanResult.detected) {
                    if (self._config.contentPrivacy) {
                      // Metadata-only mode: full local classification, never send raw content
                      const fullResult = self._piiScanner.fullScan(msg.content);

                      if (fullResult.detected) {
                        // Report signals asynchronously (fire-and-forget)
                        for (const violation of fullResult.violations) {
                          self._client
                            .reportSignal({
                              organizationId: self._config.orgId,
                              violationType: violation.category,
                              violationSubtype: violation.type,
                              severity: violation.severity,
                              environment: self._config.environment,
                              actionTaken: "block",
                              wasAllowed: false,
                              detectedAt: new Date().toISOString(),
                              source: "metadata_only",
                              violationCount: 1,
                            })
                            .catch(() => {}); // fire-and-forget
                        }

                        throw new PiiDetectedError(
                          "Sensitive content detected and blocked locally (metadata-only mode)",
                          fullResult.violations.map((v) => ({
                            type: v.category,
                            subtype: v.type,
                            severity: v.severity as "low" | "medium" | "high",
                            start: v.start,
                            end: v.end,
                          })),
                          self._piiScanner.redact(msg.content),
                        );
                      }
                    } else {
                      // Standard mode: check governance policy server-side
                      const govResult = await self._client.scanText({
                        orgId: self._config.orgId,
                        text: msg.content,
                        environment: self._config.environment,
                      });

                      if (!govResult.isAllowed) {
                        throw new PiiDetectedError(
                          "PII detected in request and blocked by policy",
                          govResult.violations,
                          govResult.redactedText ?? scanResult.redactedText,
                        );
                      }
                    }
                  }
                }
              }
            }

            // 3. Budget pre-check
            const estimatedCost = calculateCost(model, 500, 500); // estimate
            const budgetCheck = await self._budgetManager.check(
              self._client,
              self._config.orgId,
              (params["feature"] as string) ?? "default",
              estimatedCost,
            );

            if (!budgetCheck.allowed && budgetCheck.action === "block") {
              throw new BudgetExceededError(
                budgetCheck.reason ?? "Budget exceeded",
                0,
                "organization",
              );
            }

            // 3b. Session pre-check
            if (self._session) {
              self._session.preCallCheck(estimatedCost);
            }

            // 4. Execute the actual API call
            const startTime = Date.now();
            const response = await target.create.apply(target, args as never);
            const latencyMs = Date.now() - startTime;

            // 5. Extract usage and record
            const usage = self.extractUsage(response);
            const cost = calculateCost(
              model,
              usage.inputTokens,
              usage.outputTokens,
            );

            self._costTracker.record(
              {
                apiKey: self._config.apiKey,
                timestamp: new Date().toISOString(),
                provider: "openai" as Provider,
                model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationTokens: usage.cacheCreationTokens || undefined,
                cacheReadTokens: usage.cacheReadTokens || undefined,
                latencyMs,
                metadata: {},
              },
              self._client,
            );

            // 6. Update local budget spend
            self._budgetManager.updateLocalSpend(
              self._config.orgId,
              (params["feature"] as string) ?? "default",
              cost,
            );

            // 7. Session call recording
            if (self._session) {
              self._session.recordCall({
                callType: "llm",
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd: cost,
              });
            }

            return response;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Create a proxy for the chat object
    const chatProxy = new Proxy(openaiClient.chat, {
      get(target, prop, receiver) {
        if (prop === "completions") {
          return completionsProxy;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Create a proxy for the top-level client
    return new Proxy(openaiClient, {
      get(target, prop, receiver) {
        if (prop === "chat") {
          return chatProxy;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
