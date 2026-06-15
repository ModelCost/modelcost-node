import { createHmac } from "node:crypto";
import { ModelCostError } from "./errors.js";

/**
 * Client-side identifier hardening.
 *
 * Any value that references an entity (`customerId`, `userId`, `feature`) must leave
 * the customer environment as an OPAQUE token — never a raw direct/quasi identifier
 * (email, SSN, phone, credit-card, name, MRN).
 *
 * 1. Reject raw identifiers unless they can be turned into a stable opaque key.
 * 2. Pseudonymize with a customer-held secret via HMAC-SHA256, never a bare hash:
 *    a bare `sha256(value)` of a low-entropy identifier is trivially reversible and
 *    remains PHI under HIPAA Safe Harbor. The secret never leaves the environment.
 */

export class IdentifierError extends ModelCostError {
  constructor(message: string) {
    super(message);
    this.name = "IdentifierError";
  }
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const PHONE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const CREDIT_CARD = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

function isValidLuhn(num: string): boolean {
  if (num.length < 13 || num.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = num.length - 1; i >= 0; i--) {
    const ch = num[i]!;
    if (ch < "0" || ch > "9") return false;
    let n = parseInt(ch, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Returns true if `value` contains a recognisable direct identifier (PII). */
export function looksLikeDirectIdentifier(value: string): boolean {
  if (EMAIL.test(value) || SSN.test(value) || PHONE.test(value)) {
    return true;
  }
  for (const match of value.matchAll(CREDIT_CARD)) {
    if (isValidLuhn(match[0].replace(/[\s-]/g, ""))) return true;
  }
  return false;
}

export interface OpaqueRefOptions {
  secret?: string;
  field?: string;
  /** When false (e.g. for readable `feature` labels), only validate — don't hash. */
  pseudonymize?: boolean;
}

/**
 * Returns an opaque, transmit-safe form of `value` (or `null`).
 *
 * - null/blank -> null (never hashed into a constant; never throws);
 * - pseudonymize (default true) && secret -> "mc_" + HMAC-SHA256(secret, value);
 * - else if the value looks like a direct identifier -> throws {@link IdentifierError};
 * - else passes the value through.
 */
export function opaqueRef(
  value: string | null | undefined,
  options: OpaqueRefOptions = {},
): string | null {
  const { secret, field = "identifier", pseudonymize = true } = options;
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text.length === 0) return null;

  if (pseudonymize && secret && secret.length > 0) {
    const digest = createHmac("sha256", secret).update(text).digest("hex");
    return "mc_" + digest.slice(0, 32);
  }

  if (looksLikeDirectIdentifier(text)) {
    throw new IdentifierError(
      `'${field}' value looks like a direct identifier (PII/PHI) and would leak. ` +
        "Pass an opaque token you control, or set MODELCOST_IDENTIFIER_SECRET to " +
        "pseudonymize it locally (the secret never leaves your environment). " +
        "ModelCost never receives raw identifiers.",
    );
  }
  return text;
}
