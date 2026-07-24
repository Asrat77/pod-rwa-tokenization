import { describe, expect, it } from "vitest";

import {
  baseUnits,
  validateDealV1,
  validateIssuerBeneficiarySeparation,
  validateEligibilityV1,
  validateInvestorPositionV1,
  validateMilestonesV1,
  validateSettlementV1,
  validateSeriesV1,
  type DealV1,
  type ReleaseMilestoneV1,
  type SeriesV1,
} from "../src/index.js";
import { commitment, OTHER_WALLET, PROGRAM_ID, WALLET } from "./helpers.js";

function validDeal(): DealV1 {
  return {
    schemaVersion: 1,
    id: "deal-006",
    state: "DRAFT",
    issuer: {
      kind: "ISSUER",
      entityReference: "us-corp-issuer",
      jurisdiction: "US",
      legalNameCommitment: commitment("issuer-name"),
    },
    servicer: {
      kind: "SERVICER",
      entityReference: "us-corp-issuer",
    },
    fiatBeneficiary: {
      kind: "FIAT_BENEFICIARY",
      entityReference: "international-beneficiary-006",
      jurisdiction: "ET",
      bankRouteCommitment: commitment("bank-route"),
      financingContractCommitment: commitment("financing-contract"),
    },
    mseDestination: {
      kind: "SQUADS_FIAT_FORWARD",
      entityReference: "us-corp-issuer",
      squadsMultisig: WALLET,
      squadsVaultIndex: 0,
      squadsVaultPda: OTHER_WALLET,
      walletOwner: OTHER_WALLET,
      usdcAta: PROGRAM_ID,
    },
    assetSetCommitment: commitment("asset-set"),
    legalDocumentCommitment: commitment("legal-doc"),
    valuationCommitment: commitment("valuation"),
    compliancePolicyCommitment: commitment("compliance"),
    fiatRouteCommitment: commitment("fiat-route"),
    settlementAsset: {
      symbol: "USDC",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: 6,
    },
    minimumRaiseBaseUnits: baseUnits("20000000"),
    hardCapBaseUnits: baseUnits("30000000"),
    perInvestorCapBaseUnits: baseUnits("15000000"),
    couponBps: 1_000,
    feesBps: 0,
    subscriptionOpensAt: "2026-08-01T00:00:00.000Z",
    subscriptionClosesAt: "2026-08-08T00:00:00.000Z",
    maturityAt: "2026-08-22T00:00:00.000Z",
    claimDeadline: "2026-09-22T00:00:00.000Z",
  };
}

describe("deal domain validation", () => {
  it("accepts a US issuer-owned treasury and a distinct fiat beneficiary", () => {
    expect(validateDealV1(validDeal())).toMatchObject({
      id: "deal-006",
      issuer: { kind: "ISSUER" },
      fiatBeneficiary: { kind: "FIAT_BENEFICIARY" },
    });
  });

  it("rejects attempts to model the issuer treasury as the fiat beneficiary", () => {
    const deal = validDeal();
    expect(() =>
      validateIssuerBeneficiarySeparation(
        deal.issuer,
        deal.servicer,
        deal.mseDestination,
        {
          ...deal.fiatBeneficiary!,
          entityReference: "US-CORP-ISSUER",
        },
      ),
    ).toThrow(/legally distinct/);
  });

  it("requires the V1 issuer to own treasury and service the deal", () => {
    const deal = validDeal();
    expect(() =>
      validateIssuerBeneficiarySeparation(
        deal.issuer,
        { ...deal.servicer, entityReference: "unregistered-servicer" },
        deal.mseDestination,
        deal.fiatBeneficiary,
      ),
    ).toThrow(/registered servicer/);
    expect(() =>
      validateIssuerBeneficiarySeparation(
        deal.issuer,
        deal.servicer,
        {
          ...deal.mseDestination,
          entityReference: "international-beneficiary-006",
        },
        deal.fiatBeneficiary,
      ),
    ).toThrow(/issuer must own/);
  });

  it("rejects an inverted deal timeline or invalid funding caps", () => {
    const deal = validDeal();
    expect(() =>
      validateDealV1({
        ...deal,
        minimumRaiseBaseUnits: baseUnits("30000001"),
      }),
    ).toThrow(/minimum raise/);
    expect(() =>
      validateDealV1({
        ...deal,
        maturityAt: "2026-08-07T00:00:00.000Z",
      }),
    ).toThrow(/timestamps must be ordered/);
  });
});

