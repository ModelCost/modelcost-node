# ModelCost SDK — PHI/PII Egress Hardening

**Status:** enforced as of the 0.4.0/0.5.0 SDK line (Python 0.4.0, Java 0.4.0, Node 0.5.0).
**Audience:** security reviewers, SOC 2 auditors, and BAA counterparties.

This document describes how the ModelCost SDKs make it **architecturally impossible** for
prompt/response content and direct/quasi identifiers to reach ModelCost's servers — not by
defaulting a flag, but by removing the capability and proving its absence with tests and CI.

---

## 1. One-page summary (what a reviewer needs to know)

- **No model content ever leaves the customer environment.** The SDK does not have a code
  path, field, or config flag that transmits prompts, completions, system prompts, tool
  args/results, embeddings, or attachments. The previous server-side content-scan endpoint
  (`POST /api/v1/governance/scan`) and its client method were **deleted**, not disabled.
- **Governance runs locally.** PII/PHI detection is an in-process regex scan. When it fires,
  the SDK blocks the call locally and emits only a **de-identified metadata signal**
  (violation type/severity/counts) — never the text.
- **Identifiers are opaque.** `customer_id` / `user_id` must be customer-controlled opaque
  tokens. Raw-looking values (email/SSN/phone/credit-card) are **rejected**; a stable key,
  when needed, is derived with **HMAC-SHA256 using a customer-held secret that never leaves
  the environment** (not a reversible bare hash). The free-form `metadata` field was removed.
- **Deny-by-default egress.** Each outbound payload is a *closed* DTO containing only an
  allowlist of safe telemetry (see [`egress-allowlist.json`](../egress-allowlist.json)).
- **No third-party exfiltration.** No Sentry/OpenTelemetry/analytics dependencies. Logs,
  exceptions, and in-memory buffers carry no payloads or identifiers. Buffers are in-memory
  only (lost on crash, never persisted).
- **Proven, not asserted.** An enforced invariant test inspects the actual outbound bytes for
  every case (including PHI in free text, oversized prompts, nested tool args, and unicode
  obfuscation) and fails the build if any disallowed field could reach the transport. A CI
  guard fails the build if a content-transmitting path is reintroduced.
- **Fail-safe.** The SDK is fail-open with respect to the customer's own LLM call: hardening
  is structural (closed types), so it cannot throw on the hot path and break inference.

**Net effect for a BAA:** the SDK processes content transiently in the customer's memory to
count tokens and scan locally, and transmits only non-PHI operational telemetry. Content and
identity never cross the trust boundary.

---

## 2. Hardened data-flow diagram

```
 CUSTOMER ENVIRONMENT (trust boundary)                         │  MODELCOST
                                                               │
  ┌───────────────┐   prompt (in-memory only)                 │
  │ Your app code │──────────────┐                            │
  └───────────────┘              ▼                            │
        │             ┌─────────────────────────┐             │
        │             │ ModelCost SDK wrapper    │             │
        │             │  • local regex PII scan  │             │
        │             │  • token counting        │             │
        │             │  • cost calc (local)     │             │
        │             └───────────┬─────────────┘             │
        │  real request           │ extracts: tokens, model,   │
        ▼  (prompt+content)       │ provider, latency only     │
  ┌───────────────┐               │                            │
  │ LLM provider  │◀──────────────┘                            │
  │ (OpenAI, etc.)│   raw content goes ONLY to the provider    │
  └───────────────┘   the customer already chose               │
                                  │                             │
                                  │ closed egress DTO           │
                                  │ (allowlist only)            │
                                  ▼                             ▼
                    ┌──────────────────────────┐      ┌──────────────────┐
                    │ POST /api/v1/track        │─────▶│ ModelCost API    │
                    │ POST /governance/signals  │      │ (token counts,   │
                    │ POST /api/v1/sessions...   │      │  cost, opaque    │
                    └──────────────────────────┘      │  refs — no PHI)  │
                                                       └──────────────────┘
        ✗ REMOVED: POST /api/v1/governance/scan  (used to carry raw `text`)
        ✗ REMOVED: contentPrivacy flag, free-form metadata field
```

