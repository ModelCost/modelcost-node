import type { ModelCostClient } from "./client.js";
import type { ModelCostConfig } from "./config.js";
import type { PiiScanner } from "./pii.js";
import { PiiDetectedError } from "./errors.js";

/**
 * Local-only governance enforcement shared by all provider wrappers.
 *
 * Content is scanned entirely in-process; raw text is never transmitted. When
 * violations are found we (1) emit de-identified, aggregated signals and (2) block
 * the call by throwing {@link PiiDetectedError}. There is deliberately no server-side
 * content scan — that capability was removed so prompt/response content cannot leave
 * the customer environment by any path.
 */
export function enforceLocalGovernance(
  text: string,
  deps: {
    client: ModelCostClient;
    config: ModelCostConfig;
    piiScanner: PiiScanner;
  },
): void {
  const { client, config, piiScanner } = deps;
  const full = piiScanner.fullScan(text);
  if (!full.detected) return;

  // Aggregate by (category, type, severity): one signal per distinct violation
  // kind instead of one network call per hit (no N+1).
  const groups = new Map<
    string,
    { category: string; type: string; severity: string; count: number }
  >();
  for (const v of full.violations) {
    const key = `${v.category}|${v.type}|${v.severity}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { category: v.category, type: v.type, severity: v.severity, count: 1 });
  }

  const detectedAt = new Date().toISOString();
  for (const g of groups.values()) {
    client
      .reportSignal({
        organizationId: config.orgId,
        violationType: g.category,
        violationSubtype: g.type,
        severity: g.severity,
        environment: config.environment,
        actionTaken: "block",
        wasAllowed: false,
        detectedAt,
        source: "metadata_only",
        violationCount: g.count,
      })
      .catch(() => {}); // fire-and-forget
  }

  throw new PiiDetectedError(
    "Sensitive content detected and blocked locally (content never transmitted)",
    full.violations.map((v) => ({
      type: v.category,
      subtype: v.type,
      severity: v.severity as "low" | "medium" | "high",
      start: v.start,
      end: v.end,
    })),
    piiScanner.redact(text),
  );
}
