import { z } from "zod";

// ─── Request types ────────────────────────────────────────────────────

export interface CreateSessionRequest {
  apiKey: string;
  sessionId: string;
  feature?: string;
  userId?: string;
  maxSpendUsd?: number;
  maxIterations?: number;
}

export interface RecordSessionCallRequest {
  apiKey: string;
  callSequence: number;
  callType: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cumulativeInputTokens: number;
  costUsd: number;
  cumulativeCostUsd: number;
  piiDetected: boolean;
}

export interface CloseSessionRequest {
  apiKey: string;
  status: string;
  terminationReason?: string;
  finalSpendUsd: number;
  finalIterationCount: number;
}

// ─── Response types ───────────────────────────────────────────────────

export interface CreateSessionResponse {
  id: string;
  sessionId: string;
  status: string;
  maxSpendUsd?: number;
  maxIterations?: number;
}

/** Schema for the create-session API response (snake_case -> camelCase). */
export const CreateSessionResponseSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    status: z.string(),
    max_spend_usd: z.number().nullable().optional(),
    max_iterations: z.number().nullable().optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    sessionId: raw.session_id,
    status: raw.status,
    maxSpendUsd: raw.max_spend_usd ?? undefined,
    maxIterations: raw.max_iterations ?? undefined,
  }));

// ─── Conversion functions (camelCase -> snake_case for API) ───────────

export function createSessionRequestToApi(
  req: CreateSessionRequest,
): Record<string, unknown> {
  return {
    api_key: req.apiKey,
    session_id: req.sessionId,
    feature: req.feature,
    user_id: req.userId,
    max_spend_usd: req.maxSpendUsd,
    max_iterations: req.maxIterations,
  };
}

export function recordSessionCallRequestToApi(
  req: RecordSessionCallRequest,
): Record<string, unknown> {
  return {
    api_key: req.apiKey,
    call_sequence: req.callSequence,
    call_type: req.callType,
    tool_name: req.toolName,
    input_tokens: req.inputTokens,
    output_tokens: req.outputTokens,
    cumulative_input_tokens: req.cumulativeInputTokens,
    cost_usd: req.costUsd,
    cumulative_cost_usd: req.cumulativeCostUsd,
    pii_detected: req.piiDetected,
  };
}

export function closeSessionRequestToApi(
  req: CloseSessionRequest,
): Record<string, unknown> {
  return {
    api_key: req.apiKey,
    status: req.status,
    termination_reason: req.terminationReason,
    final_spend_usd: req.finalSpendUsd,
    final_iteration_count: req.finalIterationCount,
  };
}
