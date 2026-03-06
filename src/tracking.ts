import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCostClient } from "./client.js";
import type { TrackRequest } from "./models/track.js";
import type { ModelPricing } from "./models/cost.js";

// ---------------------------------------------------------------------------
// Pricing table — loaded from sdk/common/model_pricing.json at import time,
// refreshed at runtime via GET /api/v1/pricing/models.
// ---------------------------------------------------------------------------

const _PRICING_JSON_PATHS: string[] = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
      resolve(here, "..", "..", "..", "common", "model_pricing.json"), // sdk/node/src -> sdk/common
      resolve(here, "..", "..", "..", "..", "sdk", "common", "model_pricing.json"), // alternative layout
    ];
  } catch {
    return [];
  }
})();

function _loadBundledPricing(): Map<string, ModelPricing> {
  for (const filePath of _PRICING_JSON_PATHS) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as {
        models?: Record<string, { provider: string; input_cost_per_1k: number; output_cost_per_1k: number }>;
      };
      const models = data.models ?? {};
      const result = new Map<string, ModelPricing>();
      for (const [name, info] of Object.entries(models)) {
        result.set(name, {
          provider: info.provider,
          model: name,
          inputCostPer1k: info.input_cost_per_1k,
          outputCostPer1k: info.output_cost_per_1k,
        });
      }
      if (result.size > 0) {
        return result;
      }
    } catch {
      // Try next path
    }
  }
  return _hardcodedFallback();
}

function _hardcodedFallback(): Map<string, ModelPricing> {
  return new Map<string, ModelPricing>([
    ["gpt-4", { provider: "openai", model: "gpt-4", inputCostPer1k: 0.03, outputCostPer1k: 0.06 }],
    ["gpt-4-turbo", { provider: "openai", model: "gpt-4-turbo", inputCostPer1k: 0.01, outputCostPer1k: 0.03 }],
    ["gpt-4o", { provider: "openai", model: "gpt-4o", inputCostPer1k: 0.005, outputCostPer1k: 0.015 }],
    ["gpt-4o-mini", { provider: "openai", model: "gpt-4o-mini", inputCostPer1k: 0.00015, outputCostPer1k: 0.0006 }],
    ["gpt-3.5-turbo", { provider: "openai", model: "gpt-3.5-turbo", inputCostPer1k: 0.0015, outputCostPer1k: 0.002 }],
    ["claude-opus-4", { provider: "anthropic", model: "claude-opus-4", inputCostPer1k: 0.015, outputCostPer1k: 0.075 }],
    ["claude-sonnet-4", { provider: "anthropic", model: "claude-sonnet-4", inputCostPer1k: 0.003, outputCostPer1k: 0.015 }],
    ["claude-haiku-4", { provider: "anthropic", model: "claude-haiku-4", inputCostPer1k: 0.00025, outputCostPer1k: 0.00125 }],
    ["gemini-1.5-pro", { provider: "google", model: "gemini-1.5-pro", inputCostPer1k: 0.00125, outputCostPer1k: 0.005 }],
    ["gemini-1.5-flash", { provider: "google", model: "gemini-1.5-flash", inputCostPer1k: 0.000075, outputCostPer1k: 0.0003 }],
    ["gemini-2.0-flash", { provider: "google", model: "gemini-2.0-flash", inputCostPer1k: 0.0001, outputCostPer1k: 0.0004 }],
  ]);
}

/** Mutable internal map; rewritten by syncPricingFromApi. */
const _modelPricing: Map<string, ModelPricing> = _loadBundledPricing();

/**
 * Known model pricing table (cost per 1,000 tokens in USD).
 * Loaded from sdk/common/model_pricing.json at import time,
 * refreshed at runtime via syncPricingFromApi().
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
      });
    }
  } catch {
    // Silently fall back to local table
  }
}

/**
 * Calculate the cost of an AI call based on token counts and known pricing.
 * Returns 0 if the model is not found in the pricing table.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) {
    return 0;
  }

  const inputCost = (inputTokens / 1000) * pricing.inputCostPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputCostPer1k;
  return inputCost + outputCost;
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
   */
  async flush(client: ModelCostClient): Promise<void> {
    if (this._buffer.length === 0) {
      return;
    }

    const batch = this._buffer.splice(0, this._buffer.length);

    const promises = batch.map((request) =>
      client.track(request).catch((error: unknown) => {
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
