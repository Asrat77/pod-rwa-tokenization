import { invariant } from "./errors.js";
import {
  baseUnits,
  parseBaseUnits,
  validateBasisPoints,
  type BaseUnitString,
} from "./money.js";
import {
  SOLANA_LEGACY_TOKEN_PROGRAM_ID,
  validateSolanaPublicKey,
} from "./manifest.js";

export type IsoTimestamp = string;
export type EntityReference = string;
export type ContentCommitment = `sha256:${string}`;

export interface IssuerV1 {
  readonly kind: "ISSUER";
  readonly entityReference: EntityReference;
  readonly jurisdiction: string;
  readonly legalNameCommitment: ContentCommitment;
}

export interface ServicerV1 {
  readonly kind: "SERVICER";
  readonly entityReference: EntityReference;
}

export interface FiatBeneficiaryV1 {
  readonly kind: "FIAT_BENEFICIARY";
  readonly entityReference: EntityReference;
  readonly jurisdiction: string;
  readonly bankRouteCommitment: ContentCommitment;
  readonly financingContractCommitment: ContentCommitment;
}

export interface TreasuryRouteV1 {
  readonly kind: "ISSUER_TREASURY";
  readonly ownerEntityReference: EntityReference;
  readonly squadsMultisig: string;
  readonly squadsVaultIndex: number;
  readonly squadsVaultPda: string;
  readonly usdcAta: string;
}

export interface SettlementAssetV1 {
  readonly symbol: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly decimals: number;
}

export type DealStateV1 =
  | "DRAFT"
  | "SUBSCRIPTION_OPEN"
  | "FUNDED"
  | "ACTIVE"
  | "REPAID"
  | "DEFAULT_RECOVERY"
  | "REDEEMABLE"
  | "CANCELLED_REFUNDABLE"
  | "SETTLED";

export interface DealV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly state: DealStateV1;
  readonly issuer: IssuerV1;
  readonly servicer: ServicerV1;
  readonly fiatBeneficiary: FiatBeneficiaryV1;
  readonly treasuryRoute: TreasuryRouteV1;
  readonly assetSetCommitment: ContentCommitment;
  readonly legalDocumentCommitment: ContentCommitment;
  readonly valuationCommitment: ContentCommitment;
  readonly compliancePolicyCommitment: ContentCommitment;
  readonly fiatRouteCommitment: ContentCommitment;
  readonly settlementAsset: SettlementAssetV1;
  readonly minimumRaiseBaseUnits: BaseUnitString;
  readonly hardCapBaseUnits: BaseUnitString;
  readonly perInvestorCapBaseUnits: BaseUnitString;
  readonly couponBps: number;
  readonly feesBps: number;
  readonly subscriptionOpensAt: IsoTimestamp;
  readonly subscriptionClosesAt: IsoTimestamp;
  readonly maturityAt: IsoTimestamp;
  readonly claimDeadline: IsoTimestamp;
}

export interface SeriesV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly dealId: string;
  readonly rank: "SENIOR";
  readonly receiptMint: string;
  readonly compliancePolicyCommitment: ContentCommitment;
  readonly fundedPrincipalBaseUnits: BaseUnitString;
  readonly receiptSupplyBaseUnits: BaseUnitString;
  readonly mintAuthorityRevoked: boolean;
}

export type MilestoneGateV1 =
  | "CAPITAL_CLOSE"
  | "T1_PASS"
  | "T2_PASS"
  | "T3_PASS";

export type MilestoneStatusV1 =
  | "PENDING"
  | "SCHEDULED"
  | "RELEASED"
  | "CANCELLED";

