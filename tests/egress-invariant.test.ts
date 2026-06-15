import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { server } from "./setup.js";
import { ModelCostConfig } from "../src/config.js";
import { ModelCostClient } from "../src/client.js";
import { BudgetManager } from "../src/budget.js";
import { CostTracker } from "../src/tracking.js";
import { PiiScanner } from "../src/pii.js";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { PiiDetectedError } from "../src/errors.js";

const BASE_URL = "https://api.modelcost.ai";

// ── Allowlist (single source of truth, shared across SDKs) ──────────────────
const allowlist = JSON.parse(
  readFileSync(new URL("../egress-allowlist.json", import.meta.url), "utf8"),
) as {
  forbiddenKeys: string[];
  endpoints: Record<string, { allowedKeys: string[] }>;
};
const canon = (k: string) => k.toLowerCase().replace(/_/g, "");
const forbidden = new Set(allowlist.forbiddenKeys.map(canon));

function allowedKeysFor(path: string): Set<string> | null {
  const e = allowlist.endpoints;
  let key: string | undefined;
  if (path === "/api/v1/track") key = "POST /api/v1/track";
  else if (path === "/api/v1/governance/signals")
    key = "POST /api/v1/governance/signals";
  else if (path === "/api/v1/sessions") key = "POST /api/v1/sessions";
  else if (path.endsWith("/calls")) key = "POST /api/v1/sessions/{id}/calls";
  else if (path.endsWith("/close")) key = "POST /api/v1/sessions/{id}/close";
  if (!key) return null;
  return new Set(e[key]!.allowedKeys.map(canon));
}

function walkKeys(obj: unknown, out: Set<string>): void {
  if (Array.isArray(obj)) obj.forEach((v) => walkKeys(v, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      out.add(canon(k));
      walkKeys(v, out);
    }
  }
}

function assertPayloadSafe(path: string, body: unknown): void {
  expect(path).not.toContain("/governance/scan");
  const keys = new Set<string>();
  walkKeys(body, keys);
  for (const k of keys) {
    expect(forbidden.has(k), `forbidden key '${k}' at ${path}`).toBe(false);
  }
  const allowed = allowedKeysFor(path);
  expect(allowed, `non-allowlisted endpoint ${path}`).not.toBeNull();
  const top = Object.keys(body as Record<string, unknown>).map(canon);
  const extra = top.filter((k) => !allowed!.has(k));
  expect(extra, `non-allowlisted field(s) ${extra} at ${path}`).toEqual([]);
}

// ── Outbound capture ────────────────────────────────────────────────────────
interface Captured {
  path: string;
  raw: string;
}
let captured: Captured[];

function captureHandlers() {
  const cap = async ({ request }: { request: Request }) => {
    const raw = await request.text();
    captured.push({ path: new URL(request.url).pathname, raw });
    return new HttpResponse(JSON.stringify({ status: "ok" }), { status: 200 });
  };
  return [
    http.post(`${BASE_URL}/api/v1/track`, cap),
    http.post(`${BASE_URL}/api/v1/governance/signals`, cap),
  ];
}

function makeProvider() {
  const config = new ModelCostConfig({
    apiKey: "mc_test_key",
    orgId: "org-test",
    failOpen: true,
  });
  const client = new ModelCostClient(config);
  const tracker = new CostTracker(1000);
  const provider = new OpenAIProvider(
    client,
    config,
    new BudgetManager(10_000),
    tracker,
    new PiiScanner(),
    new TokenBucketRateLimiter(1000, 1000),
  );
  return { client, tracker, provider };
}

function fakeOpenAI() {
  return {
    chat: {
      completions: {
        create: async (..._args: unknown[]) => ({
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("egress invariant", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());
  beforeEach(() => {
    captured = [];
    server.resetHandlers();
    server.use(...captureHandlers()); // override track/signals; keep default handlers
  });

  // ── Model-level closure ──────────────────────────────────────────────────
  it("track schema rejects a metadata field", async () => {
    const { TrackRequestSchema } = await import("../src/models/track.js");
    const parsed = TrackRequestSchema.safeParse({
      apiKey: "mc_x",
      timestamp: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1,
      outputTokens: 1,
      metadata: { phi: "patient data" },
    });
    expect(parsed.success).toBe(false);
  });

  it("client has no scanText method", () => {
    const { client } = makeProvider();
    expect(
      (client as unknown as Record<string, unknown>)["scanText"],
    ).toBeUndefined();
    client.close();
  });

  // ── Transport-level: real outbound bytes ─────────────────────────────────
  it("blocks PHI and never transmits content", async () => {
    const { client, provider } = makeProvider();
    const wrapped = provider.wrap(fakeOpenAI()) as ReturnType<typeof fakeOpenAI>;
    const phi =
      "Patient SSN 123-45-6789 has diabetes; email jane.doe@hospital.org";

    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: phi }],
      } as never),
    ).rejects.toBeInstanceOf(PiiDetectedError);

    await tick(); // let fire-and-forget signals flush
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      assertPayloadSafe(c.path, JSON.parse(c.raw));
      expect(c.raw).not.toContain("123-45-6789");
      expect(c.raw).not.toContain("diabetes");
      expect(c.raw).not.toContain("jane.doe@hospital.org");
    }
    client.close();
  });

  it("clean call track payload is allowlisted", async () => {
    const { client, tracker, provider } = makeProvider();
    const wrapped = provider.wrap(fakeOpenAI()) as ReturnType<typeof fakeOpenAI>;

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    } as never);
    await tracker.flush(client);

    const trackCalls = captured.filter((c) => c.path === "/api/v1/track");
    expect(trackCalls.length).toBeGreaterThan(0);
    for (const c of trackCalls) assertPayloadSafe(c.path, JSON.parse(c.raw));
    client.close();
  });

  it("oversized prompt with buried PHI is not transmitted", async () => {
    const { client, provider } = makeProvider();
    const wrapped = provider.wrap(fakeOpenAI()) as ReturnType<typeof fakeOpenAI>;
    const phi = "filler ".repeat(2000) + " SSN 123-45-6789 " + "more ".repeat(2000);

    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: phi }],
      } as never),
    ).rejects.toBeInstanceOf(PiiDetectedError);

    await tick();
    for (const c of captured) {
      assertPayloadSafe(c.path, JSON.parse(c.raw));
      expect(c.raw).not.toContain("123-45-6789");
    }
    client.close();
  });

  it("obfuscated PHI missed by the scanner still carries no content", async () => {
    const { client, tracker, provider } = makeProvider();
    const wrapped = provider.wrap(fakeOpenAI()) as ReturnType<typeof fakeOpenAI>;
    const obfuscated = "SSN 1​2​3-4​5-6​7​8​9";

    // not blocked (scanner misses it) -> resolves, but outbound has no content
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: obfuscated }],
    } as never);
    await tracker.flush(client);

    for (const c of captured) {
      assertPayloadSafe(c.path, JSON.parse(c.raw));
      expect(c.raw).not.toContain("123-45-6789");
      expect(c.raw).not.toContain(obfuscated);
    }
    client.close();
  });
});
