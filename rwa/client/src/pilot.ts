import { invariant } from "./errors.js";
import {
  applyBasisPoints,
  baseUnits,
  checkedU64,
  parseBaseUnits,
  validateBasisPoints,
  type BaseUnitInput,
  type BaseUnitString,
} from "./money.js";
import type {
  MilestoneGateV1,
  SettlementOutcomeV1,
} from "./domain.js";

export interface PilotDealFixtureV1 {
  readonly fixtureId: string;
  readonly assetSetMembers: readonly string[];
  readonly displayName: string;
}

export interface PilotTermsV1 {
  readonly schemaVersion: 1;
  readonly currency: "USDC";
  readonly minimumRaiseBaseUnits: BaseUnitString;
  readonly hardCapBaseUnits: BaseUnitString;
  readonly perInvestorCapBaseUnits: BaseUnitString;
  readonly couponBps: number;
  readonly feesBps: number;
  readonly subscriptionWindowSeconds: number;
  readonly maturitySecondsAfterFunding: number;
  readonly claimWindowSeconds: number;
  readonly milestones: readonly {
    readonly index: number;
    readonly gate: MilestoneGateV1;
    readonly allocationBps: number;
  }[];
  readonly deals: readonly PilotDealFixtureV1[];
}

export const PILOT_TERMS_V1: PilotTermsV1 = {
  schemaVersion: 1,
  currency: "USDC",
  minimumRaiseBaseUnits: baseUnits("20000000"),
  hardCapBaseUnits: baseUnits("30000000"),
  perInvestorCapBaseUnits: baseUnits("15000000"),
  couponBps: 1_000,
  feesBps: 0,
  subscriptionWindowSeconds: 604_800,
  maturitySecondsAfterFunding: 1_209_600,
  claimWindowSeconds: 2_592_000,
  milestones: [
    { index: 0, gate: "CAPITAL_CLOSE", allocationBps: 3_000 },
    { index: 1, gate: "T1_PASS", allocationBps: 3_000 },
    { index: 2, gate: "T2_PASS", allocationBps: 3_000 },
    { index: 3, gate: "T3_PASS", allocationBps: 1_000 },
  ],
  deals: [
    {
      fixtureId: "POD-RWA-2026-006",
      assetSetMembers: ["POD-ET-FARM-006"],
      displayName: "POD Exp Farm UKE001",
    },
    {
      fixtureId: "POD-RWA-2026-007",
      assetSetMembers: ["POD-ET-FARM-007"],
      displayName: "Desa Main Farm",
    },
  ],
};

export interface SettlementWaterfallV1 {
  readonly outcome: SettlementOutcomeV1;
  readonly actualRepaymentBaseUnits: BaseUnitString;
  readonly principalPoolBaseUnits: BaseUnitString;
  readonly couponPoolBaseUnits: BaseUnitString;
  readonly investorPoolBaseUnits: BaseUnitString;
  readonly feePoolBaseUnits: BaseUnitString;
  readonly issuerResidualBaseUnits: BaseUnitString;
  readonly investorTargetBaseUnits: BaseUnitString;
}

export interface ProRataAllocationV1 {
  readonly payoutsBaseUnits: readonly BaseUnitString[];
  readonly allocatedBaseUnits: BaseUnitString;
  readonly roundingDustBaseUnits: BaseUnitString;
}

export function allocateMilestoneAmounts(
  fundedCapital: BaseUnitInput,
  allocationsBps: readonly number[],
): readonly BaseUnitString[] {
  invariant(
    allocationsBps.length > 0,
    "INVALID_ARGUMENT",
    "at least one milestone allocation is required",
  );
  const totalBps = allocationsBps.reduce(
    (sum, value, index) =>
      sum + validateBasisPoints(value, `allocationsBps[${index}]`),
    0,
  );
  invariant(
    totalBps === 10_000,
    "INVALID_ARGUMENT",
    "milestone allocations must total exactly 10,000 basis points",
    { totalBps },
  );

  const total = parseBaseUnits(fundedCapital, "fundedCapital");
  let allocated = 0n;
  return allocationsBps.map((allocation, index) => {
    const amount =
      index === allocationsBps.length - 1
        ? total - allocated
        : (total * BigInt(allocation)) / 10_000n;
    allocated += amount;
    return baseUnits(checkedU64(amount, `milestone ${index} amount`));
  });
}

