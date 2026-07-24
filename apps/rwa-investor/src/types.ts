export type DealState =
  | "DRAFT"
  | "SUBSCRIPTION_OPEN"
  | "FUNDED"
  | "ACTIVE"
  | "REPAID"
  | "DEFAULT_RECOVERY"
  | "REDEEMABLE"
  | "CANCELLED_REFUNDABLE"
  | "SETTLED";

export type EligibilityStatus =
  | "ACTIVE"
  | "SUSPENDED"
  | "EXPIRED"
  | "REVOKED"
  | "SANCTIONS_HOLD";

export interface ChainReference {
  clusterGenesis: string;
  programId: string;
  address: string;
  accountVersion: number;
  finalizedSlot: string;
  signature: string;
  accountHash: string;
  lastReconciledAt: string;
}

export type RwaMseRailKind = "SQUADS_FIAT_FORWARD" | "DIRECT_USDC";

export interface RwaDeal {
  id: string;
  displayName: string;
  issuerEntityHash: string;
  beneficiaryEntityHash: string;
  mseRailKind?: RwaMseRailKind | null;
  assetSetHash: string;
  documentBundleHash: string;
  termsHash: string;
  settlementMint: string;
  receiptMint?: string | null;
  receiptTokenProgram?: string | null;
  dealIdHash?: string | null;
  state: DealState;
  minimumRaiseBaseUnits: string;
  hardCapBaseUnits: string;
  fundedBaseUnits: string;
  releasedBaseUnits: string;
  repaidBaseUnits: string;
  couponBps: number;
  subscriptionOpenAt: string;
  subscriptionCloseAt: string;
  maturityAt: string;
  chain?: ChainReference | null;
}

export interface RwaEligibility {
  investorId: string;
  investorIdHash?: string | null;
  wallet: string;
  status: EligibilityStatus;
  providerRefHash: string;
  policyVersion: string;
  validUntil: string;
}

export interface RwaPosition {
  dealId: string;
  investorId: string;
  investorIdHash?: string | null;
  wallet: string;
  eligibilityStatus: EligibilityStatus;
  contributedBaseUnits: string;
  receiptBaseUnits: string;
  refundedBaseUnits: string;
  redeemedBaseUnits: string;
  chain?: ChainReference | null;
}

export interface RwaMilestone {
  dealId: string;
  index: number;
  gateKind: string;
  allocationBps: number;
  amountBaseUnits: string;
  gateAddress?: string | null;
  gateRevision?: number | null;
  status: string;
  executeAfter?: string | null;
  executedAt?: string | null;
  chain?: ChainReference | null;
}

export interface RwaTreasuryMovement {
  id: string;
  dealId: string;
  milestoneIndex: number;
  status: string;
  releasedUsdcBaseUnits: string;
  grossUsdMinor: string;
  netUsdMinor: string;
  providerFeesUsdMinor: string;
  bankFeesUsdMinor: string;
  updatedAt: string;
}

export interface RwaSettlement {
  dealId: string;
  supplySnapshotBaseUnits: string;
  investorPoolBaseUnits: string;
  claimedBaseUnits: string;
  defaulted: boolean;
  claimDeadlineAt: string;
}

export interface DealWorkspace {
  deals: RwaDeal[];
  eligibility: RwaEligibility | null;
}

export interface DealDetail {
  milestones: RwaMilestone[];
  movements: RwaTreasuryMovement[];
  position: RwaPosition | null;
  settlement: RwaSettlement | null;
}
