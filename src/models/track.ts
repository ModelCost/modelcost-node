import { z } from "zod";
import { Provider } from "./common.js";

/**
 * Schema for tracking an AI API call.
 * API uses snake_case; we transform to camelCase for SDK consumers.
 */
export const TrackRequestSchema = z.object({
  apiKey: z.string().min(1),
  timestamp: z.string().datetime(),
  provider: Provider,
  model: z.string().min(1),
  feature: z.string().optional(),
  customerId: z.string().optional(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheCreationTokens: z.number().int().min(0).optional(),
  cacheReadTokens: z.number().int().min(0).optional(),
  latencyMs: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type TrackRequest = z.infer<typeof TrackRequestSchema>;

/**
 * Converts a camelCase TrackRequest into the snake_case body the API expects.
 */
export function trackRequestToApi(request: TrackRequest): Record<string, unknown> {
  return {
    api_key: request.apiKey,
    timestamp: request.timestamp,
    provider: request.provider,
    model: request.model,
    feature: request.feature ?? null,
    customer_id: request.customerId ?? null,
    input_tokens: request.inputTokens,
    output_tokens: request.outputTokens,
    cache_creation_tokens: request.cacheCreationTokens ?? null,
    cache_read_tokens: request.cacheReadTokens ?? null,
    latency_ms: request.latencyMs ?? null,
    metadata: request.metadata ?? null,
  };
}

/** Schema for the track API response. */
export const TrackResponseSchema = z.object({
  status: z.literal("ok"),
});

export type TrackResponse = z.infer<typeof TrackResponseSchema>;