export interface ReleaseMilestoneV1 {
  readonly schemaVersion: 1;
  readonly dealId: string;
  readonly index: number;
  readonly gate: MilestoneGateV1;
  readonly allocationBps: number;
  readonly amountBaseUnits: BaseUnitString;
  readonly status: MilestoneStatusV1;
  readonly gateRevisionCommitment?: ContentCommitment;
  readonly executeAfter?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export type EligibilityStatusV1 =
  | "ACTIVE"
  | "SUSPENDED"
  | "EXPIRED"
  | "REVOKED"
  | "SANCTIONS_HOLD";

export interface EligibilityV1 {
  readonly schemaVersion: 1;
  readonly investorReference: EntityReference;
  readonly walletAddress: string;
  readonly seriesId: string;
  readonly status: EligibilityStatusV1;
  readonly investorCapBaseUnits: BaseUnitString;
  readonly acceptedTermsCommitment: ContentCommitment;
  readonly policyVersion: number;
  readonly providerReference: EntityReference;
  readonly expiresAt: IsoTimestamp;
}

export interface InvestorPositionV1 {
  readonly schemaVersion: 1;
  readonly dealId: string;
  readonly seriesId: string;
  readonly investorReference: EntityReference;
  readonly walletAddress: string;
  readonly subscribedPrincipalBaseUnits: BaseUnitString;
  readonly refundedPrincipalBaseUnits: BaseUnitString;
  readonly transferredInReceiptBaseUnits: BaseUnitString;
  readonly transferredOutReceiptBaseUnits: BaseUnitString;
  readonly receiptBalanceBaseUnits: BaseUnitString;
  readonly redeemedReceiptBaseUnits: BaseUnitString;
  readonly payoutBaseUnits: BaseUnitString;
}

export type SettlementOutcomeV1 = "FULL_REPAYMENT" | "DEFAULT";

export interface SettlementV1 {
  readonly schemaVersion: 1;
  readonly dealId: string;
  readonly outcome: SettlementOutcomeV1;
  readonly principalSnapshotBaseUnits: BaseUnitString;
  readonly receiptSupplySnapshotBaseUnits: BaseUnitString;
  readonly actualVaultBalanceBaseUnits: BaseUnitString;
  readonly investorPoolBaseUnits: BaseUnitString;
  readonly couponPoolBaseUnits: BaseUnitString;
  readonly feePoolBaseUnits: BaseUnitString;
  readonly issuerResidualBaseUnits: BaseUnitString;
  readonly finalizedAt: IsoTimestamp;
  readonly claimDeadline: IsoTimestamp;
}

const COMMITMENT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function validateContentCommitment(
  value: string,
  field: string,
): asserts value is ContentCommitment {
  invariant(
    COMMITMENT_PATTERN.test(value),
    "INVALID_ARGUMENT",
    `${field} must be a lowercase SHA-256 commitment`,
    { field, value },
  );
}

export function validateIsoTimestamp(value: string, field: string): Date {
  const date = new Date(value);
  invariant(
    !Number.isNaN(date.getTime()) && date.toISOString() === value,
    "INVALID_ARGUMENT",
    `${field} must be an ISO-8601 UTC timestamp`,
    { field, value },
  );
  return date;
}

function validateEntityReference(value: string, field: string): void {
  invariant(
    value.trim().length >= 3 && value === value.trim(),
    "INVALID_ARGUMENT",
    `${field} must be a non-empty canonical opaque reference`,
    { field },
  );
}

function canonicalPartyReference(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/**
 * Enforces the legal/operational boundary that the US issuer owns the on-chain
 * treasury while the international party is only the fiat beneficiary.
 */
export function validateIssuerBeneficiarySeparation(
  issuer: IssuerV1,
  servicer: ServicerV1,
  treasury: TreasuryRouteV1,
  fiatBeneficiary: FiatBeneficiaryV1,
): void {
  validateEntityReference(issuer.entityReference, "issuer.entityReference");
  validateEntityReference(servicer.entityReference, "servicer.entityReference");
  validateEntityReference(
    treasury.ownerEntityReference,
    "treasuryRoute.ownerEntityReference",
  );
  validateEntityReference(
    fiatBeneficiary.entityReference,
    "fiatBeneficiary.entityReference",
  );

  const issuerReference = canonicalPartyReference(issuer.entityReference);
  const servicerReference = canonicalPartyReference(servicer.entityReference);
  const treasuryOwner = canonicalPartyReference(treasury.ownerEntityReference);
  const beneficiaryReference = canonicalPartyReference(
    fiatBeneficiary.entityReference,
  );

  invariant(
    treasuryOwner === issuerReference,
    "INVALID_PARTY_CONFIGURATION",
    "the issuer must own the configured on-chain treasury route",
  );
  invariant(
    servicerReference === issuerReference,
    "INVALID_PARTY_CONFIGURATION",
    "V1 requires the issuer to be the registered servicer",
  );
  invariant(
    beneficiaryReference !== issuerReference &&
      beneficiaryReference !== treasuryOwner &&
      beneficiaryReference !== servicerReference,
    "INVALID_PARTY_CONFIGURATION",
    "the fiat beneficiary must be legally distinct from the issuer treasury and servicer",
  );
}

export function validateDealV1(deal: DealV1): DealV1 {
  invariant(
    deal.schemaVersion === 1,
    "INVALID_ARGUMENT",
    "deal schemaVersion must be 1",
  );
  invariant(deal.id.trim().length > 0, "INVALID_ARGUMENT", "deal id is required");
  invariant(
    (
      [
        "DRAFT",
        "SUBSCRIPTION_OPEN",
        "FUNDED",
        "ACTIVE",
        "REPAID",
        "DEFAULT_RECOVERY",
        "REDEEMABLE",
        "CANCELLED_REFUNDABLE",
        "SETTLED",
      ] as const
    ).includes(deal.state),
    "INVALID_ARGUMENT",
    "deal state is unsupported",
  );
  validateIssuerBeneficiarySeparation(
    deal.issuer,
    deal.servicer,
    deal.treasuryRoute,
    deal.fiatBeneficiary,
  );

  validateContentCommitment(
    deal.issuer.legalNameCommitment,
    "issuer.legalNameCommitment",
  );
  validateContentCommitment(
    deal.fiatBeneficiary.bankRouteCommitment,
    "fiatBeneficiary.bankRouteCommitment",
  );
  validateContentCommitment(
    deal.fiatBeneficiary.financingContractCommitment,
    "fiatBeneficiary.financingContractCommitment",
  );
  validateContentCommitment(deal.assetSetCommitment, "assetSetCommitment");
  validateContentCommitment(
    deal.legalDocumentCommitment,
    "legalDocumentCommitment",
  );
  validateContentCommitment(deal.valuationCommitment, "valuationCommitment");
  validateContentCommitment(
    deal.compliancePolicyCommitment,
    "compliancePolicyCommitment",
  );
  validateContentCommitment(deal.fiatRouteCommitment, "fiatRouteCommitment");
  invariant(
    deal.issuer.kind === "ISSUER" &&
      deal.servicer.kind === "SERVICER" &&
      deal.fiatBeneficiary.kind === "FIAT_BENEFICIARY" &&
      deal.treasuryRoute.kind === "ISSUER_TREASURY",
    "INVALID_PARTY_CONFIGURATION",
    "deal parties must use their explicit V1 legal roles",
  );
  invariant(
    deal.issuer.jurisdiction === "US",
    "INVALID_PARTY_CONFIGURATION",
    "the V1 token issuer must be a US entity",
  );
  invariant(
    /^[A-Z]{2}$/.test(deal.fiatBeneficiary.jurisdiction) &&
      deal.fiatBeneficiary.jurisdiction !== "US",
    "INVALID_PARTY_CONFIGURATION",
    "the V1 fiat beneficiary must use a non-US ISO jurisdiction",
  );
  invariant(
    Number.isSafeInteger(deal.treasuryRoute.squadsVaultIndex) &&
      deal.treasuryRoute.squadsVaultIndex >= 0,
    "INVALID_ARGUMENT",
    "Squads vault index must be a non-negative integer",
  );
  validateSolanaPublicKey(
    deal.treasuryRoute.squadsMultisig,
    "treasuryRoute.squadsMultisig",
  );
  validateSolanaPublicKey(
    deal.treasuryRoute.squadsVaultPda,
    "treasuryRoute.squadsVaultPda",
  );
  validateSolanaPublicKey(
    deal.treasuryRoute.usdcAta,
    "treasuryRoute.usdcAta",
  );
  validateSolanaPublicKey(
    deal.settlementAsset.mint,
    "settlementAsset.mint",
  );
  validateSolanaPublicKey(
    deal.settlementAsset.tokenProgram,
    "settlementAsset.tokenProgram",
  );
  const treasuryAddresses = [
    deal.treasuryRoute.squadsMultisig,
    deal.treasuryRoute.squadsVaultPda,
    deal.treasuryRoute.usdcAta,
  ];
  invariant(
    new Set(treasuryAddresses).size === treasuryAddresses.length,
    "INVALID_PARTY_CONFIGURATION",
    "Squads multisig, treasury vault PDA, and treasury USDC ATA must be distinct",
  );

  const minimumRaise = parseBaseUnits(
    deal.minimumRaiseBaseUnits,
    "minimumRaiseBaseUnits",
  );
  const hardCap = parseBaseUnits(deal.hardCapBaseUnits, "hardCapBaseUnits");
  const investorCap = parseBaseUnits(
    deal.perInvestorCapBaseUnits,
    "perInvestorCapBaseUnits",
  );
  invariant(
    minimumRaise > 0n && minimumRaise <= hardCap,
    "INVALID_ARGUMENT",
    "minimum raise must be positive and no greater than the hard cap",
  );
  invariant(
    investorCap > 0n && investorCap <= hardCap,
    "INVALID_ARGUMENT",
    "per-investor cap must be positive and no greater than the hard cap",
  );
  validateBasisPoints(deal.couponBps, "couponBps");
  validateBasisPoints(deal.feesBps, "feesBps");

  invariant(
    deal.settlementAsset.symbol === "USDC" &&
      deal.settlementAsset.decimals === 6 &&
      deal.settlementAsset.tokenProgram ===
        SOLANA_LEGACY_TOKEN_PROGRAM_ID,
    "INVALID_ARGUMENT",
    "V1 deals must settle in six-decimal legacy-token USDC",
  );
  invariant(
    deal.settlementAsset.mint !== deal.fiatBeneficiary.entityReference,
    "INVALID_PARTY_CONFIGURATION",
    "a fiat beneficiary reference cannot be used as a settlement mint",
  );

  const opens = validateIsoTimestamp(
    deal.subscriptionOpensAt,
    "subscriptionOpensAt",
  );
  const closes = validateIsoTimestamp(
    deal.subscriptionClosesAt,
    "subscriptionClosesAt",
  );
  const maturity = validateIsoTimestamp(deal.maturityAt, "maturityAt");
  const claimDeadline = validateIsoTimestamp(
    deal.claimDeadline,
    "claimDeadline",
  );
  invariant(
    opens < closes && closes < maturity && maturity < claimDeadline,
    "INVALID_ARGUMENT",
    "deal timestamps must be ordered open, close, maturity, claim deadline",
  );
  return deal;
}

export function validateSeriesV1(series: SeriesV1): SeriesV1 {
  invariant(
    series.schemaVersion === 1 && series.rank === "SENIOR",
    "INVALID_ARGUMENT",
    "V1 supports only schema version 1 senior series",
  );
  baseUnits(series.fundedPrincipalBaseUnits, "fundedPrincipalBaseUnits");
  baseUnits(series.receiptSupplyBaseUnits, "receiptSupplyBaseUnits");
  invariant(
    series.fundedPrincipalBaseUnits === series.receiptSupplyBaseUnits,
    "INVARIANT_VIOLATION",
    "V1 receipt supply must equal funded principal base units",
  );
  validateSolanaPublicKey(series.receiptMint, "receiptMint");
  validateContentCommitment(
    series.compliancePolicyCommitment,
    "compliancePolicyCommitment",
  );
  return series;
}

export function validateMilestonesV1(
  milestones: readonly ReleaseMilestoneV1[],
  fundedCapital: BaseUnitString,
): readonly ReleaseMilestoneV1[] {
  invariant(
    milestones.length > 0,
    "INVALID_ARGUMENT",
    "at least one release milestone is required",
  );
  let totalBps = 0;
  let totalAmount = 0n;
  const seenGates = new Set<MilestoneGateV1>();
  const dealId = milestones[0]?.dealId;
  for (const [expectedIndex, milestone] of milestones.entries()) {
    invariant(
      milestone.schemaVersion === 1 && milestone.index === expectedIndex,
      "INVALID_ARGUMENT",
      "milestone indexes must be contiguous and zero-based",
    );
    invariant(
      milestone.dealId === dealId,
      "INVALID_ARGUMENT",
      "all release milestones must belong to the same deal",
    );
    invariant(
      (
        ["CAPITAL_CLOSE", "T1_PASS", "T2_PASS", "T3_PASS"] as const
      ).includes(milestone.gate),
      "INVALID_ARGUMENT",
      "release milestone gate is unsupported",
    );
    invariant(
      (
        ["PENDING", "SCHEDULED", "RELEASED", "CANCELLED"] as const
      ).includes(milestone.status),
      "INVALID_ARGUMENT",
      "release milestone status is unsupported",
    );
    const allocationBps = validateBasisPoints(
      milestone.allocationBps,
      `milestones[${expectedIndex}].allocationBps`,
    );
    invariant(
      allocationBps > 0,
      "INVALID_ARGUMENT",
      "milestone allocation must be greater than zero",
    );
    totalBps += allocationBps;
    invariant(
      !seenGates.has(milestone.gate),
      "INVALID_ARGUMENT",
      "a release gate cannot appear more than once",
      { gate: milestone.gate },
    );
    seenGates.add(milestone.gate);
    totalAmount += parseBaseUnits(
      milestone.amountBaseUnits,
      `milestones[${expectedIndex}].amountBaseUnits`,
    );
  }
  invariant(
    totalBps === 10_000,
    "INVARIANT_VIOLATION",
    "milestone allocations must total exactly 10,000 basis points",
    { totalBps },
  );
  invariant(
    totalAmount === parseBaseUnits(fundedCapital),
    "INVARIANT_VIOLATION",
    "milestone amounts must conserve funded capital",
    {
      fundedCapital,
      milestoneTotal: totalAmount.toString(10),
    },
  );
  invariant(
    milestones[0]?.gate === "CAPITAL_CLOSE",
    "INVALID_ARGUMENT",
    "the first release milestone must be the capital-close advance",
  );
  return milestones;
}

export function validateEligibilityV1(
  eligibility: EligibilityV1,
): EligibilityV1 {
  invariant(
    eligibility.schemaVersion === 1,
    "INVALID_ARGUMENT",
    "eligibility schemaVersion must be 1",
  );
  validateEntityReference(
    eligibility.investorReference,
    "investorReference",
  );
  validateEntityReference(
    eligibility.providerReference,
    "providerReference",
  );
  validateSolanaPublicKey(eligibility.walletAddress, "walletAddress");
  invariant(
    (
      [
        "ACTIVE",
        "SUSPENDED",
        "EXPIRED",
        "REVOKED",
        "SANCTIONS_HOLD",
      ] as const
    ).includes(eligibility.status),
    "INVALID_ARGUMENT",
    "eligibility status is unsupported",
  );
  invariant(
    parseBaseUnits(eligibility.investorCapBaseUnits) > 0n,
    "INVALID_AMOUNT",
    "investor cap must be greater than zero",
  );
  validateContentCommitment(
    eligibility.acceptedTermsCommitment,
    "acceptedTermsCommitment",
  );
  invariant(
    Number.isSafeInteger(eligibility.policyVersion) &&
      eligibility.policyVersion > 0,
    "INVALID_ARGUMENT",
    "policyVersion must be a positive integer",
  );
  validateIsoTimestamp(eligibility.expiresAt, "expiresAt");
  return eligibility;
}

export function validateInvestorPositionV1(
  position: InvestorPositionV1,
): InvestorPositionV1 {
  invariant(
    position.schemaVersion === 1,
    "INVALID_ARGUMENT",
    "position schemaVersion must be 1",
  );
  validateEntityReference(position.investorReference, "investorReference");
  validateSolanaPublicKey(position.walletAddress, "walletAddress");
  const subscribed = parseBaseUnits(
    position.subscribedPrincipalBaseUnits,
    "subscribedPrincipalBaseUnits",
  );
  const refunded = parseBaseUnits(
    position.refundedPrincipalBaseUnits,
    "refundedPrincipalBaseUnits",
  );
  const transferredIn = parseBaseUnits(
    position.transferredInReceiptBaseUnits,
    "transferredInReceiptBaseUnits",
  );
  const transferredOut = parseBaseUnits(
    position.transferredOutReceiptBaseUnits,
    "transferredOutReceiptBaseUnits",
  );
  const receipt = parseBaseUnits(
    position.receiptBalanceBaseUnits,
    "receiptBalanceBaseUnits",
  );
  const redeemed = parseBaseUnits(
    position.redeemedReceiptBaseUnits,
    "redeemedReceiptBaseUnits",
  );
  baseUnits(position.payoutBaseUnits, "payoutBaseUnits");
  invariant(
    refunded <= subscribed &&
      receipt + redeemed + transferredOut ===
        subscribed - refunded + transferredIn,
    "INVARIANT_VIOLATION",
    "position receipts, refunds, redemptions, and policy transfers must conserve supply",
  );
  return position;
}

export function validateSettlementV1(
  settlement: SettlementV1,
): SettlementV1 {
  invariant(
    settlement.schemaVersion === 1,
    "INVALID_ARGUMENT",
    "settlement schemaVersion must be 1",
  );
  invariant(
    settlement.outcome === "FULL_REPAYMENT" ||
      settlement.outcome === "DEFAULT",
    "INVALID_ARGUMENT",
    "settlement outcome is unsupported",
  );
  const principal = parseBaseUnits(
    settlement.principalSnapshotBaseUnits,
    "principalSnapshotBaseUnits",
  );
  const supply = parseBaseUnits(
    settlement.receiptSupplySnapshotBaseUnits,
    "receiptSupplySnapshotBaseUnits",
  );
  const actual = parseBaseUnits(
    settlement.actualVaultBalanceBaseUnits,
    "actualVaultBalanceBaseUnits",
  );
  const investorPool = parseBaseUnits(
    settlement.investorPoolBaseUnits,
    "investorPoolBaseUnits",
  );
  const couponPool = parseBaseUnits(
    settlement.couponPoolBaseUnits,
    "couponPoolBaseUnits",
  );
  const feePool = parseBaseUnits(
    settlement.feePoolBaseUnits,
    "feePoolBaseUnits",
  );
  const residual = parseBaseUnits(
    settlement.issuerResidualBaseUnits,
    "issuerResidualBaseUnits",
  );
  invariant(
    principal > 0n && supply === principal,
    "INVARIANT_VIOLATION",
    "settlement receipt supply must equal the principal snapshot",
  );
  invariant(
    couponPool <= investorPool &&
      investorPool - couponPool <= principal &&
      actual === investorPool + feePool + residual,
    "INVARIANT_VIOLATION",
    "settlement pools must conserve the actual repayment balance",
  );
  if (settlement.outcome === "DEFAULT") {
    invariant(
      feePool === 0n && residual === 0n,
      "INVARIANT_VIOLATION",
      "a default cannot pay fees or issuer residual ahead of investors",
    );
  }
  const finalized = validateIsoTimestamp(
    settlement.finalizedAt,
    "finalizedAt",
  );
  const claimDeadline = validateIsoTimestamp(
    settlement.claimDeadline,
    "claimDeadline",
  );
  invariant(
    claimDeadline > finalized,
    "INVALID_ARGUMENT",
    "settlement claim deadline must follow finalization",
  );
  return settlement;
}
