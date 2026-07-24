import { describe, expect, it } from "vitest";

import {
  createEvidenceCommitment,
  EVIDENCE_DOMAINS,
  verifyEvidenceCommitment,
  type EvidenceValue,
} from "../src/index.js";

describe("evidence commitments", () => {
  it("is deterministic across object key order", () => {
    const left = createEvidenceCommitment(EVIDENCE_DOMAINS.conversion, {
      amountBaseUnits: "9000000",
      provider: { id: "provider-1", version: 1 },
    });
    const right = createEvidenceCommitment(EVIDENCE_DOMAINS.conversion, {
      provider: { version: 1, id: "provider-1" },
      amountBaseUnits: "9000000",
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("separates identical evidence by domain", () => {
    const evidence = { document: "opaque-encrypted-reference" };
    expect(
      createEvidenceCommitment(EVIDENCE_DOMAINS.conversion, evidence),
    ).not.toBe(
      createEvidenceCommitment(EVIDENCE_DOMAINS.bankConfirmation, evidence),
    );
  });

  it("verifies without exposing the underlying sensitive value", () => {
    const commitment = createEvidenceCommitment(
      EVIDENCE_DOMAINS.swiftUetr,
      "sensitive-uetr-value",
    );
    expect(
      verifyEvidenceCommitment(
        commitment,
        EVIDENCE_DOMAINS.swiftUetr,
        "sensitive-uetr-value",
      ),
    ).toBe(true);
    expect(
      verifyEvidenceCommitment(
        commitment,
        EVIDENCE_DOMAINS.swiftUetr,
        "different-value",
      ),
    ).toBe(false);
    expect(commitment).not.toContain("sensitive");
  });

  it("rejects unsafe or fractional JSON numbers so money cannot leak into floats", () => {
    expect(() =>
      createEvidenceCommitment(EVIDENCE_DOMAINS.conversion, {
        amount: 1.5,
      }),
    ).toThrow(/safe integers/);
    expect(() =>
      createEvidenceCommitment(EVIDENCE_DOMAINS.conversion, {
        amount: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/safe integers/);
  });

  it("rejects cyclic and non-plain evidence objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      createEvidenceCommitment(
        EVIDENCE_DOMAINS.conversion,
        cyclic as EvidenceValue,
      ),
    ).toThrow(/cyclic/);
    expect(() =>
      createEvidenceCommitment(
        EVIDENCE_DOMAINS.conversion,
        new Date("2026-07-23T00:00:00.000Z") as unknown as EvidenceValue,
      ),
    ).toThrow(/plain records/);
  });
});
