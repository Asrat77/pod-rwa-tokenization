'use strict';

const crypto = require('node:crypto');
const { ZERO_HEX_32, ZERO_PUBKEY } = require('./decoder');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function u64String(value, field) {
  if (typeof value !== 'bigint' || value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new Error(`${field} is not a valid u64`);
  }
  return value.toString(10);
}

function timestampToIso(value, nullable = false) {
  if (typeof value !== 'bigint') throw new Error('Decoded timestamp must be a bigint');
  if (nullable && value === 0n) return null;
  const milliseconds = value * 1_000n;
  if (milliseconds < -8_640_000_000_000_000n || milliseconds > 8_640_000_000_000_000n) {
    throw new Error(`Timestamp ${value} is outside the JavaScript ISO-8601 range`);
  }
  return new Date(Number(milliseconds)).toISOString();
}

function nullableHash(value) {
  return value === ZERO_HEX_32 ? null : value;
}

function nullablePubkey(value) {
  return value === ZERO_PUBKEY ? null : value;
}

function chainRef(account, context) {
  return {
    clusterGenesis: context.clusterGenesis,
    programId: context.programId,
    address: account.address,
    accountVersion: account.decoded.schemaVersion,
    finalizedSlot: String(account.slot),
    signature: account.signature || 'UNAVAILABLE',
    accountHash: account.accountHash,
    lastReconciledAt: context.reconciledAt,
  };
}

function mirrorMetadata(account, compositeHash = account.accountHash) {
  return {
    accountHash: compositeHash,
    indexedFinalizedSlot: account.slot,
    indexedAccountAddress: account.address,
  };
}

function mapDeal(termsAccount, stateAccount, context) {
  const terms = termsAccount.decoded;
  const state = stateAccount.decoded;
  if (terms.dealId !== state.dealId) throw new Error('Deal terms and state identifiers do not match');

  const mutableAccount = stateAccount;
  const compositeHash = sha256Hex(
    Buffer.from(`${termsAccount.accountHash}:${stateAccount.accountHash}`, 'utf8'),
  );
  if (state.refundedPrincipal > state.grossSubscriptions) {
    throw new Error(`Deal ${terms.dealId} refunds exceed gross subscriptions`);
  }
  const fundedPrincipal = state.grossSubscriptions - state.refundedPrincipal;
  const chain = chainRef(mutableAccount, context);

  return {
    PK: `RWA#DEAL#${terms.dealId}`,
    SK: 'META',
    GSI1PK: 'RWA#DEALS',
    GSI1SK: `${timestampToIso(terms.subscriptionOpenAt)}#${terms.dealId}`,
    entityType: 'RWA_DEAL',
    id: terms.dealId,
    displayName: `Deal ${terms.dealId.slice(0, 12)}`,
    issuerEntityHash: terms.issuerEntityHash,
    beneficiaryEntityHash: terms.beneficiaryEntityHash,
    servicerEntityHash: terms.servicerEntityHash,
    assetSetHash: terms.assetSetHash,
    sourceContractHash: terms.sourceContractHash,
    documentBundleHash: terms.documentBundleHash,
    bankRouteHash: terms.bankRouteHash,
    termsHash: terms.termsHash,
    oraclePolicyHash: terms.oraclePolicyHash,
    compliancePolicyHash: terms.compliancePolicyHash,
    settlementMint: terms.settlementMint,
    settlementTokenProgram: terms.settlementTokenProgram,
    settlementDecimals: terms.settlementDecimals,
    receiptMint: nullablePubkey(terms.receiptMint),
    receiptTokenProgram: nullablePubkey(terms.receiptTokenProgram),
    dealIdHash: terms.dealId,
    state: state.state,
    minimumRaiseBaseUnits: u64String(terms.minimumRaise, 'minimumRaise'),
    hardCapBaseUnits: u64String(terms.hardCap, 'hardCap'),
    fundedBaseUnits: u64String(fundedPrincipal, 'fundedPrincipal'),
    deployableBaseUnits: u64String(state.netDeployable, 'netDeployable'),
    grossSubscriptionsBaseUnits: u64String(
      state.grossSubscriptions,
      'grossSubscriptions',
    ),
    refundedPrincipalBaseUnits: u64String(
      state.refundedPrincipal,
      'refundedPrincipal',
    ),
    releasedBaseUnits: u64String(state.totalReleased, 'totalReleased'),
    repaidBaseUnits: u64String(state.accountedRepayments, 'accountedRepayments'),
    couponBps: terms.couponBps,
    feeBps: terms.feeBps,
    subscriptionOpenAt: timestampToIso(terms.subscriptionOpenAt),
    subscriptionCloseAt: timestampToIso(terms.subscriptionCloseAt),
    maturityAt: timestampToIso(terms.maturityAt),
    recoveryCutoffAt: timestampToIso(terms.recoveryCutoffAt),
    claimDeadlineAt: timestampToIso(terms.claimDeadlineAt),
    locked: terms.locked,
    issuerTreasuryOwner: terms.issuerTreasuryOwner,
    issuerTreasuryAta: terms.issuerTreasuryAta,
    chain,
    dealTermsChain: chainRef(termsAccount, context),
    dealTermsAccountHash: termsAccount.accountHash,
    dealStateAccountHash: stateAccount.accountHash,
    ...mirrorMetadata(mutableAccount, compositeHash),
  };
}

