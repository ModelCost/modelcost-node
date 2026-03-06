import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const BASE_URL = "https://api.modelcost.ai";

/**
 * Default MSW handlers for all ModelCost API endpoints.
 * These return successful responses by default; individual tests
 * can override them with `server.use(...)`.
 */
export const handlers = [
  // POST /api/v1/track
  http.post(`${BASE_URL}/api/v1/track`, () => {
    return HttpResponse.json({ status: "ok" });
  }),

  // POST /api/v1/budgets/check
  http.post(`${BASE_URL}/api/v1/budgets/check`, ({ request }) => {
    const url = new URL(request.url);
    const estimatedCost = parseFloat(url.searchParams.get("estimated_cost") ?? "0");

    // Simulate blocking when estimated cost exceeds 100
    if (estimatedCost > 100) {
      return HttpResponse.json({
        allowed: false,
        action: "block",
        throttle_percentage: null,
        reason: "Budget limit exceeded",
      });
    }

    return HttpResponse.json({
      allowed: true,
      action: null,
      throttle_percentage: null,
      reason: null,
    });
  }),

  // GET /api/v1/budgets/status
  http.get(`${BASE_URL}/api/v1/budgets/status`, () => {
    return HttpResponse.json({
      policies: [
        {
          id: "pol_001",
          name: "Monthly Org Budget",
          scope: "organization",
          scope_identifier: null,
          budget_amount_usd: 500,
          period: "monthly",
          custom_period_days: null,
          action: "alert",
          throttle_percentage: null,
          alert_thresholds: [50, 80, 90],
          current_spend_usd: 123.45,
          spend_percentage: 24.69,
          period_start: "2026-02-01T00:00:00Z",
          is_active: true,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-15T10:30:00Z",
        },
      ],
      total_budget_usd: 500,
      total_spend_usd: 123.45,
      policies_at_risk: 0,
    });
  }),

  // POST /api/v1/governance/scan
  http.post(`${BASE_URL}/api/v1/governance/scan`, async ({ request }) => {
    const body = (await request.json()) as { text?: string };
    const text = body.text ?? "";

    // Simple SSN detection for test purposes
    const ssnMatch = text.match(/\d{3}-\d{2}-\d{4}/);
    if (ssnMatch) {
      return HttpResponse.json({
        is_allowed: false,
        action: "block",
        violations: [
          {
            type: "pii",
            subtype: "ssn",
            severity: "high",
            start: ssnMatch.index ?? 0,
            end: (ssnMatch.index ?? 0) + ssnMatch[0].length,
          },
        ],
        redacted_text: text.replace(/\d{3}-\d{2}-\d{4}/, "[SSN]"),
      });
    }

    return HttpResponse.json({
      is_allowed: true,
      action: null,
      violations: [],
      redacted_text: null,
    });
  }),
];

/**
 * Shared MSW test server instance.
 */
export const server = setupServer(...handlers);
