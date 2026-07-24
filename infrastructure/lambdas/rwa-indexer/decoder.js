'use strict';

const crypto = require('node:crypto');

const ACCOUNT_SCHEMA_V1 = 1;
const RESERVED_ACCOUNT_BYTES = 64;
const ZERO_HEX_32 = '0'.repeat(64);
const ZERO_PUBKEY = '11111111111111111111111111111111';

const DEAL_STATES = Object.freeze([
  'DRAFT',
  'SUBSCRIPTION_OPEN',
  'FUNDED',
  'ACTIVE',
  'REPAID',
  'DEFAULT_RECOVERY',
  'REDEEMABLE',
  'CANCELLED_REFUNDABLE',
  'SETTLED',
]);

const ELIGIBILITY_STATUSES = Object.freeze([
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'REVOKED',
  'SANCTIONS_HOLD',
]);

const RELEASE_GATE_KINDS = Object.freeze([
  'CAPITAL_CLOSE',
  'T1_PASS',
  'T2_PASS',
  'T3_PASS',
]);

const TREASURY_MOVEMENT_STATUSES = Object.freeze([
  'PROPOSED',
  'APPROVED',
  'USDC_RELEASED',
  'CONVERTED',
  'SWIFT_SENT',
  'BANK_CONFIRMED',
  'RECONCILED',
  'FAILED',
  'RETURNED',
]);

// Byte order must match pod_rwa_common::MseRailKind and MseBeneficiaryStatus exactly.
const MSE_RAIL_KINDS = Object.freeze(['SQUADS_FIAT_FORWARD', 'DIRECT_USDC']);

const MSE_BENEFICIARY_STATUSES = Object.freeze(['ACTIVE', 'SUSPENDED']);

