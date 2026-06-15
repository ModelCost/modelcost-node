import { z } from "zod";
import { Provider } from "./common.js";

/**
 * Schema for tracking an AI API call.
 * API uses snake_case; we transform to camelCase for SDK consumers.
 *
 * Closed egress shape: every field is safe telemetry or an opaque identifier ref.
 * There is intentionally no raw-content or free-form `metadata` field — that is the
 * architectural guarantee, proven by the egress invariant test. `.strict()` makes an
 * accidental extra key (e.g. `metadata`) a validation error rather than a silent leak.
 */
export const TrackRequestSchema = z
  .object({
    apiKey: z.string().min(1),
    timestamp: z.string().datetime(),
    provider: Provider,
    model: z.string().min(1),
    feature: z.string().optional(),
    // Opaque, customer-controlled ref (HMAC-pseudonymized if a secret is set).
    // Never a raw email/MRN/name — see ../identifiers.ts.
    customerId: z.string().optional(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheCreationTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    latencyMs: z.number().int().optional(),
  })
  .strict();

export type TrackRequest = z.infer<typeof TrackRequestSchema>;

/**
 * Converts a camelCase TrackRequest into the snake_case body the API expects.
 * Closed: only allowlisted keys are emitted.
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
  };
}

/** Schema for the track API response. */
export const TrackResponseSchema = z.object({
  status: z.literal("ok"),
  cost: z.number().optional(),
});

export type TrackResponse = z.infer<typeof TrackResponseSchema>;
