import { describe, it, expect } from "vitest";
import { PiiScanner } from "../src/pii.js";

describe("PiiScanner", () => {
  const scanner = new PiiScanner();

  describe("SSN detection", () => {
    it("should detect a Social Security Number", () => {
      const result = scanner.scan("My SSN is 123-45-6789.");

      expect(result.detected).toBe(true);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]!.type).toBe("ssn");
      expect(result.entities[0]!.value).toBe("123-45-6789");
      expect(result.entities[0]!.start).toBe(10);
      expect(result.entities[0]!.end).toBe(21);
    });

    it("should detect multiple SSNs", () => {
      const result = scanner.scan("SSN1: 111-22-3333, SSN2: 444-55-6666");

      expect(result.detected).toBe(true);
      expect(result.entities.filter((e) => e.type === "ssn")).toHaveLength(2);
    });
  });

  describe("credit card detection", () => {
    it("should detect a Visa card number", () => {
      const result = scanner.scan("Card: 4111111111111111");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("credit_card_visa");
      expect(result.entities[0]!.value).toBe("4111111111111111");
    });

    it("should detect a MasterCard number", () => {
      const result = scanner.scan("Card: 5500000000000004");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("credit_card_mastercard");
    });

    it("should detect an Amex number", () => {
      const result = scanner.scan("Card: 340000000000009");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("credit_card_amex");
    });

    it("should detect a Discover card number", () => {
      const result = scanner.scan("Card: 6011000000000004");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("credit_card_discover");
    });
  });

  describe("email detection", () => {
    it("should detect an email address", () => {
      const result = scanner.scan("Contact me at user@example.com please.");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("email");
      expect(result.entities[0]!.value).toBe("user@example.com");
    });

    it("should detect email with subdomain", () => {
      const result = scanner.scan("Email: admin@mail.corp.example.com");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("email");
    });
  });

  describe("US phone number detection", () => {
    it("should detect a US phone number with dashes", () => {
      const result = scanner.scan("Call me at 555-123-4567.");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("phone_us");
    });

    it("should detect a US phone number with parentheses", () => {
      const result = scanner.scan("Phone: (555) 123-4567");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("phone_us");
    });

    it("should detect a US phone number with +1 prefix", () => {
      const result = scanner.scan("Call +1-555-123-4567");

      expect(result.detected).toBe(true);
      expect(result.entities[0]!.type).toBe("phone_us");
    });
  });

  describe("clean text", () => {
    it("should return no detections for clean text", () => {
      const result = scanner.scan(
        "Hello, this is a normal message with no PII.",
      );

      expect(result.detected).toBe(false);
      expect(result.entities).toHaveLength(0);
      expect(result.redactedText).toBe(
        "Hello, this is a normal message with no PII.",
      );
    });

    it("should return no detections for empty string", () => {
      const result = scanner.scan("");

      expect(result.detected).toBe(false);
      expect(result.entities).toHaveLength(0);
    });
  });

  describe("redaction", () => {
    it("should redact SSN with type tag", () => {
      const result = scanner.scan("SSN: 123-45-6789");

      expect(result.redactedText).toBe("SSN: [SSN]");
    });

    it("should redact email with type tag", () => {
      const result = scanner.scan("Email: user@example.com");

      expect(result.redactedText).toBe("Email: [EMAIL]");
    });

    it("should redact multiple PII types in one text", () => {
      const text = "SSN: 123-45-6789, Email: test@test.com";
      const result = scanner.scan(text);

      expect(result.detected).toBe(true);
      expect(result.redactedText).toContain("[SSN]");
      expect(result.redactedText).toContain("[EMAIL]");
      expect(result.redactedText).not.toContain("123-45-6789");
      expect(result.redactedText).not.toContain("test@test.com");
    });

    it("should provide a convenience redact method", () => {
      const redacted = scanner.redact("My SSN is 123-45-6789");

      expect(redacted).toBe("My SSN is [SSN]");
    });
  });

  // ─── fullScan tests ─────────────────────────────────────────────

  describe("fullScan - secrets detection", () => {
    it("should detect OpenAI API keys", () => {
      const result = scanner.fullScan(
        "My key is sk-abc123def456ghi789jkl012mno",
      );

      expect(result.detected).toBe(true);
      expect(result.categories).toContain("secrets");
      const secret = result.violations.find(
        (v) => v.type === "api_key_openai",
      );
      expect(secret).toBeDefined();
      expect(secret!.severity).toBe("critical");
    });

    it("should detect AWS access keys", () => {
      const result = scanner.fullScan("AWS key: AKIAIOSFODNN7EXAMPLE");

      expect(result.detected).toBe(true);
      expect(result.categories).toContain("secrets");
      const aws = result.violations.find((v) => v.type === "api_key_aws");
      expect(aws).toBeDefined();
    });

    it("should detect private keys", () => {
      const result = scanner.fullScan(
        "-----BEGIN RSA PRIVATE KEY-----\nsome_content\n-----END RSA PRIVATE KEY-----",
      );

      expect(result.detected).toBe(true);
      const pk = result.violations.find((v) => v.type === "private_key");
      expect(pk).toBeDefined();
      expect(pk!.severity).toBe("critical");
    });

    it("should detect JWT tokens", () => {
      const result = scanner.fullScan(
        "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      );

      expect(result.detected).toBe(true);
      const jwt = result.violations.find((v) => v.type === "jwt_token");
      expect(jwt).toBeDefined();
    });

    it("should detect generic secrets like password=", () => {
      const result = scanner.fullScan(
        "config: password=SuperSecretValue123",
      );

      expect(result.detected).toBe(true);
      const generic = result.violations.find(
        (v) => v.type === "generic_secret",
      );
      expect(generic).toBeDefined();
    });
  });

  describe("fullScan - PHI detection", () => {
    it("should detect PHI when medical terms co-occur with PII", () => {
      const result = scanner.fullScan(
        "Patient John with SSN 123-45-6789 has diabetes and needs insulin",
      );

      expect(result.detected).toBe(true);
      expect(result.categories).toContain("phi");
      const phiViolation = result.violations.find(
        (v) => v.category === "phi",
      );
      expect(phiViolation).toBeDefined();
    });

    it("should NOT flag PHI without PII co-occurrence", () => {
      const result = scanner.fullScan(
        "The patient is being treated for diabetes",
        ["phi"],
      );

      // No PII to combine with medical terms
      expect(result.violations.filter((v) => v.category === "phi")).toHaveLength(0);
    });
  });

  describe("fullScan - financial detection", () => {
    it("should detect credit card with Luhn validation", () => {
      const result = scanner.fullScan("Card: 4111111111111111", [
        "financial",
      ]);

      expect(result.detected).toBe(true);
      expect(result.categories).toContain("financial");
    });

    it("should detect IBAN numbers", () => {
      const result = scanner.fullScan(
        "Transfer to DE89370400440532013000",
        ["financial"],
      );

      expect(result.detected).toBe(true);
      const iban = result.violations.find((v) => v.type === "iban");
      expect(iban).toBeDefined();
    });
  });

  describe("fullScan - Luhn validation", () => {
    it("should validate correct Luhn numbers", () => {
      expect(PiiScanner._isValidLuhn("4111111111111111")).toBe(true);
      expect(PiiScanner._isValidLuhn("5500000000000004")).toBe(true);
    });

    it("should reject invalid Luhn numbers", () => {
      expect(PiiScanner._isValidLuhn("1234567890123456")).toBe(false);
      expect(PiiScanner._isValidLuhn("0000000000000000")).toBe(true); // 0s pass Luhn
    });

    it("should reject too short/long numbers", () => {
      expect(PiiScanner._isValidLuhn("123")).toBe(false);
      expect(PiiScanner._isValidLuhn("")).toBe(false);
    });
  });

  describe("fullScan - clean text", () => {
    it("should return no violations for clean text", () => {
      const result = scanner.fullScan("Just a normal business message.");

      expect(result.detected).toBe(false);
      expect(result.violations).toHaveLength(0);
      expect(result.categories).toHaveLength(0);
    });

    it("should return no violations for empty string", () => {
      const result = scanner.fullScan("");

      expect(result.detected).toBe(false);
    });
  });

  describe("fullScan - category filtering", () => {
    it("should only scan requested categories", () => {
      const text = "SSN: 123-45-6789 and key: sk-abc123def456ghi789jkl012mno";

      const piiOnly = scanner.fullScan(text, ["pii"]);
      expect(piiOnly.categories).toContain("pii");
      expect(piiOnly.categories).not.toContain("secrets");

      const secretsOnly = scanner.fullScan(text, ["secrets"]);
      expect(secretsOnly.categories).toContain("secrets");
      expect(secretsOnly.categories).not.toContain("pii");
    });
  });
});
