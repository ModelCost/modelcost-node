import { ModelCostConfig } from "./config.js";
import type { ModelCostInitOptions } from "./config.js";
import { ModelCostClient } from "./client.js";
import { BudgetManager } from "./budget.js";
import { CostTracker, calculateCost } from "./tracking.js";
import { PiiScanner } from "./pii.js";
import type { PiiResult } from "./pii.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import { createProviderForClient } from "./providers/index.js";
import { ConfigurationError } from "./errors.js";
import { SessionContext } from "./session.js";
import type { BudgetCheckResponse, BudgetStatusResponse } from "./models/budget.js";

// ─── Re-exports ──────────────────────────────────────────────────────

export { VERSION } from "./version.js";
export { ModelCostConfig } from "./config.js";
export type { ModelCostInitOptions, ModelCostResolvedConfig } from "./config.js";
export { ModelCostClient } from "./client.js";
export { BudgetManager } from "./budget.js";
export { CostTracker, calculateCost, MODEL_PRICING } from "./tracking.js";
export { PiiScanner } from "./pii.js";
export type { PiiResult, PiiEntity, GovernanceViolation, FullScanResult } from "./pii.js";
export { TokenBucketRateLimiter } from "./rate-limiter.js";

export {
  ModelCostError,
  ConfigurationError,
  BudgetExceededError,
  RateLimitedError,
  PiiDetectedError,
  ModelCostApiError,
  SessionBudgetExceededError,
  SessionIterationLimitExceededError,
} from "./errors.js";

export { SessionContext } from "./session.js";
export type { SessionOptions, SessionCallRecord } from "./session.js";

export type {
  BudgetAction,
  BudgetScope,
  BudgetPeriod,
  Provider,
  TrackRequest,
  TrackResponse,
  BudgetCheckResponse,
  BudgetPolicy,
  BudgetStatusResponse,
  GovernanceScanRequest,
  GovernanceScanResponse,
  DetectedViolation,
  ModelPricing,
  CreateSessionRequest,
  CreateSessionResponse,
  RecordSessionCallRequest,
  CloseSessionRequest,
} from "./models/index.js";

export type { BaseProvider, ExtractedUsage } from "./providers/base.js";
export { OpenAIProvider } from "./providers/openai.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { GoogleProvider } from "./providers/google.js";

// ─── Track cost decorator options ────────────────────────────────────

export interface TrackCostOptions {
  model: string;
  feature?: string;
  provider?: string;
  session?: SessionContext;
}

// ─── Usage report (returned by getUsage) ─────────────────────────────

export interface UsageReport {
  totalSpendUsd: number;
  totalBudgetUsd: number;
  policiesAtRisk: number;
  policies: BudgetStatusResponse["policies"];
}

// ─── Internal singleton state ────────────────────────────────────────

interface ModelCostInstance {
  config: ModelCostConfig;
  client: ModelCostClient;
  budgetManager: BudgetManager;
  costTracker: CostTracker;
  piiScanner: PiiScanner;
  rateLimiter: TokenBucketRateLimiter;
}

// ─── Main SDK class ──────────────────────────────────────────────────

/**
 * Main entry point for the ModelCost Node.js SDK.
 *
 * Uses a static singleton pattern -- call `ModelCost.init()` once,
 * then use the static methods from anywhere in your application.
 *
 * @example
 * ```ts
 * import { ModelCost } from "@modelcost/sdk";
 * import OpenAI from "openai";
 *
 * ModelCost.init({ apiKey: "mc_...", orgId: "org-123" });
 * const openai = ModelCost.wrap(new OpenAI());
 * ```
 */
export class ModelCost {
  private static _instance: ModelCostInstance | null = null;

  /** Prevent direct instantiation. */
  private constructor() {}

  /**
   * Initialize the ModelCost SDK. Must be called before any other method.
   * Subsequent calls will re-initialize (shutting down the previous instance).
   */
  static init(options: ModelCostInitOptions): void {
    if (ModelCost._instance) {
      // Gracefully shut down existing instance
      ModelCost._instance.costTracker.stopAutoFlush();
      ModelCost._instance.costTracker.stopPricingSync();
      ModelCost._instance.client.close();
    }

    const config = new ModelCostConfig(options);
    const client = new ModelCostClient(config);
    const budgetManager = new BudgetManager(config.syncIntervalMs);
    const costTracker = new CostTracker(config.flushBatchSize);
    const piiScanner = new PiiScanner();
    const rateLimiter = new TokenBucketRateLimiter(10, 50);

    // Start auto-flushing tracked events
    costTracker.startAutoFlush(client, config.flushIntervalMs);

    // Start periodic pricing sync from server
    costTracker.startPricingSync(config.baseUrl, config.apiKey);

    ModelCost._instance = {
      config,
      client,
      budgetManager,
      costTracker,
      piiScanner,
      rateLimiter,
    };
  }

  /**
   * Wrap an AI provider client with cost tracking, budget enforcement,
   * and PII scanning. Returns a proxied version of the same client.
   *
   * Supports: OpenAI, Anthropic, Google Generative AI.
   */
  static wrap<T>(client: T, session?: SessionContext): T {
    const inst = ModelCost._requireInstance();
    const provider = createProviderForClient(
      client,
      inst.client,
      inst.config,
      inst.budgetManager,
      inst.costTracker,
      inst.piiScanner,
      inst.rateLimiter,
      session,
    );
    return provider.wrap(client) as T;
  }