describe("series and milestone domain validation", () => {
  it("validates the durable senior-series shape", () => {
    const series: SeriesV1 = {
      schemaVersion: 1,
      id: "series-006-senior",
      dealId: "deal-006",
      rank: "SENIOR",
      receiptMint: WALLET,
      compliancePolicyCommitment: commitment("policy"),
      fundedPrincipalBaseUnits: baseUnits("30000000"),
      receiptSupplyBaseUnits: baseUnits("30000000"),
      mintAuthorityRevoked: true,
    };
    expect(validateSeriesV1(series)).toBe(series);
  });

  it("requires contiguous milestones that conserve all funded capital", () => {
    const milestones: ReleaseMilestoneV1[] = [
      {
        schemaVersion: 1,
        dealId: "deal-006",
        index: 0,
        gate: "CAPITAL_CLOSE",
        allocationBps: 3_000,
        amountBaseUnits: baseUnits("9000000"),
        status: "PENDING",
      },
      {
        schemaVersion: 1,
        dealId: "deal-006",
        index: 1,
        gate: "T1_PASS",
        allocationBps: 3_000,
        amountBaseUnits: baseUnits("9000000"),
        status: "PENDING",
      },
      {
        schemaVersion: 1,
        dealId: "deal-006",
        index: 2,
        gate: "T2_PASS",
        allocationBps: 3_000,
        amountBaseUnits: baseUnits("9000000"),
        status: "PENDING",
      },
      {
        schemaVersion: 1,
        dealId: "deal-006",
        index: 3,
        gate: "T3_PASS",
        allocationBps: 1_000,
        amountBaseUnits: baseUnits("3000000"),
        status: "PENDING",
      },
    ];
    expect(validateMilestonesV1(milestones, baseUnits("30000000"))).toBe(
      milestones,
    );
    expect(() =>
      validateMilestonesV1(
        milestones.map((item, index) =>
          index === 3
            ? { ...item, amountBaseUnits: baseUnits("2999999") }
            : item,
        ),
        baseUnits("30000000"),
      ),
    ).toThrow(/conserve/);
  });
});

describe("eligibility, position, and settlement invariants", () => {
  it("validates identity-scoped eligibility and conserves receipt positions", () => {
    expect(
      validateEligibilityV1({
        schemaVersion: 1,
        investorReference: "investor-reference-001",
        walletAddress: WALLET,
        seriesId: "series-006-senior",
        status: "ACTIVE",
        investorCapBaseUnits: baseUnits("15000000"),
        acceptedTermsCommitment: commitment("accepted-terms"),
        policyVersion: 1,
        providerReference: "compliance-provider-001",
        expiresAt: "2027-07-23T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "ACTIVE" });
    expect(
      validateInvestorPositionV1({
        schemaVersion: 1,
        dealId: "deal-006",
        seriesId: "series-006-senior",
        investorReference: "investor-reference-001",
        walletAddress: WALLET,
        subscribedPrincipalBaseUnits: baseUnits("15000000"),
        refundedPrincipalBaseUnits: baseUnits("0"),
        transferredInReceiptBaseUnits: baseUnits("2000000"),
        transferredOutReceiptBaseUnits: baseUnits("3000000"),
        receiptBalanceBaseUnits: baseUnits("9000000"),
        redeemedReceiptBaseUnits: baseUnits("5000000"),
        payoutBaseUnits: baseUnits("5500000"),
      }),
    ).toMatchObject({ receiptBalanceBaseUnits: "9000000" });
  });

  it("rejects a position that creates receipts or a default that pays issuer residual", () => {
    expect(() =>
      validateInvestorPositionV1({
        schemaVersion: 1,
        dealId: "deal-006",
        seriesId: "series-006-senior",
        investorReference: "investor-reference-001",
        walletAddress: WALLET,
        subscribedPrincipalBaseUnits: baseUnits("15000000"),
        refundedPrincipalBaseUnits: baseUnits("0"),
        transferredInReceiptBaseUnits: baseUnits("0"),
        transferredOutReceiptBaseUnits: baseUnits("0"),
        receiptBalanceBaseUnits: baseUnits("15000001"),
        redeemedReceiptBaseUnits: baseUnits("0"),
        payoutBaseUnits: baseUnits("0"),
      }),
    ).toThrow(/conserve/);
    expect(() =>
      validateSettlementV1({
        schemaVersion: 1,
        dealId: "deal-006",
        outcome: "DEFAULT",
        principalSnapshotBaseUnits: baseUnits("30000000"),
        receiptSupplySnapshotBaseUnits: baseUnits("30000000"),
        actualVaultBalanceBaseUnits: baseUnits("24000001"),
        investorPoolBaseUnits: baseUnits("24000000"),
        couponPoolBaseUnits: baseUnits("0"),
        feePoolBaseUnits: baseUnits("0"),
        issuerResidualBaseUnits: baseUnits("1"),
        finalizedAt: "2026-08-22T00:00:00.000Z",
        claimDeadline: "2026-09-22T00:00:00.000Z",
      }),
    ).toThrow(/cannot pay fees or issuer residual/);
  });

  it("validates an exactly conserved full settlement snapshot", () => {
    expect(
      validateSettlementV1({
        schemaVersion: 1,
        dealId: "deal-006",
        outcome: "FULL_REPAYMENT",
        principalSnapshotBaseUnits: baseUnits("30000000"),
        receiptSupplySnapshotBaseUnits: baseUnits("30000000"),
        actualVaultBalanceBaseUnits: baseUnits("33000000"),
        investorPoolBaseUnits: baseUnits("33000000"),
        couponPoolBaseUnits: baseUnits("3000000"),
        feePoolBaseUnits: baseUnits("0"),
        issuerResidualBaseUnits: baseUnits("0"),
        finalizedAt: "2026-08-22T00:00:00.000Z",
        claimDeadline: "2026-09-22T00:00:00.000Z",
      }),
    ).toMatchObject({ outcome: "FULL_REPAYMENT" });
  });
});