export function calculateSettlementWaterfall(
  principal: BaseUnitInput,
  actualRepayment: BaseUnitInput,
  couponBps: number,
  feesBps: number,
): SettlementWaterfallV1 {
  const principalValue = parseBaseUnits(principal, "principal");
  const actualValue = parseBaseUnits(actualRepayment, "actualRepayment");
  validateBasisPoints(couponBps, "couponBps");
  validateBasisPoints(feesBps, "feesBps");

  const couponTarget = parseBaseUnits(applyBasisPoints(principal, couponBps));
  const feeTarget = parseBaseUnits(applyBasisPoints(principal, feesBps));
  const investorTarget = checkedU64(
    principalValue + couponTarget,
    "investor target",
  );

  const principalPool = actualValue < principalValue ? actualValue : principalValue;
  const afterPrincipal = actualValue - principalPool;
  const couponPool =
    afterPrincipal < couponTarget ? afterPrincipal : couponTarget;
  const afterInvestors = afterPrincipal - couponPool;
  const feePool = afterInvestors < feeTarget ? afterInvestors : feeTarget;
  const issuerResidual = afterInvestors - feePool;
  const investorPool = principalPool + couponPool;

  return {
    outcome:
      investorPool === investorTarget ? "FULL_REPAYMENT" : "DEFAULT",
    actualRepaymentBaseUnits: baseUnits(actualValue),
    principalPoolBaseUnits: baseUnits(principalPool),
    couponPoolBaseUnits: baseUnits(couponPool),
    investorPoolBaseUnits: baseUnits(investorPool),
    feePoolBaseUnits: baseUnits(feePool),
    issuerResidualBaseUnits: baseUnits(issuerResidual),
    investorTargetBaseUnits: baseUnits(investorTarget),
  };
}

export function calculateProRataPayout(
  receiptBalance: BaseUnitInput,
  distributablePool: BaseUnitInput,
  receiptSupply: BaseUnitInput,
): BaseUnitString {
  const supply = parseBaseUnits(receiptSupply, "receiptSupply");
  const balance = parseBaseUnits(receiptBalance, "receiptBalance");
  invariant(
    supply > 0n,
    "INVALID_AMOUNT",
    "receipt supply must be greater than zero",
  );
  invariant(
    balance <= supply,
    "INVALID_AMOUNT",
    "receipt balance cannot exceed the supply snapshot",
  );
  const payout =
    (balance * parseBaseUnits(distributablePool, "distributablePool")) /
    supply;
  return baseUnits(checkedU64(payout, "pro-rata payout"));
}

export function allocateProRataPayouts(
  receiptBalances: readonly BaseUnitInput[],
  distributablePool: BaseUnitInput,
  receiptSupply: BaseUnitInput,
): ProRataAllocationV1 {
  const expectedSupply = parseBaseUnits(receiptSupply, "receiptSupply");
  const balanceTotal = receiptBalances.reduce<bigint>(
    (sum, balance) => sum + parseBaseUnits(balance, "receiptBalance"),
    0n,
  );
  invariant(
    balanceTotal === expectedSupply,
    "INVARIANT_VIOLATION",
    "provided receipt balances must equal the receipt supply snapshot",
    {
      receiptBalanceTotal: balanceTotal.toString(10),
      receiptSupply: expectedSupply.toString(10),
    },
  );

  const payouts = receiptBalances.map((balance) =>
    calculateProRataPayout(balance, distributablePool, receiptSupply),
  );
  const allocated = payouts.reduce<bigint>(
    (sum, payout) => sum + parseBaseUnits(payout),
    0n,
  );
  const pool = parseBaseUnits(distributablePool);
  return {
    payoutsBaseUnits: payouts,
    allocatedBaseUnits: baseUnits(allocated),
    roundingDustBaseUnits: baseUnits(pool - allocated),
  };
}
