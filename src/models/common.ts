import { z } from "zod";

/** Actions that can be taken when a budget threshold is reached. */
export const BudgetAction = z.enum(["alert", "throttle", "block"]);
export type BudgetAction = z.infer<typeof BudgetAction>;

/** Scope levels for budget policies. */
export const BudgetScope = z.enum([
  "organization",
  "feature",
  "environment",
  "custom",
]);
export type BudgetScope = z.infer<typeof BudgetScope>;

/** Time periods for budget policies. */
export const BudgetPeriod = z.enum(["daily", "weekly", "monthly", "custom"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

/** Supported AI providers. */
export const Provider = z.enum([
  "openai",
  "anthropic",
  "google",
  "aws_bedrock",
  "cohere",
  "mistral",
]);
export type Provider = z.infer<typeof Provider>;
