import { z } from "zod";
import { BudgetAction } from "./models/common.js";

/**
 * Zod schema for ModelCost initialization options.
 * Validates all configuration fields and applies defaults.
 */
export const ModelCostInitOptionsSchema = z.object({
  apiKey: z
    .string()
    .startsWith("mc_", { message: "API key must start with 'mc_'" })
    .describe("ModelCost API key"),
  orgId: z.string().min(1, { message: "Organization ID is required" }),
  environment: z.string().default("production"),
  baseUrl: z.string().url().default("https://api.modelcost.ai"),
  monthlyBudget: z.number().positive().optional(),
  budgetAction: BudgetAction.default("alert"),
  failOpen: z.boolean().default(true),
  flushIntervalMs: z.number().int().positive().default(5000),
  flushBatchSize: z.number().int().positive().default(100),
  syncIntervalMs: z.number().int().positive().default(10000),
  contentPrivacy: z.boolean().default(false),
});

export type ModelCostInitOptions = z.input<typeof ModelCostInitOptionsSchema>;

/**
 * Resolved configuration after validation and env-var fallback.
 */
export type ModelCostResolvedConfig = z.output<typeof ModelCostInitOptionsSchema>;

/**
 * Configuration manager that validates init options and reads
 * environment variables as fallbacks.
 */
export class ModelCostConfig {
  public readonly apiKey: string;
  public readonly orgId: string;
  public readonly environment: string;
  public readonly baseUrl: string;
  public readonly monthlyBudget: number | undefined;
  public readonly budgetAction: z.infer<typeof BudgetAction>;
  public readonly failOpen: boolean;
  public readonly flushIntervalMs: number;
  public readonly flushBatchSize: number;
  public readonly syncIntervalMs: number;
  public readonly contentPrivacy: boolean;

  constructor(options: ModelCostInitOptions) {
    const merged = {
      apiKey: options.apiKey ?? process.env["MODELCOST_API_KEY"],
      orgId: options.orgId ?? process.env["MODELCOST_ORG_ID"],
      environment:
        options.environment ?? process.env["MODELCOST_ENV"] ?? "production",
      baseUrl:
        options.baseUrl ??
        process.env["MODELCOST_BASE_URL"] ??
        "https://api.modelcost.ai",
      monthlyBudget: options.monthlyBudget,
      budgetAction: options.budgetAction ?? "alert",
      failOpen: options.failOpen ?? true,
      flushIntervalMs: options.flushIntervalMs ?? 5000,
      flushBatchSize: options.flushBatchSize ?? 100,
      syncIntervalMs: options.syncIntervalMs ?? 10000,
      contentPrivacy:
        options.contentPrivacy ??
        process.env["MODELCOST_CONTENT_PRIVACY"] === "true" ??
        false,
    };

    const parsed = ModelCostInitOptionsSchema.parse(merged);

    this.apiKey = parsed.apiKey;
    this.orgId = parsed.orgId;
    this.environment = parsed.environment;
    this.baseUrl = parsed.baseUrl;
    this.monthlyBudget = parsed.monthlyBudget;
    this.budgetAction = parsed.budgetAction;
    this.failOpen = parsed.failOpen;
    this.flushIntervalMs = parsed.flushIntervalMs;
    this.flushBatchSize = parsed.flushBatchSize;
    this.syncIntervalMs = parsed.syncIntervalMs;
    this.contentPrivacy = parsed.contentPrivacy;
  }
}
