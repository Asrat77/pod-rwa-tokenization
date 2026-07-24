import { describe, expect, it } from "vitest";

import {
  ControlledManualTreasuryRailAdapter,
  EVIDENCE_DOMAINS,
  approveFiatDisbursement,
  assertDisbursementAllowsNextRelease,
  createEvidenceCommitment,
  createFiatDisbursement,
  markDisbursementUsdcReleased,
  markFiatDisbursementFailed,
  markFiatDisbursementReturned,
  recordDisbursementConversion,
  reconcileFiatDisbursement,
  type FiatDisbursementV1,
} from "../src/index.js";
import {
  commitment,
  NOW,
  OTHER_WALLET,
  PROGRAM_ID,
  WALLET,
} from "./helpers.js";

const ISSUER_ATA = PROGRAM_ID;
const SUBSCRIPTION_VAULT = OTHER_WALLET;

function proposedDisbursement(): FiatDisbursementV1 {
  return createFiatDisbursement({
    id: "disbursement-deal-006-0",
    dealId: "deal-006",
    milestoneIndex: 0,
    railKind: "SQUADS_FIAT_FORWARD",
    issuerEntityReference: "us-corp-issuer",
    mseBeneficiaryEntityReference: "international-beneficiary-006",
    beneficiaryBankRouteCommitment: commitment("beneficiary-bank-route"),
    mseUsdcAta: ISSUER_ATA,
    releasedUsdcBaseUnits: "9000000",
    proposedBy: "operations-1",
    proposedAt: NOW,
  });
}

function directProposedDisbursement(): FiatDisbursementV1 {
  return createFiatDisbursement({
    id: "disbursement-deal-007-0",
    dealId: "deal-007",
    milestoneIndex: 0,
    railKind: "DIRECT_USDC",
    issuerEntityReference: "us-corp-issuer",
    mseBeneficiaryEntityReference: "international-mse-007",
    mseUsdcAta: ISSUER_ATA,
    releasedUsdcBaseUnits: "9000000",
    proposedBy: "operations-1",
    proposedAt: NOW,
  });
}

function approvedDisbursement(): FiatDisbursementV1 {
  const riskApproved = approveFiatDisbursement(proposedDisbursement(), {
    role: "RISK",
    approvedBy: "risk-1",
    approvedAt: "2026-07-23T18:01:00.000Z",
  });
  return approveFiatDisbursement(riskApproved, {
    role: "TREASURY",
    approvedBy: "treasury-1",
    approvedAt: "2026-07-23T18:02:00.000Z",
  });
}

function releasedDisbursement(): FiatDisbursementV1 {
  return markDisbursementUsdcReleased(approvedDisbursement(), {
    transactionSignature: "release-signature-1",
    finalizedSlot: "123456789",
    sourceTokenAccount: SUBSCRIPTION_VAULT,
    destinationTokenAccount: ISSUER_ATA,
    amountBaseUnits: "9000000",
    recordedAt: "2026-07-23T18:03:00.000Z",
  });
}

