import {
  validateContentCommitment,
  validateIsoTimestamp,
  type ContentCommitment,
  type EntityReference,
  type IsoTimestamp,
  type MseRailKindV1,
} from "./domain.js";
import { invariant } from "./errors.js";
import {
  createEvidenceCommitment,
  EVIDENCE_DOMAINS,
  type EvidenceValue,
} from "./evidence.js";
import {
  baseUnits,
  parseBaseUnits,
  type BaseUnitInput,
  type BaseUnitString,
} from "./money.js";
import { validateSolanaPublicKey } from "./manifest.js";

export type TreasuryApprovalRole = "TREASURY" | "RISK";

export interface TreasuryApprovalV1 {
  readonly role: TreasuryApprovalRole;
  readonly approvedBy: string;
  readonly approvedAt: IsoTimestamp;
}

export type FiatDisbursementStatusV1 =
  | "PROPOSED"
  | "APPROVED"
  | "USDC_RELEASED"
  | "CONVERTED"
  | "SWIFT_SENT"
  | "BANK_CONFIRMED"
  | "RECONCILED"
  | "FAILED"
  | "RETURNED";

export interface OnchainTransferEvidenceV1 {
  readonly transactionSignature: string;
  readonly finalizedSlot: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly amountBaseUnits: BaseUnitString;
  readonly recordedAt: IsoTimestamp;
}

