import { z } from "zod";
import { BudgetAction, BudgetPeriod, BudgetScope } from "./common.js";

/**
 * Schema for budget check API response (snake_case from API -> camelCase).
 */
export const BudgetCheckResponseSchema = z
  .object({
    allowed: z.boolean(),
    action: z.string().nullable(),
    throttle_percentage: z.number().nullable(),
    reason: z.string().nullable(),
  })
  .transform((data) => ({
    allowed: data.allowed,
    action: data.action,
    throttlePercentage: data.throttle_percentage,
    reason: data.reason,
  }));

export type BudgetCheckResponse = z.output<typeof BudgetCheckResponseSchema>;

/**
 * Schema for a single budget policy (snake_case from API -> camelCase).
 */
export const BudgetPolicySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scope: BudgetScope,
    scope_identifier: z.string().nullable(),
    budget_amount_usd: z.number(),
    period: BudgetPeriod,
    custom_period_days: z.number().int().nullable(),
    action: BudgetAction,
    throttle_percentage: z.number().nullable(),
    alert_thresholds: z.array(z.number().int()).nullable(),
    current_spend_usd: z.number(),
    spend_percentage: z.number(),
    period_start: z.string(),
    is_active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform((data) => ({
    id: data.id,
    name: data.name,
    scope: data.scope,
    scopeIdentifier: data.scope_identifier,
    budgetAmountUsd: data.budget_amount_usd,
    period: data.period,
    customPeriodDays: data.custom_period_days,
    action: data.action,
    throttlePercentage: data.throttle_percentage,
    alertThresholds: data.alert_thresholds,
    currentSpendUsd: data.current_spend_usd,
    spendPercentage: data.spend_percentage,
    periodStart: data.period_start,
    isActive: data.is_active,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }));

export type BudgetPolicy = z.output<typeof BudgetPolicySchema>;

/**
 * Schema for the budget status API response (snake_case from API -> camelCase).
 */
export const BudgetStatusResponseSchema = z
  .object({
    policies: z.array(BudgetPolicySchema),
    total_budget_usd: z.number(),
    total_spend_usd: z.number(),
    policies_at_risk: z.number().int(),
  })
  .transform((data) => ({
    policies: data.policies,
    totalBudgetUsd: data.total_budget_usd,
    totalSpendUsd: data.total_spend_usd,
    policiesAtRisk: data.policies_at_risk,
  }));

export type BudgetStatusResponse = z.output<typeof BudgetStatusResponseSchema>;
