# @modelcost/sdk

Node.js SDK for ModelCost -- AI cost protection, budget enforcement, and PII detection.

## Installation

```bash
npm install @modelcost/sdk
```

## Quick Start

```typescript
import { ModelCost } from "@modelcost/sdk";
import OpenAI from "openai";

// Initialize
ModelCost.init({
  apiKey: "mc_your_api_key_here",
  orgId: "your-org-id",
  monthlyBudget: 500,
  budgetAction: "block",
});

// Wrap your AI client
const openai = ModelCost.wrap(new OpenAI());

// All calls are now tracked and budget-enforced
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});

// Check budget status
const budget = await ModelCost.checkBudget("organization", "your-org-id");
console.log(`Allowed: ${budget.allowed}`);

// Scan for PII
const pii = await ModelCost.scanPii("My SSN is 123-45-6789");
console.log(`PII detected: ${pii.detected}`);

// Shutdown gracefully
await ModelCost.shutdown();
```

## Environment Variables

| Variable | Description |
|---|---|
| `MODELCOST_API_KEY` | API key (mc_ prefix) |
| `MODELCOST_ORG_ID` | Organization ID |
| `MODELCOST_ENV` | Environment (default: production) |
| `MODELCOST_BASE_URL` | API base URL |

## License

MIT
