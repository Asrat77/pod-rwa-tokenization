import type {
  DealDetail,
  DealWorkspace,
  RwaDeal,
  RwaEligibility,
  RwaMilestone,
  RwaPosition,
  RwaSettlement,
  RwaTreasuryMovement,
} from "./types";

const endpoint = import.meta.env.VITE_GRAPHQL_ENDPOINT;

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  getIdToken: () => Promise<string>,
): Promise<T> {
  if (!endpoint) throw new Error("VITE_GRAPHQL_ENDPOINT is not configured");
  const token = await getIdToken();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message || `GraphQL request failed (${response.status})`);
  }
  return payload.data;
}

const dealFields = `
  id displayName issuerEntityHash beneficiaryEntityHash mseRailKind assetSetHash
  documentBundleHash termsHash settlementMint receiptMint receiptTokenProgram
  dealIdHash state minimumRaiseBaseUnits hardCapBaseUnits fundedBaseUnits
  releasedBaseUnits repaidBaseUnits couponBps subscriptionOpenAt
  subscriptionCloseAt maturityAt
  chain { clusterGenesis programId address accountVersion finalizedSlot signature accountHash lastReconciledAt }
`;

export async function loadWorkspace(
  getIdToken: () => Promise<string>,
): Promise<DealWorkspace> {
  if (!endpoint) return demoWorkspace;
  return graphql<{ deals: RwaDeal[]; eligibility: RwaEligibility | null }>(
    `query InvestorWorkspace {
      deals: rwaDeals { ${dealFields} }
      eligibility: rwaEligibility {
        investorId investorIdHash wallet status providerRefHash policyVersion validUntil
      }
    }`,
    {},
    getIdToken,
  );
}

export async function loadDealDetail(
  dealId: string,
  getIdToken: () => Promise<string>,
): Promise<DealDetail> {
  if (!endpoint) return demoDetails[dealId] || emptyDetail;
  return graphql<{
    milestones: RwaMilestone[];
    movements: RwaTreasuryMovement[];
    position: RwaPosition | null;
    settlement: RwaSettlement | null;
  }>(
    `query InvestorDeal($dealId: ID!) {
      milestones: rwaMilestones(dealId: $dealId) {
        dealId index gateKind allocationBps amountBaseUnits gateAddress gateRevision
        status executeAfter executedAt
        chain { clusterGenesis programId address accountVersion finalizedSlot signature accountHash lastReconciledAt }
      }
      movements: rwaTreasuryMovements(dealId: $dealId) {
        id dealId milestoneIndex status releasedUsdcBaseUnits grossUsdMinor
        netUsdMinor providerFeesUsdMinor bankFeesUsdMinor updatedAt
      }
      position: rwaPosition(dealId: $dealId) {
        dealId investorId investorIdHash wallet eligibilityStatus contributedBaseUnits
        receiptBaseUnits refundedBaseUnits redeemedBaseUnits
        chain { clusterGenesis programId address accountVersion finalizedSlot signature accountHash lastReconciledAt }
      }
      settlement: rwaSettlement(dealId: $dealId) {
        dealId supplySnapshotBaseUnits investorPoolBaseUnits claimedBaseUnits
        defaulted claimDeadlineAt
      }
    }`,
    { dealId },
    getIdToken,
  );
}

export async function createWalletChallenge(
  wallet: string,
  getIdToken: () => Promise<string>,
): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const result = await graphql<{
    challenge: { nonce: string; message: string; expiresAt: string };
  }>(
    `mutation Challenge($input: CreateRwaWalletChallengeInput!) {
      challenge: createRwaWalletChallenge(input: $input) { nonce message expiresAt }
    }`,
    { input: { wallet } },
    getIdToken,
  );
  return result.challenge;
}

export async function bindWallet(
  input: { nonce: string; wallet: string; signature: string },
  getIdToken: () => Promise<string>,
): Promise<RwaEligibility["status"]> {
  const result = await graphql<{
    binding: { status: RwaEligibility["status"] };
  }>(
    `mutation Bind($input: BindRwaWalletInput!) {
      binding: bindRwaWallet(input: $input) { investorId wallet status boundAt }
    }`,
    { input },
    getIdToken,
  );
  return result.binding.status;
}

const now = new Date();
const close = new Date(now.getTime() + 7 * 86_400_000);
const maturity = new Date(now.getTime() + 120 * 86_400_000);
const hash = (character: string) => character.repeat(64);
const demoDeals: RwaDeal[] = [
  {
    id: "POD-RWA-2026-006",
    displayName: "POD Exp Farm UKE001",
    issuerEntityHash: hash("1"),
    beneficiaryEntityHash: hash("2"),
    assetSetHash: hash("3"),
    documentBundleHash: hash("4"),
    termsHash: hash("5"),
    settlementMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    state: "SUBSCRIPTION_OPEN",
    minimumRaiseBaseUnits: "20000000",
    hardCapBaseUnits: "30000000",
    fundedBaseUnits: "15000000",
    releasedBaseUnits: "0",
    repaidBaseUnits: "0",
    couponBps: 1000,
    subscriptionOpenAt: now.toISOString(),
    subscriptionCloseAt: close.toISOString(),
    maturityAt: maturity.toISOString(),
  },
  {
    id: "POD-RWA-2026-007",
    displayName: "Desa Main Farm",
    issuerEntityHash: hash("6"),
    beneficiaryEntityHash: hash("7"),
    assetSetHash: hash("8"),
    documentBundleHash: hash("9"),
    termsHash: hash("a"),
    settlementMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    state: "DRAFT",
    minimumRaiseBaseUnits: "20000000",
    hardCapBaseUnits: "30000000",
    fundedBaseUnits: "0",
    releasedBaseUnits: "0",
    repaidBaseUnits: "0",
    couponBps: 1000,
    subscriptionOpenAt: now.toISOString(),
    subscriptionCloseAt: close.toISOString(),
    maturityAt: maturity.toISOString(),
  },
];

const gates = ["CAPITAL_CLOSE", "T1_PASS", "T2_PASS", "T3_PASS"];
const allocations = [3000, 3000, 3000, 1000];
const demoDetails = Object.fromEntries(
  demoDeals.map((deal) => [
    deal.id,
    {
      milestones: gates.map((gateKind, index) => ({
        dealId: deal.id,
        index,
        gateKind,
        allocationBps: allocations[index],
        amountBaseUnits: String((30_000_000 * allocations[index]) / 10_000),
        status: index === 0 && deal.state !== "DRAFT" ? "SCHEDULED" : "PENDING",
      })),
      movements: [],
      position: null,
      settlement: null,
    } satisfies DealDetail,
  ]),
);

const emptyDetail: DealDetail = {
  milestones: [],
  movements: [],
  position: null,
  settlement: null,
};

export const demoWorkspace: DealWorkspace = {
  deals: demoDeals,
  eligibility: null,
};

export const isFixtureMode = !endpoint;
