import type { ModelCostClient } from "./client.js";
import type { TrackRequest } from "./models/track.js";
import type { ModelPricing } from "./models/cost.js";

// ---------------------------------------------------------------------------
// Pricing table — starts empty, populated from server API on init.
// ---------------------------------------------------------------------------

/** Mutable internal map; rewritten by syncPricingFromApi. */
const _modelPricing: Map<string, ModelPricing> = new Map();

/**
 * Known model pricing table (cost per 1,000 tokens in USD).
 * Starts empty, populated from server API on init.
 */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = _modelPricing;

/**
 * Fetch the latest pricing table from the server and update the local cache.
 * Called on SDK init and periodically by the background sync timer.
 */
export async function syncPricingFromApi(
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/pricing/models`;
    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey },
    });
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as {
      models?: Array<{
        model: string;
        provider: string;
        input_cost_per_1k: number;
        output_cost_per_1k: number;
        cache_creation_cost_per_1k?: number;
        cache_read_cost_per_1k?: number;
      }>;
    };
    const models = data.models ?? [];
    if (models.length === 0) {
      return;
    }
    _modelPricing.clear();
    for (const entry of models) {
      _modelPricing.set(entry.model, {
        provider: entry.provider,
        model: entry.model,
        inputCostPer1k: entry.input_cost_per_1k,
        outputCostPer1k: entry.output_cost_per_1k,
        cacheCreationCostPer1k: entry.cache_creation_cost_per_1k,
        cacheReadCostPer1k: entry.cache_read_cost_per_1k,
      });
    }
  } catch {
    // Silently fall back to local table
  }
}

/**
 * Calculate the cost of an AI call based on token counts and known pricing.
 * Returns 0 if the model is not found in the pricing table.
 *
 * When a cache-specific rate is undefined, the input rate is used as fallback.
 * When a cache-specific rate is explicitly 0, nothing is charged for those tokens.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) {
    return 0;
  }

  const inputCost = (inputTokens / 1000) * pricing.inputCostPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputCostPer1k;

  const cacheCreationRate =
    pricing.cacheCreationCostPer1k ?? pricing.inputCostPer1k;
  const cacheReadRate =
    pricing.cacheReadCostPer1k ?? pricing.inputCostPer1k;

  const cacheCreationCost = (cacheCreationTokens / 1000) * cacheCreationRate;
  const cacheReadCost = (cacheReadTokens / 1000) * cacheReadRate;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

/**
 * Buffers track requests and periodically flushes them to the API.
 */
export class CostTracker {
  private _buffer: TrackRequest[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _pricingSyncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _batchSize: number;

  constructor(batchSize: number) {
    this._batchSize = batchSize;
  }

  /**
   * Add a track request to the buffer.
   * Automatically flushes when buffer reaches batch size.
   */
  record(request: TrackRequest, client?: ModelCostClient): void {
    this._buffer.push(request);
    if (this._buffer.length >= this._batchSize && client) {
      void this.flush(client);
    }
  }

  /**
   * Flush all buffered track requests to the API.
   * Logs a warning when the server-returned cost differs from the local
   * calculation by more than 1%.
   */
  async flush(client: ModelCostClient): Promise<void> {
    if (this._buffer.length === 0) {
      return;
    }

    const batch = this._buffer.splice(0, this._buffer.length);

    const promises = batch.map((request) =>
      client
        .track(request)
        .then((response) => {
          if (response.cost != null) {
            const localCost = calculateCost(
              request.model,
              request.inputTokens,
              request.outputTokens,
              request.cacheCreationTokens ?? 0,
              request.cacheReadTokens ?? 0,
            );
            if (localCost > 0) {
              const pctDiff =
                Math.abs(response.cost - localCost) / localCost;
              if (pctDiff > 0.01) {
                console.warn(
                  `[ModelCost] Cost discrepancy for ${request.model}: ` +
                    `server=$${response.cost.toFixed(6)} ` +
                    `local=$${localCost.toFixed(6)} ` +
                    `(${(pctDiff * 100).toFixed(1)}% diff)`,
                );
              }
            }
          }
        })
        .catch((error: unknown) => {
          console.warn(
            `[ModelCost] Failed to track request: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }),
    );

    await Promise.allSettled(promises);
  }

  /**
   * Start automatic periodic flushing.
   */
  startAutoFlush(client: ModelCostClient, intervalMs: number): void {
    this.stopAutoFlush();
    this._flushTimer = setInterval(() => {
      void this.flush(client);
    }, intervalMs);

    // Ensure the timer doesn't prevent process exit
    if (this._flushTimer && typeof this._flushTimer === "object" && "unref" in this._flushTimer) {
      this._flushTimer.unref();
    }
  }

  /**
   * Stop automatic periodic flushing.
   */
  stopAutoFlush(): void {
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  private static readonly _PRICING_SYNC_INTERVAL_MS = 300_000; // 5 minutes

  /**
   * Start periodic pricing sync from the server.
   */
  startPricingSync(baseUrl: string, apiKey: string): void {
    this.stopPricingSync();
    this._pricingSyncTimer = setInterval(() => {
      void syncPricingFromApi(baseUrl, apiKey);
    }, CostTracker._PRICING_SYNC_INTERVAL_MS);

    if (this._pricingSyncTimer && typeof this._pricingSyncTimer === "object" && "unref" in this._pricingSyncTimer) {
      this._pricingSyncTimer.unref();
    }
  }

  /**
   * Stop periodic pricing sync.
   */
  stopPricingSync(): void {
    if (this._pricingSyncTimer !== null) {
      clearInterval(this._pricingSyncTimer);
      this._pricingSyncTimer = null;
    }
  }

  /**
   * Get the current number of buffered requests.
   */
  get bufferSize(): number {
    return this._buffer.length;
  }
}