function milestoneStatus(milestone) {
  if (milestone.executed) return 'EXECUTED';
  if (milestone.cancelled) return 'CANCELLED';
  if (milestone.scheduledAt === 0n) return 'CONFIGURED';
  return 'SCHEDULED';
}

function mapMilestone(account, context) {
  const milestone = account.decoded;
  const index = String(milestone.index).padStart(4, '0');
  return {
    PK: `RWA#DEAL#${milestone.dealId}`,
    SK: `MILESTONE#${index}`,
    GSI1PK: `RWA#DEAL#${milestone.dealId}#MILESTONES`,
    GSI1SK: index,
    entityType: 'RWA_MILESTONE',
    dealId: milestone.dealId,
    index: milestone.index,
    gateKind: milestone.gateKind,
    allocationBps: milestone.allocationBps,
    amountBaseUnits: u64String(milestone.amount, 'milestone.amount'),
    gateAddress: nullablePubkey(milestone.gateAddress),
    gateRevision: milestone.gateRevision === 0 ? null : milestone.gateRevision,
    gateContentHash: nullableHash(milestone.gateContentHash),
    status: milestoneStatus(milestone),
    scheduledAt: timestampToIso(milestone.scheduledAt, true),
    executeAfter: timestampToIso(milestone.executeAfter, true),
    expiresAt: timestampToIso(milestone.expiresAt, true),
    executedAt: timestampToIso(milestone.executedAt, true),
    releaseSignatureHash: nullableHash(milestone.releaseSignatureHash),
    riskApprover: nullablePubkey(milestone.riskApprover),
    chain: chainRef(account, context),
    ...mirrorMetadata(account),
  };
}

function mapPosition(account, context) {
  const position = account.decoded;
  if (position.receiptsBurned > position.receiptsIssued) {
    throw new Error(
      `Position ${account.address} has burned more receipts than were issued`,
    );
  }
  const calculatedReceipts = position.receiptsIssued - position.receiptsBurned;
  const boundInvestorId = context.investorBindingsByWallet?.get(position.wallet);
  if (
    boundInvestorId
    && sha256Hex(Buffer.from(boundInvestorId, 'utf8')) !== position.investorId
  ) {
    throw new Error(
      `Position ${account.address} investor hash does not match its opaque wallet binding`,
    );
  }
  const investorId = boundInvestorId || position.investorId;
  return {
    PK: `RWA#DEAL#${position.dealId}`,
    SK: `POSITION#${investorId}`,
    GSI1PK: `RWA#DEAL#${position.dealId}#POSITIONS`,
    GSI1SK: investorId,
    GSI2PK: `RWA#WALLET#${position.wallet}`,
    GSI2SK: `DEAL#${position.dealId}`,
    entityType: 'RWA_POSITION',
    dealId: position.dealId,
    // The 32-byte protocol identifier is already opaque; no legal identity is indexed.
    investorId,
    investorIdHash: position.investorId,
    wallet: position.wallet,
    eligibilityStatus: position.eligibilityStatus,
    eligibilityExpiresAt: timestampToIso(position.eligibilityExpiresAt, true),
    acceptedTermsHash: position.acceptedTermsHash,
    contributionCapBaseUnits: u64String(position.contributionCap, 'contributionCap'),
    contributedBaseUnits: u64String(position.contributed, 'contributed'),
    receiptBaseUnits: u64String(calculatedReceipts, 'receiptBaseUnits'),
    receiptsIssuedBaseUnits: u64String(position.receiptsIssued, 'receiptsIssued'),
    receiptsBurnedBaseUnits: u64String(position.receiptsBurned, 'receiptsBurned'),
    refundedBaseUnits: u64String(position.refunded, 'refunded'),
    redeemedBaseUnits: u64String(position.redeemed, 'redeemed'),
    restrictedClaim: position.restrictedClaim,
    receiptAccountingBasis: 'ISSUED_MINUS_BURNED',
    receiptBalanceAuthoritative: false,
    chain: chainRef(account, context),
    ...mirrorMetadata(account),
  };
}