describe("fiat disbursement state machine", () => {
  it("requires distinct treasury and risk approvals before USDC release", () => {
    const first = approveFiatDisbursement(proposedDisbursement(), {
      role: "TREASURY",
      approvedBy: "approver-1",
      approvedAt: "2026-07-23T18:01:00.000Z",
    });
    expect(first.status).toBe("PROPOSED");
    expect(() =>
      approveFiatDisbursement(first, {
        role: "RISK",
        approvedBy: "approver-1",
        approvedAt: "2026-07-23T18:02:00.000Z",
      }),
    ).toThrow(/different actors/);
    expect(approvedDisbursement()).toMatchObject({
      status: "APPROVED",
      approvals: [
        { role: "RISK", approvedBy: "risk-1" },
        { role: "TREASURY", approvedBy: "treasury-1" },
      ],
    });
  });

  it("rejects an issuer configured as its own fiat beneficiary", () => {
    expect(() =>
      createFiatDisbursement({
        id: "bad-disbursement",
        dealId: "deal-006",
        milestoneIndex: 0,
        railKind: "SQUADS_FIAT_FORWARD",
        issuerEntityReference: "US-Corp-Issuer",
        mseBeneficiaryEntityReference: "us-corp-issuer",
        beneficiaryBankRouteCommitment: commitment("route"),
        mseUsdcAta: ISSUER_ATA,
        releasedUsdcBaseUnits: "1",
        proposedBy: "operations-1",
        proposedAt: NOW,
      }),
    ).toThrow(/distinct legal entities/);
  });

  it("pins exact release destination and amount", () => {
    expect(() =>
      markDisbursementUsdcReleased(approvedDisbursement(), {
        transactionSignature: "release-signature-1",
        finalizedSlot: "123",
        sourceTokenAccount: SUBSCRIPTION_VAULT,
        destinationTokenAccount: WALLET,
        amountBaseUnits: "9000000",
        recordedAt: "2026-07-23T18:03:00.000Z",
      }),
    ).toThrow(/MSE destination ATA/);
    expect(() =>
      markDisbursementUsdcReleased(approvedDisbursement(), {
        transactionSignature: "release-signature-1",
        finalizedSlot: "123",
        sourceTokenAccount: SUBSCRIPTION_VAULT,
        destinationTokenAccount: ISSUER_ATA,
        amountBaseUnits: "8999999",
        recordedAt: "2026-07-23T18:03:00.000Z",
      }),
    ).toThrow(/approved disbursement amount/);
  });

  it("records a complete manual conversion and SWIFT evidence chain without retaining secrets", async () => {
    const adapter = new ControlledManualTreasuryRailAdapter(
      () => new Date("2026-07-23T18:10:00.000Z"),
    );
    const converted = await adapter.recordDisbursementConversion(
      releasedDisbursement(),
      {
        providerReferenceEvidence: {
          encryptedReferenceKey: "provider-reference-secret",
        },
        grossUsdMinorUnits: "900",
        providerFeesUsdMinorUnits: "10",
        netUsdMinorUnits: "890",
        rateUsdMinorUnitsNumerator: "900",
        rateUsdcBaseUnitsDenominator: "9000000",
        evidence: { encryptedDocumentKey: "conversion-document-secret" },
        recordedBy: "treasury-operator",
      },
    );
    expect(converted.status).toBe("CONVERTED");

    const swiftSent = await adapter.recordSwiftSent(converted, {
      grossUsdMinorUnits: "890",
      bankFeesUsdMinorUnits: "20",
      netUsdMinorUnits: "870",
      uetr: "sensitive-uetr-that-must-not-be-stored",
      valueDate: "2026-07-24",
      evidence: { encryptedDocumentKey: "swift-document-secret" },
      recordedBy: "treasury-operator",
    });
    expect(swiftSent.status).toBe("SWIFT_SENT");
    expect(JSON.stringify(swiftSent)).not.toContain("sensitive-uetr");

    const confirmed = await adapter.recordBankConfirmation(swiftSent, {
      evidence: { encryptedDocumentKey: "bank-confirmation-secret" },
      reviewedBy: "independent-reviewer",
    });
    expect(confirmed.status).toBe("BANK_CONFIRMED");
    expect(() => assertDisbursementAllowsNextRelease(confirmed)).toThrow(
      /reconciled/,
    );

    const reconciled = await adapter.reconcileDisbursement(confirmed, {
      evidence: { ledgerBatch: "ledger-batch-secret" },
      reconciledBy: "reconciliation-operator",
    });
    expect(reconciled.status).toBe("RECONCILED");
    expect(() => assertDisbursementAllowsNextRelease(reconciled)).not.toThrow();
  });

  it("reconciles a direct-USDC MSE movement straight from release and blocks the fiat stages", () => {
    const approvedFirst = approveFiatDisbursement(directProposedDisbursement(), {
      role: "RISK",
      approvedBy: "risk-1",
      approvedAt: "2026-07-23T18:01:00.000Z",
    });
    const approved = approveFiatDisbursement(approvedFirst, {
      role: "TREASURY",
      approvedBy: "treasury-1",
      approvedAt: "2026-07-23T18:02:00.000Z",
    });
    const released = markDisbursementUsdcReleased(approved, {
      transactionSignature: "direct-release-signature",
      finalizedSlot: "223456789",
      sourceTokenAccount: SUBSCRIPTION_VAULT,
      destinationTokenAccount: ISSUER_ATA,
      amountBaseUnits: "9000000",
      recordedAt: "2026-07-23T18:03:00.000Z",
    });
    expect(released.status).toBe("USDC_RELEASED");

    expect(() =>
      recordDisbursementConversion(released, {
        providerReferenceCommitment: commitment("provider"),
        grossUsdMinorUnits: "900",
        providerFeesUsdMinorUnits: "0",
        netUsdMinorUnits: "900",
        rateUsdMinorUnitsNumerator: "900",
        rateUsdcBaseUnitsDenominator: "9000000",
        evidenceCommitment: commitment("conversion"),
        recordedBy: "treasury-operator",
        recordedAt: "2026-07-23T18:04:00.000Z",
      }),
    ).toThrow(/Squads fiat-forward rail/);

    const reconciled = reconcileFiatDisbursement(released, {
      evidenceCommitment: commitment("direct-reconciliation"),
      reconciledBy: "reconciliation-operator",
      reconciledAt: "2026-07-23T18:05:00.000Z",
    });
    expect(reconciled.status).toBe("RECONCILED");
    expect(() => assertDisbursementAllowsNextRelease(reconciled)).not.toThrow();
  });

  it("requires explicit fee conservation at conversion and SWIFT stages", async () => {
    const adapter = new ControlledManualTreasuryRailAdapter();
    await expect(
      adapter.recordDisbursementConversion(releasedDisbursement(), {
        providerReferenceEvidence: "provider",
        grossUsdMinorUnits: "900",
        providerFeesUsdMinorUnits: "10",
        netUsdMinorUnits: "891",
        rateUsdMinorUnitsNumerator: "1",
        rateUsdcBaseUnitsDenominator: "1",
        evidence: "receipt",
        recordedBy: "operator",
        occurredAt: "2026-07-23T18:10:00.000Z",
      }),
    ).rejects.toThrow(/gross must equal net plus explicit fees/);
    await expect(
      adapter.recordDisbursementConversion(releasedDisbursement(), {
        providerReferenceEvidence: "provider",
        grossUsdMinorUnits: "900",
        providerFeesUsdMinorUnits: "0",
        netUsdMinorUnits: "900",
        rateUsdMinorUnitsNumerator: "901",
        rateUsdcBaseUnitsDenominator: "9000000",
        evidence: "receipt",
        recordedBy: "operator",
        occurredAt: "2026-07-23T18:10:00.000Z",
      }),
    ).rejects.toThrow(/rate must exactly reconcile/);
  });

  it("supports auditable failed and returned terminal states", async () => {
    const failed = markFiatDisbursementFailed(releasedDisbursement(), {
      reasonCode: "CONVERSION_REJECTED",
      evidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.failure,
        "failure-reference",
      ),
      recordedBy: "operations-1",
      recordedAt: "2026-07-23T18:05:00.000Z",
    });
    expect(failed).toMatchObject({
      status: "FAILED",
      exception: { previousStatus: "USDC_RELEASED" },
    });

    const adapter = new ControlledManualTreasuryRailAdapter(
      () => new Date("2026-07-23T18:10:00.000Z"),
    );
    const converted = await adapter.recordDisbursementConversion(
      releasedDisbursement(),
      {
        providerReferenceEvidence: "provider",
        grossUsdMinorUnits: "900",
        providerFeesUsdMinorUnits: "0",
        netUsdMinorUnits: "900",
        rateUsdMinorUnitsNumerator: "1",
        rateUsdcBaseUnitsDenominator: "10000",
        evidence: "conversion",
        recordedBy: "operator",
      },
    );
    const sent = await adapter.recordSwiftSent(converted, {
      grossUsdMinorUnits: "900",
      bankFeesUsdMinorUnits: "0",
      netUsdMinorUnits: "900",
      uetr: "returned-wire-uetr",
      valueDate: "2026-07-24",
      evidence: "swift",
      recordedBy: "operator",
    });
    const returned = markFiatDisbursementReturned(sent, {
      reasonCode: "BENEFICIARY_BANK_RETURN",
      evidenceCommitment: commitment("return-evidence"),
      recordedBy: "operations-1",
      recordedAt: "2026-07-25T18:00:00.000Z",
    });
    expect(returned.status).toBe("RETURNED");
    expect(() => assertDisbursementAllowsNextRelease(returned)).toThrow();
  });

  it("does not permit transitions to be skipped or repeated", () => {
    expect(() =>
      approveFiatDisbursement(proposedDisbursement(), {
        role: "RISK",
        approvedBy: "risk-1",
        approvedAt: "2026-07-23T17:59:59.000Z",
      }),
    ).toThrow(/cannot precede/);
    expect(() =>
      markDisbursementUsdcReleased(proposedDisbursement(), {
        transactionSignature: "sig",
        finalizedSlot: "1",
        sourceTokenAccount: SUBSCRIPTION_VAULT,
        destinationTokenAccount: ISSUER_ATA,
        amountBaseUnits: "9000000",
        recordedAt: NOW,
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      approveFiatDisbursement(approvedDisbursement(), {
        role: "RISK",
        approvedBy: "different-risk",
        approvedAt: NOW,
      }),
    ).toThrow(/not allowed/);
  });
});