export interface ConversionEvidenceV1 {
  readonly providerReferenceCommitment: ContentCommitment;
  readonly grossUsdMinorUnits: BaseUnitString;
  readonly providerFeesUsdMinorUnits: BaseUnitString;
  readonly netUsdMinorUnits: BaseUnitString;
  readonly rateUsdMinorUnitsNumerator: BaseUnitString;
  readonly rateUsdcBaseUnitsDenominator: BaseUnitString;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface SwiftEvidenceV1 {
  readonly grossUsdMinorUnits: BaseUnitString;
  readonly bankFeesUsdMinorUnits: BaseUnitString;
  readonly netUsdMinorUnits: BaseUnitString;
  readonly uetrCommitment: ContentCommitment;
  readonly valueDate: string;
  readonly sendingEvidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface BankConfirmationV1 {
  readonly confirmationEvidenceCommitment: ContentCommitment;
  readonly reviewedBy: string;
  readonly confirmedAt: IsoTimestamp;
}

export interface ReconciliationEvidenceV1 {
  readonly evidenceCommitment: ContentCommitment;
  readonly reconciledBy: string;
  readonly reconciledAt: IsoTimestamp;
}

export interface RailExceptionV1 {
  readonly previousStatus: FiatDisbursementStatusV1;
  readonly reasonCode: string;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface FiatDisbursementV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly dealId: string;
  readonly milestoneIndex: number;
  readonly status: FiatDisbursementStatusV1;
  readonly railKind: MseRailKindV1;
  readonly issuerEntityReference: EntityReference;
  readonly mseBeneficiaryEntityReference: EntityReference;
  /** Required in V1 for the international MSE's approved bank route. */
  readonly beneficiaryBankRouteCommitment?: ContentCommitment;
  readonly mseUsdcAta: string;
  readonly releasedUsdcBaseUnits: BaseUnitString;
  readonly approvals: readonly TreasuryApprovalV1[];
  readonly proposedBy: string;
  readonly proposedAt: IsoTimestamp;
  readonly onchainRelease?: OnchainTransferEvidenceV1;
  readonly conversion?: ConversionEvidenceV1;
  readonly swift?: SwiftEvidenceV1;
  readonly bankConfirmation?: BankConfirmationV1;
  readonly reconciliation?: ReconciliationEvidenceV1;
  readonly exception?: RailExceptionV1;
}

export interface CreateFiatDisbursementInput {
  readonly id: string;
  readonly dealId: string;
  readonly milestoneIndex: number;
  readonly railKind: MseRailKindV1;
  readonly issuerEntityReference: EntityReference;
  readonly mseBeneficiaryEntityReference: EntityReference;
  readonly beneficiaryBankRouteCommitment?: ContentCommitment;
  readonly mseUsdcAta: string;
  readonly releasedUsdcBaseUnits: BaseUnitInput;
  readonly proposedBy: string;
  readonly proposedAt: IsoTimestamp;
}

export interface ApproveFiatDisbursementCommand {
  readonly role: TreasuryApprovalRole;
  readonly approvedBy: string;
  readonly approvedAt: IsoTimestamp;
}

export interface MarkUsdcReleasedCommand {
  readonly transactionSignature: string;
  readonly finalizedSlot: string;
  readonly sourceTokenAccount: string;
  readonly destinationTokenAccount: string;
  readonly amountBaseUnits: BaseUnitInput;
  readonly recordedAt: IsoTimestamp;
}

export type MarkRepaymentUsdcDepositedCommand = MarkUsdcReleasedCommand;

export interface RecordConversionCommand {
  readonly providerReferenceCommitment: ContentCommitment;
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly providerFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly rateUsdMinorUnitsNumerator: BaseUnitInput;
  readonly rateUsdcBaseUnitsDenominator: BaseUnitInput;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RecordSwiftSentCommand {
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly bankFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly uetrCommitment: ContentCommitment;
  readonly valueDate: string;
  readonly sendingEvidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RecordBankConfirmationCommand {
  readonly confirmationEvidenceCommitment: ContentCommitment;
  readonly reviewedBy: string;
  readonly confirmedAt: IsoTimestamp;
}

export interface ReconcileDisbursementCommand {
  readonly evidenceCommitment: ContentCommitment;
  readonly reconciledBy: string;
  readonly reconciledAt: IsoTimestamp;
}

export interface RecordRailExceptionCommand {
  readonly reasonCode: string;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

function canonicalEntityReference(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function requiredIdentifier(value: string, field: string): string {
  invariant(
    value.length > 0 && value === value.trim(),
    "INVALID_ARGUMENT",
    `${field} must be a canonical non-empty identifier`,
    { field },
  );
  return value;
}

function validateSlot(value: string): string {
  invariant(
    /^(0|[1-9][0-9]*)$/.test(value),
    "INVALID_ARGUMENT",
    "finalizedSlot must be a canonical unsigned integer string",
    { value },
  );
  return value;
}

function assertTimestampAtOrAfter(
  value: IsoTimestamp,
  earlier: IsoTimestamp,
  field: string,
): void {
  const currentDate = validateIsoTimestamp(value, field);
  const earlierDate = validateIsoTimestamp(earlier, "priorEventAt");
  invariant(
    currentDate >= earlierDate,
    "INVALID_STATE_TRANSITION",
    `${field} cannot precede the prior workflow event`,
    { value, priorEventAt: earlier },
  );
}

function assertDisbursementStatus(
  disbursement: FiatDisbursementV1,
  expected: readonly FiatDisbursementStatusV1[],
  operation: string,
): void {
  invariant(
    expected.includes(disbursement.status),
    "INVALID_STATE_TRANSITION",
    `${operation} is not allowed from ${disbursement.status}`,
    { expected, actual: disbursement.status },
  );
}

function validateUsdBreakdown(
  grossInput: BaseUnitInput,
  feesInput: BaseUnitInput,
  netInput: BaseUnitInput,
  field: string,
): {
  readonly gross: BaseUnitString;
  readonly fees: BaseUnitString;
  readonly net: BaseUnitString;
} {
  const gross = baseUnits(grossInput, `${field}.gross`);
  const fees = baseUnits(feesInput, `${field}.fees`);
  const net = baseUnits(netInput, `${field}.net`);
  invariant(
    parseBaseUnits(gross) === parseBaseUnits(fees) + parseBaseUnits(net),
    "INVARIANT_VIOLATION",
    `${field} gross must equal net plus explicit fees`,
    { gross, fees, net },
  );
  return { gross, fees, net };
}

export function createFiatDisbursement(
  input: CreateFiatDisbursementInput,
): FiatDisbursementV1 {
  requiredIdentifier(input.id, "id");
  requiredIdentifier(input.dealId, "dealId");
  invariant(
    Number.isSafeInteger(input.milestoneIndex) && input.milestoneIndex >= 0,
    "INVALID_ARGUMENT",
    "milestoneIndex must be a non-negative integer",
  );
  invariant(
    input.railKind === "SQUADS_FIAT_FORWARD",
    "INVALID_PARTY_CONFIGURATION",
    "RWA V1 supports only the US issuer Squads fiat-forward treasury rail",
  );
  requiredIdentifier(
    input.issuerEntityReference,
    "issuerEntityReference",
  );
  requiredIdentifier(
    input.mseBeneficiaryEntityReference,
    "mseBeneficiaryEntityReference",
  );
  invariant(
    canonicalEntityReference(input.issuerEntityReference) !==
      canonicalEntityReference(input.mseBeneficiaryEntityReference),
    "INVALID_PARTY_CONFIGURATION",
    "the US issuer and the MSE beneficiary must be distinct legal entities",
  );
  invariant(
    input.beneficiaryBankRouteCommitment !== undefined,
    "INVALID_ARGUMENT",
    "the Squads fiat-forward rail requires a beneficiary bank route commitment",
  );
  validateContentCommitment(
    input.beneficiaryBankRouteCommitment,
    "beneficiaryBankRouteCommitment",
  );
  validateSolanaPublicKey(input.mseUsdcAta, "mseUsdcAta");
  const amount = baseUnits(
    input.releasedUsdcBaseUnits,
    "releasedUsdcBaseUnits",
  );
  invariant(
    parseBaseUnits(amount) > 0n,
    "INVALID_AMOUNT",
    "released USDC must be greater than zero",
  );
  requiredIdentifier(input.proposedBy, "proposedBy");
  validateIsoTimestamp(input.proposedAt, "proposedAt");
  return {
    schemaVersion: 1,
    id: input.id,
    dealId: input.dealId,
    milestoneIndex: input.milestoneIndex,
    status: "PROPOSED",
    railKind: input.railKind,
    issuerEntityReference: input.issuerEntityReference,
    mseBeneficiaryEntityReference: input.mseBeneficiaryEntityReference,
    ...(input.beneficiaryBankRouteCommitment !== undefined
      ? { beneficiaryBankRouteCommitment: input.beneficiaryBankRouteCommitment }
      : {}),
    mseUsdcAta: input.mseUsdcAta,
    releasedUsdcBaseUnits: amount,
    approvals: [],
    proposedBy: input.proposedBy,
    proposedAt: input.proposedAt,
  };
}

export function approveFiatDisbursement(
  disbursement: FiatDisbursementV1,
  command: ApproveFiatDisbursementCommand,
): FiatDisbursementV1 {
  assertDisbursementStatus(disbursement, ["PROPOSED"], "approval");
  requiredIdentifier(command.approvedBy, "approvedBy");
  validateIsoTimestamp(command.approvedAt, "approvedAt");
  assertTimestampAtOrAfter(
    command.approvedAt,
    disbursement.proposedAt,
    "approvedAt",
  );
  invariant(
    command.role === "TREASURY" || command.role === "RISK",
    "INVALID_ARGUMENT",
    "approval role must be TREASURY or RISK",
  );
  invariant(
    !disbursement.approvals.some(
      (approval) => approval.role === command.role,
    ),
    "INVALID_STATE_TRANSITION",
    `${command.role} approval already exists`,
  );
  invariant(
    !disbursement.approvals.some(
      (approval) => approval.approvedBy === command.approvedBy,
    ),
    "INVALID_PARTY_CONFIGURATION",
    "treasury and risk approvals must be provided by different actors",
  );
  const approvals = [
    ...disbursement.approvals,
    {
      role: command.role,
      approvedBy: command.approvedBy,
      approvedAt: command.approvedAt,
    },
  ];
  return {
    ...disbursement,
    approvals,
    status: approvals.length === 2 ? "APPROVED" : "PROPOSED",
  };
}

export function markDisbursementUsdcReleased(
  disbursement: FiatDisbursementV1,
  command: MarkUsdcReleasedCommand,
): FiatDisbursementV1 {
  assertDisbursementStatus(
    disbursement,
    ["APPROVED"],
    "USDC release recording",
  );
  invariant(
    new Set(disbursement.approvals.map((approval) => approval.role)).size ===
      2,
    "INVARIANT_VIOLATION",
    "both treasury and risk approvals are required before release",
  );
  requiredIdentifier(command.transactionSignature, "transactionSignature");
  validateSlot(command.finalizedSlot);
  validateSolanaPublicKey(command.sourceTokenAccount, "sourceTokenAccount");
  validateSolanaPublicKey(
    command.destinationTokenAccount,
    "destinationTokenAccount",
  );
  invariant(
    command.destinationTokenAccount === disbursement.mseUsdcAta,
    "INVALID_PARTY_CONFIGURATION",
    "USDC must be released to the deal's locked US issuer treasury ATA",
  );
  const amount = baseUnits(command.amountBaseUnits, "amountBaseUnits");
  invariant(
    amount === disbursement.releasedUsdcBaseUnits,
    "INVARIANT_VIOLATION",
    "on-chain release amount must equal the approved disbursement amount",
  );
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  for (const approval of disbursement.approvals) {
    assertTimestampAtOrAfter(
      command.recordedAt,
      approval.approvedAt,
      "recordedAt",
    );
  }
  return {
    ...disbursement,
    status: "USDC_RELEASED",
    onchainRelease: {
      transactionSignature: command.transactionSignature,
      finalizedSlot: command.finalizedSlot,
      sourceTokenAccount: command.sourceTokenAccount,
      destinationTokenAccount: command.destinationTokenAccount,
      amountBaseUnits: amount,
      recordedAt: command.recordedAt,
    },
  };
}

export function recordDisbursementConversion(
  disbursement: FiatDisbursementV1,
  command: RecordConversionCommand,
): FiatDisbursementV1 {
  assertSquadsRail(disbursement, "conversion recording");
  assertDisbursementStatus(
    disbursement,
    ["USDC_RELEASED"],
    "conversion recording",
  );
  const amounts = validateUsdBreakdown(
    command.grossUsdMinorUnits,
    command.providerFeesUsdMinorUnits,
    command.netUsdMinorUnits,
    "conversion",
  );
  const rateNumerator = baseUnits(
    command.rateUsdMinorUnitsNumerator,
    "rateUsdMinorUnitsNumerator",
  );
  const rateDenominator = baseUnits(
    command.rateUsdcBaseUnitsDenominator,
    "rateUsdcBaseUnitsDenominator",
  );
  invariant(
    parseBaseUnits(rateNumerator) > 0n &&
      parseBaseUnits(rateDenominator) > 0n,
    "INVALID_AMOUNT",
    "conversion rate numerator and denominator must be positive",
  );
  invariant(
    parseBaseUnits(disbursement.releasedUsdcBaseUnits) *
      parseBaseUnits(rateNumerator) ===
      parseBaseUnits(amounts.gross) * parseBaseUnits(rateDenominator),
    "INVARIANT_VIOLATION",
    "conversion rate must exactly reconcile released USDC to gross USD",
  );
  validateContentCommitment(
    command.providerReferenceCommitment,
    "providerReferenceCommitment",
  );
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  invariant(
    disbursement.onchainRelease !== undefined,
    "INVARIANT_VIOLATION",
    "on-chain release evidence is required before conversion",
  );
  assertTimestampAtOrAfter(
    command.recordedAt,
    disbursement.onchainRelease.recordedAt,
    "recordedAt",
  );
  return {
    ...disbursement,
    status: "CONVERTED",
    conversion: {
      providerReferenceCommitment: command.providerReferenceCommitment,
      grossUsdMinorUnits: amounts.gross,
      providerFeesUsdMinorUnits: amounts.fees,
      netUsdMinorUnits: amounts.net,
      rateUsdMinorUnitsNumerator: rateNumerator,
      rateUsdcBaseUnitsDenominator: rateDenominator,
      evidenceCommitment: command.evidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

export function recordSwiftSent(
  disbursement: FiatDisbursementV1,
  command: RecordSwiftSentCommand,
): FiatDisbursementV1 {
  assertSquadsRail(disbursement, "SWIFT recording");
  assertDisbursementStatus(disbursement, ["CONVERTED"], "SWIFT recording");
  invariant(
    disbursement.conversion !== undefined,
    "INVARIANT_VIOLATION",
    "conversion evidence is required before SWIFT",
  );
  const amounts = validateUsdBreakdown(
    command.grossUsdMinorUnits,
    command.bankFeesUsdMinorUnits,
    command.netUsdMinorUnits,
    "swift",
  );
  invariant(
    amounts.gross === disbursement.conversion.netUsdMinorUnits,
    "INVARIANT_VIOLATION",
    "SWIFT gross USD must equal net USD produced by conversion",
  );
  validateContentCommitment(command.uetrCommitment, "uetrCommitment");
  validateContentCommitment(
    command.sendingEvidenceCommitment,
    "sendingEvidenceCommitment",
  );
  const parsedValueDate = new Date(`${command.valueDate}T00:00:00.000Z`);
  invariant(
    /^\d{4}-\d{2}-\d{2}$/.test(command.valueDate) &&
      !Number.isNaN(parsedValueDate.getTime()) &&
      parsedValueDate.toISOString().slice(0, 10) === command.valueDate,
    "INVALID_ARGUMENT",
    "valueDate must be a valid YYYY-MM-DD date",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  assertTimestampAtOrAfter(
    command.recordedAt,
    disbursement.conversion.recordedAt,
    "recordedAt",
  );
  return {
    ...disbursement,
    status: "SWIFT_SENT",
    swift: {
      grossUsdMinorUnits: amounts.gross,
      bankFeesUsdMinorUnits: amounts.fees,
      netUsdMinorUnits: amounts.net,
      uetrCommitment: command.uetrCommitment,
      valueDate: command.valueDate,
      sendingEvidenceCommitment: command.sendingEvidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

export function recordBankConfirmation(
  disbursement: FiatDisbursementV1,
  command: RecordBankConfirmationCommand,
): FiatDisbursementV1 {
  assertSquadsRail(disbursement, "bank confirmation");
  assertDisbursementStatus(
    disbursement,
    ["SWIFT_SENT"],
    "bank confirmation",
  );
  validateContentCommitment(
    command.confirmationEvidenceCommitment,
    "confirmationEvidenceCommitment",
  );
  requiredIdentifier(command.reviewedBy, "reviewedBy");
  invariant(
    !disbursement.approvals.some(
      (approval) => approval.approvedBy === command.reviewedBy,
    ) && disbursement.proposedBy !== command.reviewedBy,
    "INVALID_PARTY_CONFIGURATION",
    "bank confirmation requires a reviewer independent of proposal and approval",
  );
  validateIsoTimestamp(command.confirmedAt, "confirmedAt");
  invariant(
    disbursement.swift !== undefined,
    "INVARIANT_VIOLATION",
    "SWIFT evidence is required before bank confirmation",
  );
  assertTimestampAtOrAfter(
    command.confirmedAt,
    disbursement.swift.recordedAt,
    "confirmedAt",
  );
  return {
    ...disbursement,
    status: "BANK_CONFIRMED",
    bankConfirmation: {
      confirmationEvidenceCommitment:
        command.confirmationEvidenceCommitment,
      reviewedBy: command.reviewedBy,
      confirmedAt: command.confirmedAt,
    },
  };
}

export function reconcileFiatDisbursement(
  disbursement: FiatDisbursementV1,
  command: ReconcileDisbursementCommand,
): FiatDisbursementV1 {
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.reconciledBy, "reconciledBy");
  validateIsoTimestamp(command.reconciledAt, "reconciledAt");
  let priorTimestamp: IsoTimestamp;
  if (disbursement.railKind === "SQUADS_FIAT_FORWARD") {
    assertDisbursementStatus(
      disbursement,
      ["BANK_CONFIRMED"],
      "disbursement reconciliation",
    );
    invariant(
      disbursement.bankConfirmation !== undefined,
      "INVARIANT_VIOLATION",
      "bank confirmation is required before reconciliation",
    );
    priorTimestamp = disbursement.bankConfirmation.confirmedAt;
  } else {
    // A direct-USDC movement has no conversion or SWIFT leg; the finalized
    // on-chain transfer to the MSE wallet is itself the reconciliation evidence.
    assertDisbursementStatus(
      disbursement,
      ["USDC_RELEASED"],
      "disbursement reconciliation",
    );
    invariant(
      disbursement.onchainRelease !== undefined,
      "INVARIANT_VIOLATION",
      "on-chain release evidence is required before reconciliation",
    );
    priorTimestamp = disbursement.onchainRelease.recordedAt;
  }
  assertTimestampAtOrAfter(
    command.reconciledAt,
    priorTimestamp,
    "reconciledAt",
  );
  return {
    ...disbursement,
    status: "RECONCILED",
    reconciliation: {
      evidenceCommitment: command.evidenceCommitment,
      reconciledBy: command.reconciledBy,
      reconciledAt: command.reconciledAt,
    },
  };
}

export function markFiatDisbursementFailed(
  disbursement: FiatDisbursementV1,
  command: RecordRailExceptionCommand,
): FiatDisbursementV1 {
  assertDisbursementStatus(
    disbursement,
    ["PROPOSED", "APPROVED", "USDC_RELEASED", "CONVERTED", "SWIFT_SENT"],
    "failure recording",
  );
  return recordDisbursementException(disbursement, command, "FAILED");
}

export function markFiatDisbursementReturned(
  disbursement: FiatDisbursementV1,
  command: RecordRailExceptionCommand,
): FiatDisbursementV1 {
  assertDisbursementStatus(
    disbursement,
    ["SWIFT_SENT", "BANK_CONFIRMED", "RECONCILED"],
    "returned payment recording",
  );
  return recordDisbursementException(disbursement, command, "RETURNED");
}

function recordDisbursementException(
  disbursement: FiatDisbursementV1,
  command: RecordRailExceptionCommand,
  status: "FAILED" | "RETURNED",
): FiatDisbursementV1 {
  requiredIdentifier(command.reasonCode, "reasonCode");
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  const priorTimestamps = [
    disbursement.proposedAt,
    ...disbursement.approvals.map((approval) => approval.approvedAt),
    disbursement.onchainRelease?.recordedAt,
    disbursement.conversion?.recordedAt,
    disbursement.swift?.recordedAt,
    disbursement.bankConfirmation?.confirmedAt,
    disbursement.reconciliation?.reconciledAt,
  ].filter((value): value is string => value !== undefined);
  const latestPriorTimestamp = priorTimestamps.sort().at(-1);
  invariant(
    latestPriorTimestamp !== undefined,
    "INVARIANT_VIOLATION",
    "disbursement must contain a prior event",
  );
  assertTimestampAtOrAfter(
    command.recordedAt,
    latestPriorTimestamp,
    "recordedAt",
  );
  return {
    ...disbursement,
    status,
    exception: {
      previousStatus: disbursement.status,
      reasonCode: command.reasonCode,
      evidenceCommitment: command.evidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

function assertSquadsRail(
  disbursement: FiatDisbursementV1,
  action: string,
): void {
  invariant(
    disbursement.railKind === "SQUADS_FIAT_FORWARD",
    "INVALID_STATE_TRANSITION",
    `${action} only applies to the Squads fiat-forward rail`,
    { railKind: disbursement.railKind },
  );
}

export function assertDisbursementAllowsNextRelease(
  disbursement: FiatDisbursementV1,
): void {
  invariant(
    disbursement.status === "RECONCILED" &&
      disbursement.reconciliation !== undefined &&
      (disbursement.railKind === "DIRECT_USDC" ||
        disbursement.bankConfirmation !== undefined),
    "INVALID_STATE_TRANSITION",
    "the prior fiat disbursement must be reconciled before the next release",
    { status: disbursement.status },
  );
}

export type AuthorizedFiatPayerType =
  | "FIAT_BENEFICIARY"
  | "BUYER"
  | "SERVICER";

export type FiatRepaymentStatusV1 =
  | "PROPOSED"
  | "FIAT_RECEIVED"
  | "CONVERTED"
  | "USDC_DEPOSITED"
  | "RECONCILED"
  | "FAILED"
  | "RETURNED";

export interface FiatReceiptEvidenceV1 {
  readonly grossUsdMinorUnits: BaseUnitString;
  readonly bankFeesUsdMinorUnits: BaseUnitString;
  readonly netUsdMinorUnits: BaseUnitString;
  readonly bankEvidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RepaymentConversionEvidenceV1 {
  readonly sourceUsdMinorUnits: BaseUnitString;
  readonly providerFeesUsdMinorUnits: BaseUnitString;
  readonly convertedUsdMinorUnits: BaseUnitString;
  readonly acquiredUsdcBaseUnits: BaseUnitString;
  readonly rateUsdcBaseUnitsNumerator: BaseUnitString;
  readonly rateUsdMinorUnitsDenominator: BaseUnitString;
  readonly providerReferenceCommitment: ContentCommitment;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RepaymentExceptionV1 {
  readonly previousStatus: FiatRepaymentStatusV1;
  readonly reasonCode: string;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface FiatRepaymentV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly dealId: string;
  readonly status: FiatRepaymentStatusV1;
  readonly payerType: AuthorizedFiatPayerType;
  readonly payerEntityReference: EntityReference;
  readonly issuerEntityReference: EntityReference;
  readonly issuerTreasuryUsdcAta: string;
  readonly repaymentVaultUsdcAta: string;
  readonly proposedBy: string;
  readonly proposedAt: IsoTimestamp;
  readonly fiatReceipt?: FiatReceiptEvidenceV1;
  readonly conversion?: RepaymentConversionEvidenceV1;
  readonly onchainDeposit?: OnchainTransferEvidenceV1;
  readonly reconciliation?: ReconciliationEvidenceV1;
  readonly exception?: RepaymentExceptionV1;
}

export interface CreateFiatRepaymentInput {
  readonly id: string;
  readonly dealId: string;
  readonly payerType: AuthorizedFiatPayerType;
  readonly payerEntityReference: EntityReference;
  readonly issuerEntityReference: EntityReference;
  readonly issuerTreasuryUsdcAta: string;
  readonly repaymentVaultUsdcAta: string;
  readonly proposedBy: string;
  readonly proposedAt: IsoTimestamp;
}

export interface RecordFiatReceivedCommand {
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly bankFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly bankEvidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RecordRepaymentConversionCommand {
  readonly sourceUsdMinorUnits: BaseUnitInput;
  readonly providerFeesUsdMinorUnits: BaseUnitInput;
  readonly convertedUsdMinorUnits: BaseUnitInput;
  readonly acquiredUsdcBaseUnits: BaseUnitInput;
  readonly rateUsdcBaseUnitsNumerator: BaseUnitInput;
  readonly rateUsdMinorUnitsDenominator: BaseUnitInput;
  readonly providerReferenceCommitment: ContentCommitment;
  readonly evidenceCommitment: ContentCommitment;
  readonly recordedBy: string;
  readonly recordedAt: IsoTimestamp;
}

function assertRepaymentStatus(
  repayment: FiatRepaymentV1,
  expected: readonly FiatRepaymentStatusV1[],
  operation: string,
): void {
  invariant(
    expected.includes(repayment.status),
    "INVALID_STATE_TRANSITION",
    `${operation} is not allowed from ${repayment.status}`,
    { expected, actual: repayment.status },
  );
}

export function createFiatRepayment(
  input: CreateFiatRepaymentInput,
): FiatRepaymentV1 {
  requiredIdentifier(input.id, "id");
  requiredIdentifier(input.dealId, "dealId");
  requiredIdentifier(input.payerEntityReference, "payerEntityReference");
  requiredIdentifier(input.issuerEntityReference, "issuerEntityReference");
  invariant(
    input.payerType === "FIAT_BENEFICIARY" ||
      input.payerType === "BUYER" ||
      input.payerType === "SERVICER",
    "INVALID_ARGUMENT",
    "repayment payer type is unsupported",
  );
  validateSolanaPublicKey(
    input.issuerTreasuryUsdcAta,
    "issuerTreasuryUsdcAta",
  );
  validateSolanaPublicKey(
    input.repaymentVaultUsdcAta,
    "repaymentVaultUsdcAta",
  );
  invariant(
    input.issuerTreasuryUsdcAta !== input.repaymentVaultUsdcAta,
    "INVALID_PARTY_CONFIGURATION",
    "issuer treasury and repayment vault token accounts must be distinct",
  );
  requiredIdentifier(input.proposedBy, "proposedBy");
  validateIsoTimestamp(input.proposedAt, "proposedAt");
  return {
    schemaVersion: 1,
    id: input.id,
    dealId: input.dealId,
    status: "PROPOSED",
    payerType: input.payerType,
    payerEntityReference: input.payerEntityReference,
    issuerEntityReference: input.issuerEntityReference,
    issuerTreasuryUsdcAta: input.issuerTreasuryUsdcAta,
    repaymentVaultUsdcAta: input.repaymentVaultUsdcAta,
    proposedBy: input.proposedBy,
    proposedAt: input.proposedAt,
  };
}

export function recordFiatRepaymentReceived(
  repayment: FiatRepaymentV1,
  command: RecordFiatReceivedCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(repayment, ["PROPOSED"], "fiat receipt recording");
  const amounts = validateUsdBreakdown(
    command.grossUsdMinorUnits,
    command.bankFeesUsdMinorUnits,
    command.netUsdMinorUnits,
    "fiat receipt",
  );
  validateContentCommitment(
    command.bankEvidenceCommitment,
    "bankEvidenceCommitment",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  assertTimestampAtOrAfter(
    command.recordedAt,
    repayment.proposedAt,
    "recordedAt",
  );
  return {
    ...repayment,
    status: "FIAT_RECEIVED",
    fiatReceipt: {
      grossUsdMinorUnits: amounts.gross,
      bankFeesUsdMinorUnits: amounts.fees,
      netUsdMinorUnits: amounts.net,
      bankEvidenceCommitment: command.bankEvidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

export function recordFiatRepaymentConversion(
  repayment: FiatRepaymentV1,
  command: RecordRepaymentConversionCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(
    repayment,
    ["FIAT_RECEIVED"],
    "repayment conversion recording",
  );
  invariant(
    repayment.fiatReceipt !== undefined,
    "INVARIANT_VIOLATION",
    "fiat receipt evidence is required before conversion",
  );
  const breakdown = validateUsdBreakdown(
    command.sourceUsdMinorUnits,
    command.providerFeesUsdMinorUnits,
    command.convertedUsdMinorUnits,
    "repayment conversion",
  );
  invariant(
    breakdown.gross === repayment.fiatReceipt.netUsdMinorUnits,
    "INVARIANT_VIOLATION",
    "repayment conversion source must equal net fiat received",
  );
  const acquiredUsdc = baseUnits(
    command.acquiredUsdcBaseUnits,
    "acquiredUsdcBaseUnits",
  );
  invariant(
    parseBaseUnits(acquiredUsdc) > 0n,
    "INVALID_AMOUNT",
    "repayment conversion must acquire positive USDC",
  );
  const rateNumerator = baseUnits(
    command.rateUsdcBaseUnitsNumerator,
    "rateUsdcBaseUnitsNumerator",
  );
  const rateDenominator = baseUnits(
    command.rateUsdMinorUnitsDenominator,
    "rateUsdMinorUnitsDenominator",
  );
  invariant(
    parseBaseUnits(rateNumerator) > 0n &&
      parseBaseUnits(rateDenominator) > 0n,
    "INVALID_AMOUNT",
    "repayment conversion rate numerator and denominator must be positive",
  );
  invariant(
    parseBaseUnits(breakdown.net) * parseBaseUnits(rateNumerator) ===
      parseBaseUnits(acquiredUsdc) * parseBaseUnits(rateDenominator),
    "INVARIANT_VIOLATION",
    "repayment conversion rate must exactly reconcile converted USD to acquired USDC",
  );
  validateContentCommitment(
    command.providerReferenceCommitment,
    "providerReferenceCommitment",
  );
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  assertTimestampAtOrAfter(
    command.recordedAt,
    repayment.fiatReceipt.recordedAt,
    "recordedAt",
  );
  return {
    ...repayment,
    status: "CONVERTED",
    conversion: {
      sourceUsdMinorUnits: breakdown.gross,
      providerFeesUsdMinorUnits: breakdown.fees,
      convertedUsdMinorUnits: breakdown.net,
      acquiredUsdcBaseUnits: acquiredUsdc,
      rateUsdcBaseUnitsNumerator: rateNumerator,
      rateUsdMinorUnitsDenominator: rateDenominator,
      providerReferenceCommitment: command.providerReferenceCommitment,
      evidenceCommitment: command.evidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

export function markRepaymentUsdcDeposited(
  repayment: FiatRepaymentV1,
  command: MarkRepaymentUsdcDepositedCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(
    repayment,
    ["CONVERTED"],
    "repayment USDC deposit recording",
  );
  invariant(
    repayment.conversion !== undefined,
    "INVARIANT_VIOLATION",
    "conversion evidence is required before the USDC deposit",
  );
  requiredIdentifier(command.transactionSignature, "transactionSignature");
  validateSlot(command.finalizedSlot);
  validateSolanaPublicKey(command.sourceTokenAccount, "sourceTokenAccount");
  validateSolanaPublicKey(
    command.destinationTokenAccount,
    "destinationTokenAccount",
  );
  invariant(
    command.sourceTokenAccount === repayment.issuerTreasuryUsdcAta,
    "INVALID_PARTY_CONFIGURATION",
    "repayment USDC must originate from the registered issuer treasury ATA",
  );
  invariant(
    command.destinationTokenAccount === repayment.repaymentVaultUsdcAta,
    "INVALID_PARTY_CONFIGURATION",
    "repayment USDC must be deposited into the configured deal repayment vault",
  );
  const amount = baseUnits(command.amountBaseUnits, "amountBaseUnits");
  invariant(
    amount === repayment.conversion.acquiredUsdcBaseUnits,
    "INVARIANT_VIOLATION",
    "on-chain repayment must equal the USDC acquired in the linked conversion",
  );
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  assertTimestampAtOrAfter(
    command.recordedAt,
    repayment.conversion.recordedAt,
    "recordedAt",
  );
  return {
    ...repayment,
    status: "USDC_DEPOSITED",
    onchainDeposit: {
      transactionSignature: command.transactionSignature,
      finalizedSlot: command.finalizedSlot,
      sourceTokenAccount: command.sourceTokenAccount,
      destinationTokenAccount: command.destinationTokenAccount,
      amountBaseUnits: amount,
      recordedAt: command.recordedAt,
    },
  };
}

export function reconcileFiatRepayment(
  repayment: FiatRepaymentV1,
  command: ReconcileDisbursementCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(
    repayment,
    ["USDC_DEPOSITED"],
    "repayment reconciliation",
  );
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.reconciledBy, "reconciledBy");
  validateIsoTimestamp(command.reconciledAt, "reconciledAt");
  invariant(
    repayment.onchainDeposit !== undefined,
    "INVARIANT_VIOLATION",
    "on-chain deposit evidence is required before reconciliation",
  );
  assertTimestampAtOrAfter(
    command.reconciledAt,
    repayment.onchainDeposit.recordedAt,
    "reconciledAt",
  );
  return {
    ...repayment,
    status: "RECONCILED",
    reconciliation: {
      evidenceCommitment: command.evidenceCommitment,
      reconciledBy: command.reconciledBy,
      reconciledAt: command.reconciledAt,
    },
  };
}

export function markFiatRepaymentFailed(
  repayment: FiatRepaymentV1,
  command: RecordRailExceptionCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(
    repayment,
    ["PROPOSED", "FIAT_RECEIVED", "CONVERTED"],
    "repayment failure recording",
  );
  return recordRepaymentException(repayment, command, "FAILED");
}

export function markFiatRepaymentReturned(
  repayment: FiatRepaymentV1,
  command: RecordRailExceptionCommand,
): FiatRepaymentV1 {
  assertRepaymentStatus(
    repayment,
    ["FIAT_RECEIVED", "CONVERTED", "USDC_DEPOSITED", "RECONCILED"],
    "repayment return recording",
  );
  return recordRepaymentException(repayment, command, "RETURNED");
}

function recordRepaymentException(
  repayment: FiatRepaymentV1,
  command: RecordRailExceptionCommand,
  status: "FAILED" | "RETURNED",
): FiatRepaymentV1 {
  requiredIdentifier(command.reasonCode, "reasonCode");
  validateContentCommitment(
    command.evidenceCommitment,
    "evidenceCommitment",
  );
  requiredIdentifier(command.recordedBy, "recordedBy");
  validateIsoTimestamp(command.recordedAt, "recordedAt");
  const priorTimestamps = [
    repayment.proposedAt,
    repayment.fiatReceipt?.recordedAt,
    repayment.conversion?.recordedAt,
    repayment.onchainDeposit?.recordedAt,
    repayment.reconciliation?.reconciledAt,
  ].filter((value): value is string => value !== undefined);
  const latestPriorTimestamp = priorTimestamps.sort().at(-1);
  invariant(
    latestPriorTimestamp !== undefined,
    "INVARIANT_VIOLATION",
    "repayment must contain a prior event",
  );
  assertTimestampAtOrAfter(
    command.recordedAt,
    latestPriorTimestamp,
    "recordedAt",
  );
  return {
    ...repayment,
    status,
    exception: {
      previousStatus: repayment.status,
      reasonCode: command.reasonCode,
      evidenceCommitment: command.evidenceCommitment,
      recordedBy: command.recordedBy,
      recordedAt: command.recordedAt,
    },
  };
}

export interface ManualDisbursementConversionInput {
  readonly providerReferenceEvidence: EvidenceValue;
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly providerFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly rateUsdMinorUnitsNumerator: BaseUnitInput;
  readonly rateUsdcBaseUnitsDenominator: BaseUnitInput;
  readonly evidence: EvidenceValue;
  readonly recordedBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface ManualSwiftInput {
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly bankFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly uetr: string;
  readonly valueDate: string;
  readonly evidence: EvidenceValue;
  readonly recordedBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface ManualBankConfirmationInput {
  readonly evidence: EvidenceValue;
  readonly reviewedBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface ManualReconciliationInput {
  readonly evidence: EvidenceValue;
  readonly reconciledBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface ManualFiatReceiptInput {
  readonly grossUsdMinorUnits: BaseUnitInput;
  readonly bankFeesUsdMinorUnits: BaseUnitInput;
  readonly netUsdMinorUnits: BaseUnitInput;
  readonly evidence: EvidenceValue;
  readonly recordedBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface ManualRepaymentConversionInput {
  readonly sourceUsdMinorUnits: BaseUnitInput;
  readonly providerFeesUsdMinorUnits: BaseUnitInput;
  readonly convertedUsdMinorUnits: BaseUnitInput;
  readonly acquiredUsdcBaseUnits: BaseUnitInput;
  readonly rateUsdcBaseUnitsNumerator: BaseUnitInput;
  readonly rateUsdMinorUnitsDenominator: BaseUnitInput;
  readonly providerReferenceEvidence: EvidenceValue;
  readonly evidence: EvidenceValue;
  readonly recordedBy: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface TreasuryRailAdapter {
  readonly kind: string;
  recordDisbursementConversion(
    disbursement: FiatDisbursementV1,
    input: ManualDisbursementConversionInput,
  ): Promise<FiatDisbursementV1>;
  recordSwiftSent(
    disbursement: FiatDisbursementV1,
    input: ManualSwiftInput,
  ): Promise<FiatDisbursementV1>;
  recordBankConfirmation(
    disbursement: FiatDisbursementV1,
    input: ManualBankConfirmationInput,
  ): Promise<FiatDisbursementV1>;
  reconcileDisbursement(
    disbursement: FiatDisbursementV1,
    input: ManualReconciliationInput,
  ): Promise<FiatDisbursementV1>;
  recordFiatRepaymentReceived(
    repayment: FiatRepaymentV1,
    input: ManualFiatReceiptInput,
  ): Promise<FiatRepaymentV1>;
  recordFiatRepaymentConversion(
    repayment: FiatRepaymentV1,
    input: ManualRepaymentConversionInput,
  ): Promise<FiatRepaymentV1>;
  reconcileRepayment(
    repayment: FiatRepaymentV1,
    input: ManualReconciliationInput,
  ): Promise<FiatRepaymentV1>;
}

export type Clock = () => Date;

/**
 * Controlled manual rail: operators execute bank/provider actions outside the
 * application, while this adapter records only domain-separated commitments
 * and the explicit financial breakdown needed for reconciliation.
 */
export class ControlledManualTreasuryRailAdapter
  implements TreasuryRailAdapter
{
  readonly kind = "CONTROLLED_MANUAL_V1";
  readonly #clock: Clock;

  constructor(clock: Clock = () => new Date()) {
    this.#clock = clock;
  }

  async recordDisbursementConversion(
    disbursement: FiatDisbursementV1,
    input: ManualDisbursementConversionInput,
  ): Promise<FiatDisbursementV1> {
    return recordDisbursementConversion(disbursement, {
      providerReferenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.conversionProvider,
        input.providerReferenceEvidence,
      ),
      grossUsdMinorUnits: input.grossUsdMinorUnits,
      providerFeesUsdMinorUnits: input.providerFeesUsdMinorUnits,
      netUsdMinorUnits: input.netUsdMinorUnits,
      rateUsdMinorUnitsNumerator: input.rateUsdMinorUnitsNumerator,
      rateUsdcBaseUnitsDenominator: input.rateUsdcBaseUnitsDenominator,
      evidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.conversion,
        input.evidence,
      ),
      recordedBy: input.recordedBy,
      recordedAt: this.timestamp(input.occurredAt),
    });
  }

  async recordSwiftSent(
    disbursement: FiatDisbursementV1,
    input: ManualSwiftInput,
  ): Promise<FiatDisbursementV1> {
    requiredIdentifier(input.uetr, "uetr");
    return recordSwiftSent(disbursement, {
      grossUsdMinorUnits: input.grossUsdMinorUnits,
      bankFeesUsdMinorUnits: input.bankFeesUsdMinorUnits,
      netUsdMinorUnits: input.netUsdMinorUnits,
      uetrCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.swiftUetr,
        input.uetr,
      ),
      valueDate: input.valueDate,
      sendingEvidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.swiftSending,
        input.evidence,
      ),
      recordedBy: input.recordedBy,
      recordedAt: this.timestamp(input.occurredAt),
    });
  }

  async recordBankConfirmation(
    disbursement: FiatDisbursementV1,
    input: ManualBankConfirmationInput,
  ): Promise<FiatDisbursementV1> {
    return recordBankConfirmation(disbursement, {
      confirmationEvidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.bankConfirmation,
        input.evidence,
      ),
      reviewedBy: input.reviewedBy,
      confirmedAt: this.timestamp(input.occurredAt),
    });
  }

  async reconcileDisbursement(
    disbursement: FiatDisbursementV1,
    input: ManualReconciliationInput,
  ): Promise<FiatDisbursementV1> {
    return reconcileFiatDisbursement(disbursement, {
      evidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.disbursementReconciliation,
        input.evidence,
      ),
      reconciledBy: input.reconciledBy,
      reconciledAt: this.timestamp(input.occurredAt),
    });
  }

  async recordFiatRepaymentReceived(
    repayment: FiatRepaymentV1,
    input: ManualFiatReceiptInput,
  ): Promise<FiatRepaymentV1> {
    return recordFiatRepaymentReceived(repayment, {
      grossUsdMinorUnits: input.grossUsdMinorUnits,
      bankFeesUsdMinorUnits: input.bankFeesUsdMinorUnits,
      netUsdMinorUnits: input.netUsdMinorUnits,
      bankEvidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.repaymentBankReceipt,
        input.evidence,
      ),
      recordedBy: input.recordedBy,
      recordedAt: this.timestamp(input.occurredAt),
    });
  }

  async recordFiatRepaymentConversion(
    repayment: FiatRepaymentV1,
    input: ManualRepaymentConversionInput,
  ): Promise<FiatRepaymentV1> {
    return recordFiatRepaymentConversion(repayment, {
      sourceUsdMinorUnits: input.sourceUsdMinorUnits,
      providerFeesUsdMinorUnits: input.providerFeesUsdMinorUnits,
      convertedUsdMinorUnits: input.convertedUsdMinorUnits,
      acquiredUsdcBaseUnits: input.acquiredUsdcBaseUnits,
      rateUsdcBaseUnitsNumerator: input.rateUsdcBaseUnitsNumerator,
      rateUsdMinorUnitsDenominator: input.rateUsdMinorUnitsDenominator,
      providerReferenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.repaymentConversionProvider,
        input.providerReferenceEvidence,
      ),
      evidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.repaymentConversion,
        input.evidence,
      ),
      recordedBy: input.recordedBy,
      recordedAt: this.timestamp(input.occurredAt),
    });
  }

  async reconcileRepayment(
    repayment: FiatRepaymentV1,
    input: ManualReconciliationInput,
  ): Promise<FiatRepaymentV1> {
    return reconcileFiatRepayment(repayment, {
      evidenceCommitment: createEvidenceCommitment(
        EVIDENCE_DOMAINS.repaymentReconciliation,
        input.evidence,
      ),
      reconciledBy: input.reconciledBy,
      reconciledAt: this.timestamp(input.occurredAt),
    });
  }

  private timestamp(value: IsoTimestamp | undefined): IsoTimestamp {
    const timestamp = value ?? this.#clock().toISOString();
    validateIsoTimestamp(timestamp, "occurredAt");
    return timestamp;
  }
}
