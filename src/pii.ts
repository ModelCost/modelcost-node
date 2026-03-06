/**
 * Result of a PII scan on a text string.
 */
export interface PiiEntity {
  type: string;
  value: string;
  start: number;
  end: number;
}

export interface PiiResult {
  detected: boolean;
  entities: PiiEntity[];
  redactedText: string;
}

/**
 * A governance violation detected by the full scanner.
 */
export interface GovernanceViolation {
  category: string;
  type: string;
  severity: string;
  start: number;
  end: number;
}

/**
 * Result of a full governance scan across all categories.
 */
export interface FullScanResult {
  detected: boolean;
  violations: GovernanceViolation[];
  categories: string[];
}

/**
 * Pre-compiled regex patterns for common PII types.
 */
const PII_PATTERNS: ReadonlyArray<{ type: string; pattern: RegExp }> = [
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: "credit_card_visa",
    pattern: /\b4\d{3}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  },
  {
    type: "credit_card_mastercard",
    pattern: /\b5[1-5]\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  },
  {
    type: "credit_card_amex",
    pattern: /\b3[47]\d{2}[- ]?\d{6}[- ]?\d{5}\b/g,
  },
  {
    type: "credit_card_discover",
    pattern: /\b6(?:011|5\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  },
  {
    type: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: "phone_us",
    pattern:
      /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
  },
];

/**
 * Credit card pattern for Luhn-validated matching (all card types).
 */
const CREDIT_CARD_GENERIC_PATTERN =
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

/**
 * Secrets detection patterns.
 */
