import { z } from "zod";

/**
 * Schema for a governance scan request (camelCase -> snake_case for API).
 */
export const GovernanceScanRequestSchema = z.object({
  orgId: z.string().min(1),
  text: z.string().min(1),
  feature: z.string().optional(),
  environment: z.string().optional(),
});

export type GovernanceScanRequest = z.infer<typeof GovernanceScanRequestSchema>;

/**
 * Converts a camelCase GovernanceScanRequest to the snake_case body the API expects.
 */
export function governanceScanRequestToApi(
  request: GovernanceScanRequest,
): Record<string, unknown> {
  return {
    org_id: request.orgId,
    text: request.text,
    feature: request.feature ?? null,
    environment: request.environment ?? null,
  };
}

/**
 * Schema for a detected violation (snake_case from API -> camelCase).
 */
export const DetectedViolationSchema = z.object({
  type: z.string(),
  subtype: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  start: z.number().int(),
  end: z.number().int(),
});

export type DetectedViolation = z.infer<typeof DetectedViolationSchema>;

/**
 * Schema for the governance scan API response (snake_case from API -> camelCase).
 */
export const GovernanceScanResponseSchema = z
  .object({
    is_allowed: z.boolean(),
    action: z.string().nullable(),
    violations: z.array(DetectedViolationSchema),
    redacted_text: z.string().nullable(),
  })
  .transform((data) => ({
    isAllowed: data.is_allowed,
    action: data.action,
    violations: data.violations,
    redactedText: data.redacted_text,
  }));

export type GovernanceScanResponse = z.output<
  typeof GovernanceScanResponseSchema
>;

/**
 * Request to report a governance signal in metadata-only mode.
 * No raw content is included — only classification signals.
 */
export interface GovernanceSignalRequest {
  organizationId: string;
  violationType: string;
  violationSubtype?: string;
  severity: string;
  userId?: string;
  feature?: string;
  environment?: string;
  actionTaken: string;
  wasAllowed: boolean;
  detectedAt?: string;
  source: string;
  violationCount?: number;
}

/**
 * Converts a GovernanceSignalRequest to the snake_case body the API expects.
 */
export function governanceSignalRequestToApi(
  request: GovernanceSignalRequest,
): Record<string, unknown> {
  return {
    organization_id: request.organizationId,
    violation_type: request.violationType,
    violation_subtype: request.violationSubtype ?? null,
    severity: request.severity,
    user_id: request.userId ?? null,
    feature: request.feature ?? null,
    environment: request.environment ?? null,
    action_taken: request.actionTaken,
    was_allowed: request.wasAllowed,
    detected_at: request.detectedAt ?? null,
    source: request.source,
    violation_count: request.violationCount ?? 1,
  };
}
