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
 * Typings for the subset of the Anthropic client we interact with.
 */
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageResponse {
  usage?: AnthropicUsage;
  model?: string;
  [key: string]: unknown;
}

interface AnthropicMessages {
  create: (...args: unknown[]) => Promise<AnthropicMessageResponse>;
}

interface AnthropicLikeClient {
  messages: AnthropicMessages;
  [key: string]: unknown;
}

/**
 * Provider wrapper for Anthropic clients.
 *
 * Intercepts `client.messages.create()` calls to add budget enforcement,
 * PII scanning, rate limiting, and cost tracking.
 */
export class AnthropicProvider implements BaseProvider {
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
    return "anthropic";
  }

  extractUsage(response: unknown): ExtractedUsage {
    const res = response as AnthropicMessageResponse;
    return {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      cacheCreationTokens: res.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
    };
  }

  wrap(client: unknown): unknown {
    const anthropicClient = client as AnthropicLikeClient;
    const self = this;

    // Create a proxy for the messages object
    const messagesProxy = new Proxy(anthropicClient.messages, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (...args: unknown[]) => {
            const params = (args[0] ?? {}) as Record<string, unknown>;
            const model = (params["model"] as string) ?? "unknown";

            // 1. Rate limit
            await self._rateLimiter.wait();

            // 2. PII scan
            const messages = params["messages"] as
              | Array<{ content?: string | Array<{ text?: string }> }>
              | undefined;
            if (messages) {
              for (const msg of messages) {
                const textContent =
                  typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content
                          .map((block) => block.text ?? "")
                          .join(" ")
                      : "";

                if (textContent) {
                  const scanResult = self._piiScanner.scan(textContent);
                  if (scanResult.detected) {
                    if (self._config.contentPrivacy) {
                      // Metadata-only mode: full local classification, never send raw content
                      const fullResult = self._piiScanner.fullScan(textContent);

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
                          self._piiScanner.redact(textContent),
                        );
                      }
                    } else {
                      // Standard mode: check governance policy server-side
                      const govResult = await self._client.scanText({
                        orgId: self._config.orgId,
                        text: textContent,
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
            const estimatedCost = calculateCost(model, 500, 500);
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

            // 4. Execute
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
                provider: "anthropic" as Provider,
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

    // Create a proxy for the top-level client
    return new Proxy(anthropicClient, {
      get(target, prop, receiver) {
        if (prop === "messages") {
          return messagesProxy;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
