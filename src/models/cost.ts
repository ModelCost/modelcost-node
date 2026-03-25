import { z } from "zod";

/**
 * Schema describing the pricing for a single model.
 */
export const ModelPricingSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputCostPer1k: z.number().nonnegative(),
  outputCostPer1k: z.number().nonnegative(),
  cacheCreationCostPer1k: z.number().nonnegative().optional(),
  cacheReadCostPer1k: z.number().nonnegative().optional(),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;
