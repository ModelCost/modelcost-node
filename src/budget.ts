import type { ModelCostClient } from "./client.js";
import type {
  BudgetCheckResponse,
  BudgetStatusResponse,
} from "./models/budget.js";

/**
 * Manages budget state with local caching and periodic sync.
 * Keeps an in-memory cache of budget status to avoid hitting the API
 * on every call, while still staying in sync with the server.
 */
export class BudgetManager {
  private _cache: Map<string, BudgetStatusResponse> = new Map();
  private _lastSync: number = 0;
  private readonly _syncIntervalMs: number;

  constructor(syncIntervalMs: number) {
    this._syncIntervalMs = syncIntervalMs;
  }

  /**
   * Check whether a request with the given estimated cost is allowed.
   * Uses the local cache if fresh, otherwise syncs from the API first.
   */
  async check(
    client: ModelCostClient,
    orgId: string,
    feature: string,
    estimatedCost: number,
  ): Promise<BudgetCheckResponse> {
    if (this._isStale()) {
      await this.sync(client, orgId);
    }

    // Always defer to the server for the authoritative check
    return client.checkBudget(orgId, feature, estimatedCost);
  }

  /**
   * Sync the budget status from the server and populate the local cache.
   */
  async sync(client: ModelCostClient, orgId: string): Promise<void> {
    const status = await client.getBudgetStatus(orgId);
    this._cache.set(orgId, status);
    this._lastSync = Date.now();
  }

  /**
   * Optimistically update local spend after a tracked call,
   * so subsequent budget checks reflect the estimated spend
   * without waiting for the next server sync.
   */
  updateLocalSpend(orgId: string, _feature: string, cost: number): void {
    const cached = this._cache.get(orgId);
    if (!cached) {
      return;
    }

    // Update aggregate spend
    const updated: BudgetStatusResponse = {
      ...cached,
      totalSpendUsd: cached.totalSpendUsd + cost,
      policies: cached.policies.map((policy) => ({
        ...policy,
        currentSpendUsd: policy.currentSpendUsd + cost,
        spendPercentage:
          policy.budgetAmountUsd > 0
            ? ((policy.currentSpendUsd + cost) / policy.budgetAmountUsd) * 100
            : policy.spendPercentage,
      })),
    };

    this._cache.set(orgId, updated);
  }

  /**
   * Get the cached budget status for an org, if available.
   */
  getCached(orgId: string): BudgetStatusResponse | undefined {
    return this._cache.get(orgId);
  }

  /**
   * Clear all cached state.
   */
  clear(): void {
    this._cache.clear();
    this._lastSync = 0;
  }

  private _isStale(): boolean {
    return Date.now() - this._lastSync > this._syncIntervalMs;
  }
}