Raw content has exactly one destination — the LLM provider the customer already integrates
with. Nothing content-bearing flows to ModelCost.

---

## 3. Egress allowlist (deny-by-default)

The machine-readable contract is [`egress-allowlist.json`](../egress-allowlist.json), shared
verbatim across all three SDKs and enforced by the invariant tests. Summary:

| Endpoint | Allowed fields | Classification |
|----------|----------------|----------------|
| `POST /api/v1/track` | `api_key`, `timestamp`, `provider`, `model`, `feature`, `customer_id`, `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `latency_ms` | safe telemetry + opaque refs |
| `POST /api/v1/governance/signals` | `organization_id`, `violation_type`, `violation_subtype`, `severity`, `environment`, `action_taken`, `was_allowed`, `detected_at`, `source`, `violation_count` | de-identified metadata |
| `POST /api/v1/sessions` | `api_key`, `session_id`, `feature`, `user_id`, `max_spend_usd`, `max_iterations` | safe + opaque refs |
| `POST /api/v1/sessions/{id}/calls` | `api_key`, `call_sequence`, `call_type`, `tool_name`, token counts, `cost_usd`, cumulative\*, `pii_detected` | safe telemetry |
| `POST /api/v1/sessions/{id}/close` | `api_key`, `status`, `termination_reason`, final spend/iterations | safe telemetry |

`feature`, `customer_id`, `user_id` are **opaque** (validated against PII shapes; hashed via
HMAC when a secret is set). `metadata`, `text`, and any prompt/response/tool field are
**absent by construction** and rejected by closed DTOs.

---

## 4. Shared-responsibility model

| Concern | ModelCost SDK (in your env) | ModelCost (server) | Customer |
|---------|----------------------------|--------------------|----------|
| Prompt/response content | Reads in-memory to count tokens + scan locally; **never transmits** | Never receives | Sends content only to their chosen LLM provider |
| PII/PHI in content | Detected locally; blocks + emits metadata signal | Receives metadata only | Owns the data and the provider relationship |
| Identifiers (`customer_id`/`user_id`) | Rejects raw values; HMAC-pseudonymizes with customer secret | Stores opaque refs only | Supplies opaque tokens; holds the HMAC secret |
| `feature` labels | Validated as non-PII | Stores label | Must not put PII in labels |
| HMAC secret | Used locally only | Never receives | Provisions/rotates `MODELCOST_IDENTIFIER_SECRET` |
| Telemetry (tokens, cost, model, latency) | Computes + transmits | Receives, stores, bills | — |
| Transport security | TLS to `api.modelcost.ai`; API key auth | Authenticates, authorizes | Protects the API key |

The customer's LLM provider (OpenAI/Anthropic/Google) remains a separate data processor for
content; ModelCost is out of scope for content entirely.

---

## 5. How it is enforced (and how to verify)

**Structural (the guarantee):** outbound payloads are closed DTOs. There is no field to hold
content or metadata, and identifier helpers refuse raw PII. Removing capability — not toggling
a setting — is what makes egress impossible.

**Tested (the proof):** `tests/test_egress_invariant.py` (Python),
`EgressInvariantTest` (Java), `tests/egress-invariant.test.ts` (Node) intercept the real
outbound HTTP bytes and assert every body contains only allowlisted keys and no raw
PHI/identifier strings. Adversarial cases covered: PHI embedded in free text, oversized
prompts, nested tool args, unicode/zero-width obfuscation (scanner-miss → still no content),
and metadata/raw-identifier rejection.

**CI-guarded (no regression):** `scripts/egress_guard.sh` + the `Egress Guard` workflow fail
the build if `governance/scan`, `scanText`, a `contentPrivacy` gate, a `metadata` egress
field, or a raw-content DTO field is reintroduced.

Reproduce locally:

```bash
# Python
pip install -e ".[dev]" && bash scripts/egress_guard.sh && pytest

# Java
bash scripts/egress_guard.sh && mvn test

# Node
npm ci && bash scripts/egress_guard.sh && npm test
```

A reviewer can confirm the guarantee by planting a `text`/`metadata` field on an egress DTO:
the invariant test and the CI guard both fail.