const ACCOUNT_NAMES = Object.freeze([
  'DealTerms',
  'DealStateAccount',
  'ReleaseMilestone',
  'InvestorDealPosition',
  'SettlementSnapshot',
  'TreasuryMovement',
  'MseBeneficiary',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function accountDiscriminator(name) {
  if (!ACCOUNT_NAMES.includes(name)) throw new Error(`Unsupported Anchor account: ${name}`);
  return sha256(Buffer.from(`account:${name}`, 'utf8')).subarray(0, 8);
}

const ACCOUNT_DISCRIMINATORS = Object.freeze(
  Object.fromEntries(ACCOUNT_NAMES.map((name) => [name, accountDiscriminator(name)])),
);

function base58Encode(value) {
  const bytes = Buffer.from(value);
  if (bytes.length === 0) return '';

  let numeric = 0n;
  for (const byte of bytes) numeric = (numeric << 8n) + BigInt(byte);

  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let encoded = '';
  while (numeric > 0n) {
    const remainder = Number(numeric % 58n);
    numeric /= 58n;
    encoded = alphabet[remainder] + encoded;
  }

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + encoded;
}

function base58Decode(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A non-empty base58 string is required');
  }

  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let numeric = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error(`Invalid base58 character: ${character}`);
    numeric = numeric * 58n + BigInt(digit);
  }

  let hex = numeric.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const body = numeric === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

function expectedVaultAccountAddress(name, decoded, programId) {
  const programBytes = base58Decode(programId);
  if (programBytes.length !== 32) throw new Error('Program id must decode to 32 bytes');
  if (!Number.isInteger(decoded.bump) || decoded.bump < 0 || decoded.bump > 255) {
    throw new Error(`${name} contains an invalid PDA bump`);
  }

  let seeds;
  if (name === 'DealTerms') {
    seeds = [Buffer.from('deal_terms'), Buffer.from(decoded.dealId, 'hex')];
  } else if (name === 'DealStateAccount') {
    seeds = [Buffer.from('deal_state'), Buffer.from(decoded.dealId, 'hex')];
  } else if (name === 'ReleaseMilestone') {
    seeds = [
      Buffer.from('milestone'),
      Buffer.from(decoded.dealId, 'hex'),
      Buffer.from([decoded.index]),
    ];
  } else if (name === 'InvestorDealPosition') {
    seeds = [
      Buffer.from('position'),
      Buffer.from(decoded.dealId, 'hex'),
      Buffer.from(decoded.investorId, 'hex'),
    ];
  } else if (name === 'SettlementSnapshot') {
    seeds = [Buffer.from('settlement'), Buffer.from(decoded.dealId, 'hex')];
  } else if (name === 'TreasuryMovement') {
    seeds = [
      Buffer.from('treasury_movement'),
      Buffer.from(decoded.dealId, 'hex'),
      Buffer.from([decoded.milestoneIndex]),
    ];
  } else if (name === 'MseBeneficiary') {
    seeds = [
      Buffer.from('mse-beneficiary'),
      Buffer.from(decoded.entityHash, 'hex'),
    ];
  } else {
    throw new Error(`Unsupported vault PDA account: ${name}`);
  }
  if (seeds.some((seed) => seed.length > 32)) throw new Error(`${name} contains an oversized PDA seed`);

  const address = sha256(Buffer.concat([
    ...seeds,
    Buffer.from([decoded.bump]),
    programBytes,
    Buffer.from('ProgramDerivedAddress', 'utf8'),
  ]));
  return base58Encode(address);
}

class Reader {
  constructor(value, accountName) {
    this.buffer = Buffer.from(value);
    this.accountName = accountName;
    this.offset = 0;
  }

  ensure(length, field) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.buffer.length) {
      throw new Error(
        `${this.accountName}.${field} is truncated at byte ${this.offset}; `
          + `${length} bytes required, ${this.buffer.length - this.offset} available`,
      );
    }
  }

  bytes(length, field) {
    this.ensure(length, field);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(field) {
    return this.bytes(1, field)[0];
  }

  bool(field) {
    const value = this.u8(field);
    if (value !== 0 && value !== 1) {
      throw new Error(`${this.accountName}.${field} contains invalid Borsh bool ${value}`);
    }
    return value === 1;
  }

  u16(field) {
    this.ensure(2, field);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(field) {
    this.ensure(4, field);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(field) {
    this.ensure(8, field);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64(field) {
    this.ensure(8, field);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  hash(field) {
    return this.bytes(32, field).toString('hex');
  }

  pubkey(field) {
    return base58Encode(this.bytes(32, field));
  }

  enum(variants, field) {
    const index = this.u8(field);
    if (index >= variants.length) {
      throw new Error(`${this.accountName}.${field} contains unknown enum variant ${index}`);
    }
    return variants[index];
  }

  discriminator() {
    const actual = this.bytes(8, 'discriminator');
    const expected = ACCOUNT_DISCRIMINATORS[this.accountName];
    if (!crypto.timingSafeEqual(actual, expected)) {
      throw new Error(
        `${this.accountName} discriminator mismatch: expected ${expected.toString('hex')}, `
          + `received ${actual.toString('hex')}`,
      );
    }
  }

  schemaVersion() {
    const value = this.u16('schemaVersion');
    if (value !== ACCOUNT_SCHEMA_V1) {
      throw new Error(`${this.accountName} schema ${value} is unsupported; expected V1`);
    }
    return value;
  }

  reserved() {
    this.bytes(RESERVED_ACCOUNT_BYTES, 'reserved');
  }
}

function decodeDealTerms(value) {
  const reader = new Reader(value, 'DealTerms');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    issuerEntityHash: reader.hash('issuerEntityHash'),
    beneficiaryEntityHash: reader.hash('beneficiaryEntityHash'),
    servicerEntityHash: reader.hash('servicerEntityHash'),
    assetSetHash: reader.hash('assetSetHash'),
    sourceContractHash: reader.hash('sourceContractHash'),
    documentBundleHash: reader.hash('documentBundleHash'),
    bankRouteHash: reader.hash('bankRouteHash'),
    termsHash: reader.hash('termsHash'),
    oraclePolicyHash: reader.hash('oraclePolicyHash'),
    compliancePolicyHash: reader.hash('compliancePolicyHash'),
    commodityValuation: reader.pubkey('commodityValuation'),
    fxValuation: reader.pubkey('fxValuation'),
    settlementAsset: reader.pubkey('settlementAsset'),
    settlementMint: reader.pubkey('settlementMint'),
    settlementTokenProgram: reader.pubkey('settlementTokenProgram'),
    settlementDecimals: reader.u8('settlementDecimals'),
    receiptMint: reader.pubkey('receiptMint'),
    receiptTokenProgram: reader.pubkey('receiptTokenProgram'),
    subscriptionVault: reader.pubkey('subscriptionVault'),
    repaymentVault: reader.pubkey('repaymentVault'),
    mseWalletOwner: reader.pubkey('mseWalletOwner'),
    mseUsdcAta: reader.pubkey('mseUsdcAta'),
    mseRailKind: reader.enum(MSE_RAIL_KINDS, 'mseRailKind'),
    servicerAuthority: reader.pubkey('servicerAuthority'),
    riskAuthority: reader.pubkey('riskAuthority'),
    complianceEscrowAta: reader.pubkey('complianceEscrowAta'),
    subscriptionOpenAt: reader.i64('subscriptionOpenAt'),
    subscriptionCloseAt: reader.i64('subscriptionCloseAt'),
    maturityAt: reader.i64('maturityAt'),
    recoveryCutoffAt: reader.i64('recoveryCutoffAt'),
    claimDeadlineAt: reader.i64('claimDeadlineAt'),
    minimumRaise: reader.u64('minimumRaise'),
    hardCap: reader.u64('hardCap'),
    couponBps: reader.u16('couponBps'),
    feeBps: reader.u16('feeBps'),
    releaseDelaySeconds: reader.u32('releaseDelaySeconds'),
    milestoneCount: reader.u8('milestoneCount'),
    locked: reader.bool('locked'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeDealStateAccount(value) {
  const reader = new Reader(value, 'DealStateAccount');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    state: reader.enum(DEAL_STATES, 'state'),
    grossSubscriptions: reader.u64('grossSubscriptions'),
    refundedPrincipal: reader.u64('refundedPrincipal'),
    netDeployable: reader.u64('netDeployable'),
    totalReleased: reader.u64('totalReleased'),
    accountedRepayments: reader.u64('accountedRepayments'),
    unallocatedSurplus: reader.u64('unallocatedSurplus'),
    investorPool: reader.u64('investorPool'),
    feePool: reader.u64('feePool'),
    issuerResidual: reader.u64('issuerResidual'),
    redeemedTotal: reader.u64('redeemedTotal'),
    receiptSupplySnapshot: reader.u64('receiptSupplySnapshot'),
    repaymentTarget: reader.u64('repaymentTarget'),
    milestoneBpsTotal: reader.u16('milestoneBpsTotal'),
    configuredMilestones: reader.u8('configuredMilestones'),
    nextMilestoneIndex: reader.u8('nextMilestoneIndex'),
    executedMilestones: reader.u8('executedMilestones'),
    mintAuthorityRevoked: reader.bool('mintAuthorityRevoked'),
    settlementFinalized: reader.bool('settlementFinalized'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeReleaseMilestone(value) {
  const reader = new Reader(value, 'ReleaseMilestone');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    index: reader.u8('index'),
    gateKind: reader.enum(RELEASE_GATE_KINDS, 'gateKind'),
    allocationBps: reader.u16('allocationBps'),
    amount: reader.u64('amount'),
    gateAddress: reader.pubkey('gateAddress'),
    gateRevision: reader.u32('gateRevision'),
    gateContentHash: reader.hash('gateContentHash'),
    riskApprover: reader.pubkey('riskApprover'),
    scheduledAt: reader.i64('scheduledAt'),
    executeAfter: reader.i64('executeAfter'),
    expiresAt: reader.i64('expiresAt'),
    cancelled: reader.bool('cancelled'),
    executed: reader.bool('executed'),
    executedAt: reader.i64('executedAt'),
    releaseSignatureHash: reader.hash('releaseSignatureHash'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeInvestorDealPosition(value) {
  const reader = new Reader(value, 'InvestorDealPosition');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    investorId: reader.hash('investorId'),
    wallet: reader.pubkey('wallet'),
    eligibilityStatus: reader.enum(ELIGIBILITY_STATUSES, 'eligibilityStatus'),
    eligibilityExpiresAt: reader.i64('eligibilityExpiresAt'),
    acceptedTermsHash: reader.hash('acceptedTermsHash'),
    contributionCap: reader.u64('contributionCap'),
    contributed: reader.u64('contributed'),
    receiptsIssued: reader.u64('receiptsIssued'),
    receiptsBurned: reader.u64('receiptsBurned'),
    refunded: reader.u64('refunded'),
    redeemed: reader.u64('redeemed'),
    restrictedClaim: reader.bool('restrictedClaim'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeSettlementSnapshot(value) {
  const reader = new Reader(value, 'SettlementSnapshot');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    finalizedAt: reader.i64('finalizedAt'),
    claimDeadlineAt: reader.i64('claimDeadlineAt'),
    supplySnapshot: reader.u64('supplySnapshot'),
    actualRepaymentBalance: reader.u64('actualRepaymentBalance'),
    investorPrincipalTarget: reader.u64('investorPrincipalTarget'),
    investorReturnTarget: reader.u64('investorReturnTarget'),
    investorPool: reader.u64('investorPool'),
    feePool: reader.u64('feePool'),
    issuerResidual: reader.u64('issuerResidual'),
    claimedInvestorPool: reader.u64('claimedInvestorPool'),
    restrictedEscrowTotal: reader.u64('restrictedEscrowTotal'),
    dustTotal: reader.u64('dustTotal'),
    defaulted: reader.bool('defaulted'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeTreasuryMovement(value) {
  const reader = new Reader(value, 'TreasuryMovement');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    dealId: reader.hash('dealId'),
    milestoneIndex: reader.u8('milestoneIndex'),
    status: reader.enum(TREASURY_MOVEMENT_STATUSES, 'status'),
    railKind: reader.enum(MSE_RAIL_KINDS, 'railKind'),
    releasedUsdc: reader.u64('releasedUsdc'),
    releaseRecord: reader.pubkey('releaseRecord'),
    releaseSignatureHash: reader.hash('releaseSignatureHash'),
    conversionProviderHash: reader.hash('conversionProviderHash'),
    grossUsdMinor: reader.u64('grossUsdMinor'),
    netUsdMinor: reader.u64('netUsdMinor'),
    conversionRateE8: reader.u64('conversionRateE8'),
    providerFeesUsdMinor: reader.u64('providerFeesUsdMinor'),
    bankFeesUsdMinor: reader.u64('bankFeesUsdMinor'),
    beneficiaryEntityHash: reader.hash('beneficiaryEntityHash'),
    bankRouteHash: reader.hash('bankRouteHash'),
    swiftUetrHash: reader.hash('swiftUetrHash'),
    bankConfirmationHash: reader.hash('bankConfirmationHash'),
    treasuryApprover: reader.pubkey('treasuryApprover'),
    riskApprover: reader.pubkey('riskApprover'),
    proposedAt: reader.i64('proposedAt'),
    approvedAt: reader.i64('approvedAt'),
    convertedAt: reader.i64('convertedAt'),
    swiftSentAt: reader.i64('swiftSentAt'),
    bankConfirmedAt: reader.i64('bankConfirmedAt'),
    reconciledAt: reader.i64('reconciledAt'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

function decodeMseBeneficiary(value) {
  const reader = new Reader(value, 'MseBeneficiary');
  reader.discriminator();
  const result = {
    schemaVersion: reader.schemaVersion(),
    entityHash: reader.hash('entityHash'),
    walletOwner: reader.pubkey('walletOwner'),
    usdcAta: reader.pubkey('usdcAta'),
    railKind: reader.enum(MSE_RAIL_KINDS, 'railKind'),
    status: reader.enum(MSE_BENEFICIARY_STATUSES, 'status'),
    registeredAtSlot: reader.u64('registeredAtSlot'),
    updatedAtSlot: reader.u64('updatedAtSlot'),
    bump: reader.u8('bump'),
  };
  reader.reserved();
  return result;
}

const DECODERS = Object.freeze({
  DealTerms: decodeDealTerms,
  DealStateAccount: decodeDealStateAccount,
  ReleaseMilestone: decodeReleaseMilestone,
  InvestorDealPosition: decodeInvestorDealPosition,
  SettlementSnapshot: decodeSettlementSnapshot,
  TreasuryMovement: decodeTreasuryMovement,
  MseBeneficiary: decodeMseBeneficiary,
});

function decodeAccount(name, value) {
  const decoder = DECODERS[name];
  if (!decoder) throw new Error(`Unsupported account decoder: ${name}`);
  return decoder(value);
}

module.exports = {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_NAMES,
  ACCOUNT_SCHEMA_V1,
  DEAL_STATES,
  ELIGIBILITY_STATUSES,
  RELEASE_GATE_KINDS,
  TREASURY_MOVEMENT_STATUSES,
  MSE_RAIL_KINDS,
  MSE_BENEFICIARY_STATUSES,
  ZERO_HEX_32,
  ZERO_PUBKEY,
  accountDiscriminator,
  base58Decode,
  base58Encode,
  decodeAccount,
  decodeDealStateAccount,
  decodeDealTerms,
  decodeInvestorDealPosition,
  decodeMseBeneficiary,
  decodeReleaseMilestone,
  decodeSettlementSnapshot,
  decodeTreasuryMovement,
  expectedVaultAccountAddress,
};
