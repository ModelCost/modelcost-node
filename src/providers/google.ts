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
 * Typings for the subset of the Google Generative AI client we interact with.
 */
interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GoogleGenerateContentResponse {
  response: {
    usageMetadata?: GoogleUsageMetadata;
    [key: string]: unknown;
  };
}

interface GoogleGenerativeModel {
  generateContent: (...args: unknown[]) => Promise<GoogleGenerateContentResponse>;
  model?: string;
  [key: string]: unknown;
}

interface GoogleAILikeClient {
  getGenerativeModel: (params: { model: string }) => GoogleGenerativeModel;
  [key: string]: unknown;
}

/**
 * Provider wrapper for Google Generative AI clients.
 *
 * Intercepts `model.generateContent()` calls returned from
 * `client.getGenerativeModel()`.
 */
export class GoogleProvider implements BaseProvider {
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
    return "google";
  }

  extractUsage(response: unknown): ExtractedUsage {
    const res = response as GoogleGenerateContentResponse;
    const metadata = res.response?.usageMetadata;
    const promptTokens = metadata?.promptTokenCount ?? 0;
    const cached = metadata?.cachedContentTokenCount ?? 0;
    const regularInput = Math.max(0, promptTokens - cached);
    return {
      inputTokens: regularInput,
      outputTokens: metadata?.candidatesTokenCount ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
    };
  }

  wrap(client: unknown): unknown {
    const googleClient = client as GoogleAILikeClient;
    const self = this;

    return new Proxy(googleClient, {
      get(target, prop, receiver) {
        if (prop === "getGenerativeModel") {
          return (params: { model: string }) => {
            const model = target.getGenerativeModel(params);
            return self._wrapModel(model, params.model);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private _wrapModel(
    model: GoogleGenerativeModel,
    modelName: string,
  ): GoogleGenerativeModel {
    const self = this;

    return new Proxy(model, {
      get(target, prop, receiver) {
        if (prop === "generateContent") {
          return async (...args: unknown[]) => {
            // 1. Rate limit
            await self._rateLimiter.wait();

            // 2. PII scan on string content
            if (typeof args[0] === "string") {
              const scanResult = self._piiScanner.scan(args[0]);
              if (scanResult.detected) {
                if (self._config.contentPrivacy) {
                  // Metadata-only mode: full local classification, never send raw content
                  const fullResult = self._piiScanner.fullScan(args[0]);

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
                      self._piiScanner.redact(args[0]),
                    );
                  }
                } else {
                  // Standard mode: check governance policy server-side
                  const govResult = await self._client.scanText({
                    orgId: self._config.orgId,
                    text: args[0],
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

            // 3. Budget pre-check
            const estimatedCost = calculateCost(modelName, 500, 500);
            const budgetCheck = await self._budgetManager.check(
              self._client,
              self._config.orgId,
              "default",
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
            const response = await target.generateContent.apply(
              target,
              args as never,
            );
            const latencyMs = Date.now() - startTime;

            // 5. Extract and record
            const usage = self.extractUsage(response);
            const cost = calculateCost(
              modelName,
              usage.inputTokens,
              usage.outputTokens,
            );

            self._costTracker.record(
              {
                apiKey: self._config.apiKey,
                timestamp: new Date().toISOString(),
                provider: "google" as Provider,
                model: modelName,
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
              "default",
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
  }
}