function mapSettlement(account, context) {
  const settlement = account.decoded;
  return {
    PK: `RWA#DEAL#${settlement.dealId}`,
    SK: 'SETTLEMENT',
    entityType: 'RWA_SETTLEMENT',
    dealId: settlement.dealId,
    supplySnapshotBaseUnits: u64String(
      settlement.supplySnapshot,
      'supplySnapshot',
    ),
    actualRepaymentBalanceBaseUnits: u64String(
      settlement.actualRepaymentBalance,
      'actualRepaymentBalance',
    ),
    investorPrincipalTargetBaseUnits: u64String(
      settlement.investorPrincipalTarget,
      'investorPrincipalTarget',
    ),
    investorReturnTargetBaseUnits: u64String(
      settlement.investorReturnTarget,
      'investorReturnTarget',
    ),
    investorPoolBaseUnits: u64String(settlement.investorPool, 'investorPool'),
    feePoolBaseUnits: u64String(settlement.feePool, 'feePool'),
    issuerResidualBaseUnits: u64String(
      settlement.issuerResidual,
      'issuerResidual',
    ),
    claimedBaseUnits: u64String(
      settlement.claimedInvestorPool,
      'claimedInvestorPool',
    ),
    restrictedEscrowBaseUnits: u64String(
      settlement.restrictedEscrowTotal,
      'restrictedEscrowTotal',
    ),
    dustBaseUnits: u64String(settlement.dustTotal, 'dustTotal'),
    defaulted: settlement.defaulted,
    finalizedAt: timestampToIso(settlement.finalizedAt),
    claimDeadlineAt: timestampToIso(settlement.claimDeadlineAt),
    chain: chainRef(account, context),
    ...mirrorMetadata(account),
  };
}

function movementUpdatedAt(movement, milestone) {
  const timestamps = [
    movement.reconciledAt,
    movement.bankConfirmedAt,
    movement.swiftSentAt,
    movement.convertedAt,
    milestone?.decoded.executedAt || 0n,
    movement.approvedAt,
    movement.proposedAt,
  ];
  return timestampToIso(timestamps.find((value) => value !== 0n) || 0n);
}