  /**
   * Decorator factory for tracking costs on individual functions.
   *
   * @example
   * ```ts
   * const trackedFn = ModelCost.trackCost({ model: "gpt-4o" })(myFunction);
   * ```
   */
  static trackCost(
    options: TrackCostOptions,
  ): <TFn extends (...args: unknown[]) => unknown>(fn: TFn) => TFn {
    const inst = ModelCost._requireInstance();

    return <TFn extends (...args: unknown[]) => unknown>(fn: TFn): TFn => {
      const wrapped = async (...args: unknown[]): Promise<unknown> => {
        // Session pre-check
        if (options.session) {
          const estimatedCost = calculateCost(options.model, 500, 500);
          options.session.preCallCheck(estimatedCost);
        }

        const startTime = Date.now();
        const result = await fn(...args);
        const latencyMs = Date.now() - startTime;

        // Record with zero tokens (caller is responsible for real usage)
        inst.costTracker.record(
          {
            apiKey: inst.config.apiKey,
            timestamp: new Date().toISOString(),
            provider: (options.provider ?? "openai") as "openai",
            model: options.model,
            feature: options.feature,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs,
            metadata: {},
          },
          inst.client,
        );

        // Session post-recording
        if (options.session) {
          options.session.recordCall({
            callType: "llm",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          });
        }

        return result;
      };

      return wrapped as unknown as TFn;
    };
  }

  /**
   * Check whether a request is allowed under current budget policies.
   */
  static async checkBudget(
    scope: string,
    id: string,
  ): Promise<BudgetCheckResponse> {
    const inst = ModelCost._requireInstance();
    return inst.budgetManager.check(inst.client, inst.config.orgId, `${scope}:${id}`, 0);
  }

  /**
   * Get usage/spend information for a scope and period.
   */
  static async getUsage(
    scope: string,
    _period: string,
  ): Promise<UsageReport> {
    const inst = ModelCost._requireInstance();
    const status = await inst.client.getBudgetStatus(
      scope === "organization" ? inst.config.orgId : scope,
    );
    return {
      totalSpendUsd: status.totalSpendUsd,
      totalBudgetUsd: status.totalBudgetUsd,
      policiesAtRisk: status.policiesAtRisk,
      policies: status.policies,
    };
  }

  /**
   * Start a new agent session with optional budget and iteration limits.
   * Registers the session with the server (fail-open if unavailable)
   * and returns a local SessionContext for tracking.
   */
  static async startSession(options: {
    feature?: string;
    maxSpendUsd?: number;
    maxIterations?: number;
    userId?: string;
    sessionId?: string;
  } = {}): Promise<SessionContext> {
    const inst = ModelCost._requireInstance();
    const sessionId = options.sessionId ?? crypto.randomUUID();

    let serverSessionId: string | undefined;
    try {
      const response = await inst.client.createSession({
        apiKey: inst.config.apiKey,
        sessionId,
        feature: options.feature,
        userId: options.userId,
        maxSpendUsd: options.maxSpendUsd,
        maxIterations: options.maxIterations,
      });
      serverSessionId = response.id;
    } catch {
      console.warn("[ModelCost] Failed to create server session (fail-open)");
    }

    return new SessionContext({
      sessionId,
      serverSessionId,
      feature: options.feature,
      userId: options.userId,
      maxSpendUsd: options.maxSpendUsd,
      maxIterations: options.maxIterations,
    });
  }

  /**
   * Close an active session, recording final state on the server.
   */
  static async closeSession(
    session: SessionContext,
    reason = "completed",
  ): Promise<void> {
    const inst = ModelCost._requireInstance();
    session.close(reason);

    if (session.serverSessionId) {
      try {
        await inst.client.closeSession(session.serverSessionId, {
          apiKey: inst.config.apiKey,
          status: session.status,
          terminationReason: session.terminationReason,
          finalSpendUsd: session.currentSpendUsd,
          finalIterationCount: session.iterationCount,
        });
      } catch {
        console.warn("[ModelCost] Failed to close server session (fail-open)");
      }
    }
  }

  /**
   * Scan text for PII using the local scanner.
   */
  static async scanPii(text: string): Promise<PiiResult> {
    const inst = ModelCost._requireInstance();
    return inst.piiScanner.scan(text);
  }

  /**
   * Flush all buffered tracking events to the API.
   */
  static async flush(): Promise<void> {
    const inst = ModelCost._requireInstance();
    await inst.costTracker.flush(inst.client);
  }

  /**
   * Gracefully shut down the SDK: flush remaining events, stop timers, close client.
   */
  static async shutdown(): Promise<void> {
    if (!ModelCost._instance) return;

    const inst = ModelCost._instance;
    inst.costTracker.stopAutoFlush();
    inst.costTracker.stopPricingSync();
    await inst.costTracker.flush(inst.client);
    inst.budgetManager.clear();
    inst.client.close();
    ModelCost._instance = null;
  }

  /**
   * Assert the SDK has been initialized and return the instance.
   */
  private static _requireInstance(): ModelCostInstance {
    if (!ModelCost._instance) {
      throw new ConfigurationError(
        "ModelCost SDK is not initialized. Call ModelCost.init() first.",
      );
    }
    return ModelCost._instance;
  }
}
