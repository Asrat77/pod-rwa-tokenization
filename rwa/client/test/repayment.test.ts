import { describe, expect, it } from "vitest";

import {
  ControlledManualTreasuryRailAdapter,
  createFiatRepayment,
  markRepaymentUsdcDeposited,
  type FiatRepaymentV1,
} from "../src/index.js";
import {
  NOW,
  OTHER_WALLET,
  PROGRAM_ID,
  WALLET,
} from "./helpers.js";

const TREASURY_ATA = PROGRAM_ID;
const REPAYMENT_VAULT = OTHER_WALLET;

function proposedRepayment(): FiatRepaymentV1 {
  return createFiatRepayment({
    id: "repayment-deal-006-1",
    dealId: "deal-006",
    payerType: "FIAT_BENEFICIARY",
    payerEntityReference: "international-beneficiary-006",
    issuerEntityReference: "us-corp-issuer",
    issuerTreasuryUsdcAta: TREASURY_ATA,
    repaymentVaultUsdcAta: REPAYMENT_VAULT,
    proposedBy: "operations-1",
    proposedAt: NOW,
  });
}

describe("reverse fiat repayment workflow", () => {
  it("reconciles bank receipt, conversion, issuer treasury transfer, and vault deposit", async () => {
    const adapter = new ControlledManualTreasuryRailAdapter(
      () => new Date("2026-08-23T18:10:00.000Z"),
    );
    const received = await adapter.recordFiatRepaymentReceived(
      proposedRepayment(),
      {
        grossUsdMinorUnits: "3400",
        bankFeesUsdMinorUnits: "100",
        netUsdMinorUnits: "3300",
        evidence: { encryptedIncomingWire: "bank-object-key" },
        recordedBy: "treasury-operator",
      },
    );
    expect(received.status).toBe("FIAT_RECEIVED");

    const converted = await adapter.recordFiatRepaymentConversion(received, {
      sourceUsdMinorUnits: "3300",
      providerFeesUsdMinorUnits: "0",
      convertedUsdMinorUnits: "3300",
      acquiredUsdcBaseUnits: "33000000",
      rateUsdcBaseUnitsNumerator: "10000",
      rateUsdMinorUnitsDenominator: "1",
      providerReferenceEvidence: { encryptedProviderRef: "provider-object-key" },
      evidence: { encryptedConversionReceipt: "conversion-object-key" },
      recordedBy: "treasury-operator",
    });
    expect(converted.status).toBe("CONVERTED");

    const deposited = markRepaymentUsdcDeposited(converted, {
      transactionSignature: "repayment-deposit-signature",
      finalizedSlot: "22334455",
      sourceTokenAccount: TREASURY_ATA,
      destinationTokenAccount: REPAYMENT_VAULT,
      amountBaseUnits: "33000000",
      recordedAt: "2026-08-23T18:15:00.000Z",
    });
    expect(deposited.status).toBe("USDC_DEPOSITED");

    const reconciled = await adapter.reconcileRepayment(deposited, {
      evidence: { accountingBatch: "batch-006-1" },
      reconciledBy: "independent-reconciler",
      occurredAt: "2026-08-23T18:20:00.000Z",
    });
    expect(reconciled).toMatchObject({
      status: "RECONCILED",
      onchainDeposit: {
        sourceTokenAccount: TREASURY_ATA,
        destinationTokenAccount: REPAYMENT_VAULT,
        amountBaseUnits: "33000000",
      },
    });
  });

  it("rejects silent bank and conversion fee differences", async () => {
    const adapter = new ControlledManualTreasuryRailAdapter();
    await expect(
      adapter.recordFiatRepaymentReceived(proposedRepayment(), {
        grossUsdMinorUnits: "3400",
        bankFeesUsdMinorUnits: "100",
        netUsdMinorUnits: "3200",
        evidence: "incoming-wire",
        recordedBy: "operator",
        occurredAt: NOW,
      }),
    ).rejects.toThrow(/gross must equal net plus explicit fees/);
  });

  it("requires the registered treasury source, repayment vault, and exact converted USDC", async () => {
    const adapter = new ControlledManualTreasuryRailAdapter();
    const received = await adapter.recordFiatRepaymentReceived(
      proposedRepayment(),
      {
        grossUsdMinorUnits: "3300",
        bankFeesUsdMinorUnits: "0",
        netUsdMinorUnits: "3300",
        evidence: "incoming-wire",
        recordedBy: "operator",
        occurredAt: NOW,
      },
    );
    const converted = await adapter.recordFiatRepaymentConversion(received, {
      sourceUsdMinorUnits: "3300",
      providerFeesUsdMinorUnits: "0",
      convertedUsdMinorUnits: "3300",
      acquiredUsdcBaseUnits: "33000000",
      rateUsdcBaseUnitsNumerator: "10000",
      rateUsdMinorUnitsDenominator: "1",
      providerReferenceEvidence: "provider",
      evidence: "conversion",
      recordedBy: "operator",
      occurredAt: NOW,
    });
    expect(() =>
      markRepaymentUsdcDeposited(converted, {
        transactionSignature: "sig",
        finalizedSlot: "123",
        sourceTokenAccount: WALLET,
        destinationTokenAccount: REPAYMENT_VAULT,
        amountBaseUnits: "33000000",
        recordedAt: NOW,
      }),
    ).toThrow(/registered issuer treasury/);
    expect(() =>
      markRepaymentUsdcDeposited(converted, {
        transactionSignature: "sig",
        finalizedSlot: "123",
        sourceTokenAccount: TREASURY_ATA,
        destinationTokenAccount: REPAYMENT_VAULT,
        amountBaseUnits: "32999999",
        recordedAt: NOW,
      }),
    ).toThrow(/must equal the USDC acquired/);
  });
});