function mapTreasuryMovement(account, milestoneAccount, context) {
  const movement = account.decoded;
  const id = `chain_${account.address}`;
  const index = String(movement.milestoneIndex).padStart(4, '0');
  return {
    PK: `RWA#MOVEMENT#${id}`,
    SK: 'META',
    GSI1PK: `RWA#DEAL#${movement.dealId}#TREASURY`,
    GSI1SK: `${index}#ONCHAIN#${id}`,
    entityType: 'RWA_TREASURY_MOVEMENT',
    recordSource: 'SOLANA_FINALIZED',
    id,
    dealId: movement.dealId,
    milestoneIndex: movement.milestoneIndex,
    status: movement.status,
    releasedUsdcBaseUnits: u64String(movement.releasedUsdc, 'releasedUsdc'),
    releaseRecord: movement.releaseRecord,
    releaseSignatureHash: nullableHash(movement.releaseSignatureHash),
    grossUsdMinor: u64String(movement.grossUsdMinor, 'grossUsdMinor'),
    netUsdMinor: u64String(movement.netUsdMinor, 'netUsdMinor'),
    conversionRateE8: u64String(movement.conversionRateE8, 'conversionRateE8'),
    providerFeesUsdMinor: u64String(
      movement.providerFeesUsdMinor,
      'providerFeesUsdMinor',
    ),
    bankFeesUsdMinor: u64String(movement.bankFeesUsdMinor, 'bankFeesUsdMinor'),
    beneficiaryEntityHash: movement.beneficiaryEntityHash,
    bankRouteHash: movement.bankRouteHash,
    conversionProviderRefHash: nullableHash(movement.conversionProviderHash),
    swiftUetrHash: nullableHash(movement.swiftUetrHash),
    bankConfirmationHash: nullableHash(movement.bankConfirmationHash),
    treasuryApprovedBy: nullablePubkey(movement.treasuryApprover),
    riskApprovedBy: nullablePubkey(movement.riskApprover),
    proposedAt: timestampToIso(movement.proposedAt, true),
    approvedAt: timestampToIso(movement.approvedAt, true),
    convertedAt: timestampToIso(movement.convertedAt, true),
    swiftSentAt: timestampToIso(movement.swiftSentAt, true),
    bankConfirmedAt: timestampToIso(movement.bankConfirmedAt, true),
    reconciledAt: timestampToIso(movement.reconciledAt, true),
    updatedAt: movementUpdatedAt(movement, milestoneAccount),
    chain: chainRef(account, context),
    ...mirrorMetadata(account),
  };
}

function groupByDeal(accounts) {
  const grouped = new Map();
  for (const account of accounts) {
    const dealId = account.decoded.dealId;
    const collection = grouped.get(dealId) || [];
    collection.push(account);
    grouped.set(dealId, collection);
  }
  return grouped;
}

function buildMirrorItems(accountsByType, context) {
  const termsByDeal = new Map(
    accountsByType.DealTerms.map((account) => [account.decoded.dealId, account]),
  );
  const statesByDeal = new Map(
    accountsByType.DealStateAccount.map((account) => [account.decoded.dealId, account]),
  );
  const milestonesByDeal = groupByDeal(accountsByType.ReleaseMilestone);
  const milestoneByDealIndex = new Map(
    accountsByType.ReleaseMilestone.map((account) => [
      `${account.decoded.dealId}:${account.decoded.index}`,
      account,
    ]),
  );

  const items = [];
  const warnings = [];
  for (const [dealId, termsAccount] of termsByDeal) {
    const stateAccount = statesByDeal.get(dealId);
    if (!stateAccount) {
      warnings.push(`Deal ${dealId} has terms but no DealStateAccount; deal item skipped`);
      continue;
    }
    items.push(mapDeal(termsAccount, stateAccount, context));
  }
  for (const dealId of statesByDeal.keys()) {
    if (!termsByDeal.has(dealId)) {
      warnings.push(`Deal ${dealId} has state but no DealTerms; deal item skipped`);
    }
  }

  for (const account of accountsByType.ReleaseMilestone) {
    items.push(mapMilestone(account, context));
  }
  for (const account of accountsByType.InvestorDealPosition) {
    items.push(mapPosition(account, context));
  }
  for (const account of accountsByType.SettlementSnapshot) {
    items.push(mapSettlement(account, context));
  }
  for (const account of accountsByType.TreasuryMovement) {
    const key = `${account.decoded.dealId}:${account.decoded.milestoneIndex}`;
    items.push(mapTreasuryMovement(account, milestoneByDealIndex.get(key), context));
  }

  return {
    items,
    warnings,
    summary: {
      dealTerms: termsByDeal.size,
      dealStates: statesByDeal.size,
      deals: items.filter((item) => item.entityType === 'RWA_DEAL').length,
      milestoneDealGroups: milestonesByDeal.size,
      milestones: accountsByType.ReleaseMilestone.length,
      positions: accountsByType.InvestorDealPosition.length,
      settlements: accountsByType.SettlementSnapshot.length,
      treasuryMovements: accountsByType.TreasuryMovement.length,
    },
  };
}

module.exports = {
  buildMirrorItems,
  chainRef,
  mapDeal,
  mapMilestone,
  mapPosition,
  mapSettlement,
  mapTreasuryMovement,
  milestoneStatus,
  timestampToIso,
  u64String,
};
