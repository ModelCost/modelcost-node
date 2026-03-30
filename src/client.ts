import { VERSION } from "./version.js";
import type { ModelCostConfig } from "./config.js";
import { ModelCostApiError, ModelCostError } from "./errors.js";
import {
  type TrackRequest,
  type TrackResponse,
  TrackResponseSchema,
  trackRequestToApi,
} from "./models/track.js";
import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  createSessionRequestToApi,
  type RecordSessionCallRequest,
  recordSessionCallRequestToApi,
  type CloseSessionRequest,
  closeSessionRequestToApi,
} from "./models/session.js";
import {
  type BudgetCheckResponse,
  BudgetCheckResponseSchema,
  type BudgetStatusResponse,
  BudgetStatusResponseSchema,
} from "./models/budget.js";
import {
  type GovernanceScanRequest,
  type GovernanceScanResponse,
  GovernanceScanResponseSchema,
  governanceScanRequestToApi,
  type GovernanceSignalRequest,
  governanceSignalRequestToApi,
} from "./models/governance.js";

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

/**
 * Low-level HTTP client for the ModelCost API.
 * Uses native fetch, implements circuit breaker, and supports fail-open semantics.
 */
export class ModelCostClient {
  private readonly _baseUrl: string;
  private readonly _apiKey: string;
  private readonly _headers: Record<string, string>;
  private readonly _failOpen: boolean;

  /** Circuit breaker state */
  private _consecutiveFailures = 0;
  private _circuitOpenUntil = 0;

  constructor(config: ModelCostConfig) {
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._apiKey = config.apiKey;
    this._failOpen = config.failOpen;
    this._headers = {
      "Content-Type": "application/json",
      "X-API-Key": this._apiKey,
      "User-Agent": `modelcost-node/${VERSION}`,
    };
  }

  /**
   * Record a tracked AI API call.
   */
  async track(request: TrackRequest): Promise<TrackResponse> {
    const body = trackRequestToApi(request);
    const data = await this._post("/api/v1/track", body);
    return TrackResponseSchema.parse(data);
  }

  /**
   * Pre-flight budget check before making an AI call.
   */
  async checkBudget(
    orgId: string,
    feature: string,
    estimatedCost: number,
  ): Promise<BudgetCheckResponse> {
    const params = new URLSearchParams({
      org_id: orgId,
      feature,
      estimated_cost: estimatedCost.toString(),
    });
    const data = await this._post(`/api/v1/budgets/check?${params.toString()}`, {});
    return BudgetCheckResponseSchema.parse(data);
  }

  /**
   * Scan text for PII and governance violations.
   */
  async scanText(
    request: GovernanceScanRequest,
  ): Promise<GovernanceScanResponse> {
    const body = governanceScanRequestToApi(request);
    const data = await this._post("/api/v1/governance/scan", body);
    return GovernanceScanResponseSchema.parse(data);
  }

  /**
   * Report a governance signal (metadata-only mode).
   * Sends classification signals without raw content.
   */
  async reportSignal(request: GovernanceSignalRequest): Promise<void> {
    const body = governanceSignalRequestToApi(request);
    await this._post("/api/v1/governance/signals", body);
  }

  /**
   * Get current budget status for an organization.
   */
  async getBudgetStatus(orgId: string): Promise<BudgetStatusResponse> {
    const params = new URLSearchParams({ org_id: orgId });
    const data = await this._get(`/api/v1/budgets/status?${params.toString()}`);
    return BudgetStatusResponseSchema.parse(data);
  }

  /**
   * Create a new agent session on the server.
   */
  async createSession(
    request: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    const body = createSessionRequestToApi(request);
    const data = await this._post("/api/v1/sessions", body);
    return CreateSessionResponseSchema.parse(data);
  }

  /**
   * Record a call within an existing session.
   */
  async recordSessionCall(
    sessionId: string,
    request: RecordSessionCallRequest,
  ): Promise<void> {
    const body = recordSessionCallRequestToApi(request);
    await this._post(`/api/v1/sessions/${sessionId}/calls`, body);
  }

  /**
   * Close an existing session on the server.
   */
  async closeSession(
    sessionId: string,
    request: CloseSessionRequest,
  ): Promise<void> {
    const body = closeSessionRequestToApi(request);
    await this._post(`/api/v1/sessions/${sessionId}/close`, body);
  }

  /**
   * Close the client (cleanup resources).
   */
  close(): void {
    this._consecutiveFailures = 0;
    this._circuitOpenUntil = 0;
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private _isCircuitOpen(): boolean {
    if (this._consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) {
      return false;
    }
    if (Date.now() >= this._circuitOpenUntil) {
      // Cooldown has elapsed; allow a probe request
      this._consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private _recordSuccess(): void {
    this._consecutiveFailures = 0;
  }

  private _recordFailure(): void {
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this._circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    }
  }

  private async _post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this._request("POST", path, body);
  }

  private async _get(path: string): Promise<unknown> {
    return this._request("GET", path);
  }

  private async _request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this._isCircuitOpen()) {
      if (this._failOpen) {
        console.warn(
          `[ModelCost] Circuit breaker open — skipping ${method} ${path}`,
        );
        return this._failOpenDefault(path);
      }
      throw new ModelCostError(
        `Circuit breaker is open after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
      );
    }

    try {
      const url = `${this._baseUrl}${path}`;
      const init: RequestInit = {
        method,
        headers: this._headers,
      };
      if (body !== undefined && method !== "GET") {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({
          error: "unknown",
          message: response.statusText,
        }))) as { error?: string; message?: string };
        if (response.status >= 500) {
          this._recordFailure();
        }

        const err = new ModelCostApiError(
          errorBody.message ?? `HTTP ${response.status}`,
          response.status,
          errorBody.error ?? "unknown",
        );

        if (this._failOpen) {
          console.warn(
            `[ModelCost] API error (fail-open): ${err.message}`,
          );
          return this._failOpenDefault(path);
        }
        throw err;
      }

      const text = await response.text();
      const data: unknown = text.length > 0 ? JSON.parse(text) : {};
      this._recordSuccess();
      return data;
    } catch (error) {
      if (error instanceof ModelCostApiError) {
        throw error;
      }

      this._recordFailure();

      if (this._failOpen) {
        console.warn(
          `[ModelCost] Request failed (fail-open): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return this._failOpenDefault(path);
      }

      throw new ModelCostError(
        `Request to ${path} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Returns a safe default response when operating in fail-open mode.
   */
  private _failOpenDefault(path: string): unknown {
    if (path.includes("/budgets/check")) {
      return {
        allowed: true,
        action: null,
        throttle_percentage: null,
        reason: "fail-open: API unavailable",
      };
    }
    if (path.includes("/budgets/status")) {
      return {
        policies: [],
        total_budget_usd: 0,
        total_spend_usd: 0,
        policies_at_risk: 0,
      };
    }
    if (path.includes("/governance/scan")) {
      return {
        is_allowed: true,
        action: null,
        violations: [],
        redacted_text: null,
      };
    }
    if (path.includes("/sessions")) {
      return { id: "fail-open", session_id: "fail-open", status: "active" };
    }
    // Default for /track
    return { status: "ok" };
  }
}
