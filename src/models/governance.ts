import { z } from "zod";

// NOTE: there is intentionally NO scan request/response carrying raw text. Governance
// is enforced entirely client-side (see ../governance.ts); only de-identified metadata
// signals are ever transmitted. See egress-allowlist.json for the egress contract.

/**
 * Schema for a detected violation (used by errors / local results).
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
 * Request to report a governance signal in metadata-only mode.
 * No raw content or identifiers are included — only classification signals.
 */
export interface GovernanceSignalRequest {
  organizationId: string;
  violationType: string;
  violationSubtype?: string;
  severity: string;
  environment?: string;
  actionTaken: string;
  wasAllowed: boolean;
  detectedAt?: string;
  source: string;
  violationCount?: number;
}

/**
 * Converts a GovernanceSignalRequest to the snake_case body the API expects.
 * Closed: only allowlisted, de-identified fields are emitted.
 */
export function governanceSignalRequestToApi(
  request: GovernanceSignalRequest,
): Record<string, unknown> {
  return {
    organization_id: request.organizationId,
    violation_type: request.violationType,
    violation_subtype: request.violationSubtype ?? null,
    severity: request.severity,
    environment: request.environment ?? null,
    action_taken: request.actionTaken,
    was_allowed: request.wasAllowed,
    detected_at: request.detectedAt ?? null,
    source: request.source,
    violation_count: request.violationCount ?? 1,
  };
}