const SECRETS_PATTERNS: ReadonlyArray<{
  type: string;
  pattern: RegExp;
  severity: string;
}> = [
  {
    type: "api_key_openai",
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    severity: "critical",
  },
  {
    type: "api_key_aws",
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: "critical",
  },
  {
    type: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    severity: "critical",
  },
  {
    type: "jwt_token",
    pattern:
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    severity: "high",
  },
  {
    type: "generic_secret",
    pattern:
      /(?:password|api_key|apikey|secret|token|bearer)\s*[:=]\s*["']?([A-Za-z0-9_\-/.]{8,})["']?/gi,
    severity: "critical",
  },
];

/**
 * Financial detection patterns.
 */
const FINANCIAL_PATTERNS: ReadonlyArray<{
  type: string;
  pattern: RegExp;
  severity: string;
}> = [
  {
    type: "iban",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g,
    severity: "high",
  },
];

/**
 * Medical terms used to identify PHI context.
 * When these appear alongside PII, the combination is classified as PHI.
 */
const MEDICAL_TERMS: ReadonlySet<string> = new Set([
  "diabetes",
  "hiv",
  "aids",
  "cancer",
  "tumor",
  "disease",
  "medication",
  "diagnosis",
  "treatment",
  "surgery",
  "prescription",
  "patient",
  "doctor",
  "hospital",
  "clinic",
  "medical record",
  "insulin",
  "prozac",
  "chemotherapy",
  "depression",
  "anxiety",
  "bipolar",
  "schizophrenia",
  "hepatitis",
  "tuberculosis",
  "epilepsy",
  "asthma",
  "arthritis",
  "alzheimer",
]);

/**
 * Local PII scanner using regex pattern matching.
 *
 * Provides a fast, offline first-pass for PII detection before
 * optionally deferring to the server-side governance scan.
 *
 * Also provides full governance scanning (PII, PHI, secrets, financial)
 * for metadata-only mode where content never leaves the customer's environment.
 */
export class PiiScanner {
  /**
   * Scan text and return all detected PII entities, plus a redacted version.
   */
  scan(text: string): PiiResult {
    const entities: PiiEntity[] = [];

    for (const { type, pattern } of PII_PATTERNS) {
      // Reset regex state for each scan
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // Luhn-validate credit card matches
        if (type.startsWith("credit_card_")) {
          const digits = match[0].replace(/[\s-]/g, "");
          if (!PiiScanner._isValidLuhn(digits)) continue;
        }

        entities.push({
          type,
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    // Sort by start position for deterministic output
    entities.sort((a, b) => a.start - b.start);

    // Remove overlapping matches (keep the first/longest at each position)
    const deduped = this._removeOverlaps(entities);

    const redactedText = this._redactText(text, deduped);

    return {
      detected: deduped.length > 0,
      entities: deduped,
      redactedText,
    };
  }

  /**
   * Full governance scan across multiple categories.
   * Used in metadata-only mode where content never leaves the customer's environment.
   */
  fullScan(
    text: string,
    categories: string[] = ["pii", "phi", "secrets", "financial"],
  ): FullScanResult {
    const violations: GovernanceViolation[] = [];
    const detectedCategories = new Set<string>();

    if (categories.includes("pii")) {
      const piiViolations = this._scanPiiViolations(text);
      for (const v of piiViolations) {
        violations.push(v);
        detectedCategories.add("pii");
      }
    }

    if (categories.includes("phi")) {
      const phiViolations = this._scanPhi(text);
      for (const v of phiViolations) {
        violations.push(v);
        detectedCategories.add("phi");
      }
    }

    if (categories.includes("secrets")) {
      const secretViolations = this._scanSecrets(text);
      for (const v of secretViolations) {
        violations.push(v);
        detectedCategories.add("secrets");
      }
    }

    if (categories.includes("financial")) {
      const financialViolations = this._scanFinancial(text);
      for (const v of financialViolations) {
        violations.push(v);
        detectedCategories.add("financial");
      }
    }

    return {
      detected: violations.length > 0,
      violations,
      categories: [...detectedCategories],
    };
  }

  /**
   * Convenience method: return only the redacted text.
   */
  redact(text: string): string {
    return this.scan(text).redactedText;
  }

  // ─── Category Scanners ──────────────────────────────────────────────

  private _scanPiiViolations(text: string): GovernanceViolation[] {
    const violations: GovernanceViolation[] = [];

    // SSN
    for (const match of text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
      violations.push({
        category: "pii",
        type: "ssn",
        severity: "critical",
        start: match.index!,
        end: match.index! + match[0].length,
      });
    }

    // Email
    for (const match of text.matchAll(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    )) {
      violations.push({
        category: "pii",
        type: "email",
        severity: "high",
        start: match.index!,
        end: match.index! + match[0].length,
      });
    }

    // Credit card (Luhn-validated)
    for (const match of text.matchAll(CREDIT_CARD_GENERIC_PATTERN)) {
      const digits = match[0].replace(/[\s-]/g, "");
      if (PiiScanner._isValidLuhn(digits)) {
        violations.push({
          category: "pii",
          type: "credit_card",
          severity: "critical",
          start: match.index!,
          end: match.index! + match[0].length,
        });
      }
    }

    // Phone
    for (const match of text.matchAll(
      /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
    )) {
      violations.push({
        category: "pii",
        type: "phone",
        severity: "medium",
        start: match.index!,
        end: match.index! + match[0].length,
      });
    }

    return violations;
  }

  private _scanPhi(text: string): GovernanceViolation[] {
    const textLower = text.toLowerCase();
    let hasMedicalContext = false;

    for (const term of MEDICAL_TERMS) {
      if (textLower.includes(term)) {
        hasMedicalContext = true;
        break;
      }
    }

    if (!hasMedicalContext) return [];

    // Medical context + PII = PHI violation
    const piiViolations = this._scanPiiViolations(text);
    return piiViolations.map((v) => ({
      ...v,
      category: "phi",
      type: `phi_${v.type}`,
      severity: "critical",
    }));
  }

  private _scanSecrets(text: string): GovernanceViolation[] {
    const violations: GovernanceViolation[] = [];

    for (const { type, pattern, severity } of SECRETS_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        violations.push({
          category: "secrets",
          type,
          severity,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    return violations;
  }

  private _scanFinancial(text: string): GovernanceViolation[] {
    const violations: GovernanceViolation[] = [];

    // Credit card (Luhn-validated)
    for (const match of text.matchAll(CREDIT_CARD_GENERIC_PATTERN)) {
      const digits = match[0].replace(/[\s-]/g, "");
      if (PiiScanner._isValidLuhn(digits)) {
        violations.push({
          category: "financial",
          type: "credit_card",
          severity: "critical",
          start: match.index!,
          end: match.index! + match[0].length,
        });
      }
    }

    // IBAN
    for (const { type, pattern, severity } of FINANCIAL_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        violations.push({
          category: "financial",
          type,
          severity,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    return violations;
  }

  // ─── Utilities ──────────────────────────────────────────────────────

  /**
   * Remove overlapping entities, preferring the one that starts first
   * (and is longest in case of a tie).
   */
  private _removeOverlaps(entities: PiiEntity[]): PiiEntity[] {
    if (entities.length === 0) return entities;

    const result: PiiEntity[] = [entities[0]!];

    for (let i = 1; i < entities.length; i++) {
      const current = entities[i]!;
      const last = result[result.length - 1]!;

      if (current.start >= last.end) {
        result.push(current);
      } else if (
        current.start === last.start &&
        current.end > last.end
      ) {
        result[result.length - 1] = current;
      }
    }

    return result;
  }

  /**
   * Replace detected entities with [REDACTED] markers.
   */
  private _redactText(text: string, entities: PiiEntity[]): string {
    if (entities.length === 0) return text;

    let result = "";
    let cursor = 0;

    for (const entity of entities) {
      result += text.slice(cursor, entity.start);
      result += `[${entity.type.toUpperCase()}]`;
      cursor = entity.end;
    }

    result += text.slice(cursor);
    return result;
  }

  /**
   * Luhn algorithm for credit card validation.
   */
  static _isValidLuhn(number: string): boolean {
    if (number.length < 13 || number.length > 19) return false;

    let sum = 0;
    let alternate = false;

    for (let i = number.length - 1; i >= 0; i--) {
      const char = number[i]!;
      if (char < "0" || char > "9") return false;

      let n = parseInt(char, 10);
      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alternate = !alternate;
    }

    return sum % 10 === 0;
  }
}
