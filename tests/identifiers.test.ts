import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  IdentifierError,
  looksLikeDirectIdentifier,
  opaqueRef,
} from "../src/identifiers.js";

describe("identifiers", () => {
  describe("looksLikeDirectIdentifier", () => {
    it.each([
      "jane.doe@hospital.org",
      "123-45-6789",
      "(415) 555-0132",
      "4111 1111 1111 1111", // Luhn-valid
    ])("detects %s as PII", (v) => {
      expect(looksLikeDirectIdentifier(v)).toBe(true);
    });

    it.each(["cust_123", "u_9f8a7b", "tenant-42"])(
      "treats %s as opaque",
      (v) => {
        expect(looksLikeDirectIdentifier(v)).toBe(false);
      },
    );
  });

  describe("opaqueRef", () => {
    it("is null-safe", () => {
      expect(opaqueRef(null)).toBeNull();
      expect(opaqueRef(undefined)).toBeNull();
      expect(opaqueRef("")).toBeNull();
      expect(opaqueRef("   ")).toBeNull();
      // null is never hashed into a constant, even with a secret
      expect(opaqueRef(null, { secret: "s3cr3t" })).toBeNull();
    });

    it("passes opaque values through", () => {
      expect(opaqueRef("cust_123", { field: "customerId" })).toBe("cust_123");
    });

    it("rejects raw identifiers without a secret", () => {
      expect(() =>
        opaqueRef("jane.doe@hospital.org", { field: "customerId" }),
      ).toThrow(IdentifierError);
      expect(() => opaqueRef("123-45-6789", { field: "userId" })).toThrow(
        IdentifierError,
      );
    });

    it("pseudonymizes with an HMAC secret", () => {
      const ref = opaqueRef("jane.doe@hospital.org", { secret: "tenant-secret" });
      expect(ref).not.toBeNull();
      expect(ref!).toMatch(/^mc_/);
      // stable for the same (value, secret)
      expect(opaqueRef("jane.doe@hospital.org", { secret: "tenant-secret" })).toBe(
        ref,
      );
      expect(ref!).not.toContain("jane");
      expect(ref!).not.toContain("hospital");
    });

    it("uses keyed HMAC, not a bare SHA-256", () => {
      const value = "123-45-6789";
      const bare = createHash("sha256").update(value).digest("hex");
      const keyed = opaqueRef(value, { secret: "tenant-secret" })!;
      expect(keyed).not.toContain(bare);
      // different secrets => different refs
      expect(opaqueRef(value, { secret: "a" })).not.toBe(
        opaqueRef(value, { secret: "b" }),
      );
    });

    it("validates but does not pseudonymize feature labels", () => {
      expect(
        opaqueRef("chatbot", { field: "feature", pseudonymize: false }),
      ).toBe("chatbot");
      expect(() =>
        opaqueRef("patient jane.doe@x.com", {
          field: "feature",
          pseudonymize: false,
        }),
      ).toThrow(IdentifierError);
    });
  });
});
