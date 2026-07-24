'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACCOUNT_DISCRIMINATORS,
  base58Encode,
  decodeDealStateAccount,
  decodeDealTerms,
  decodeInvestorDealPosition,
  decodeMseBeneficiary,
  decodeReleaseMilestone,
  decodeSettlementSnapshot,
  decodeTreasuryMovement,
} = require('./decoder');

class Writer {
  constructor(accountName) {
    this.parts = [ACCOUNT_DISCRIMINATORS[accountName]];
  }

  bytes(value) {
    this.parts.push(Buffer.from(value));
    return this;
  }

  u8(value) {
    const part = Buffer.alloc(1);
    part.writeUInt8(value);
    return this.bytes(part);
  }

  bool(value) {
    return this.u8(value ? 1 : 0);
  }

  u16(value) {
    const part = Buffer.alloc(2);
    part.writeUInt16LE(value);
    return this.bytes(part);
  }

  u32(value) {
    const part = Buffer.alloc(4);
    part.writeUInt32LE(value);
    return this.bytes(part);
  }

  u64(value) {
    const part = Buffer.alloc(8);
    part.writeBigUInt64LE(BigInt(value));
    return this.bytes(part);
  }

  i64(value) {
    const part = Buffer.alloc(8);
    part.writeBigInt64LE(BigInt(value));
    return this.bytes(part);
  }

  hash(seed) {
    return this.bytes(Buffer.alloc(32, seed));
  }

  pubkey(seed) {
    return this.bytes(Buffer.alloc(32, seed));
  }

  reserved() {
    return this.bytes(Buffer.alloc(64));
  }

  finish(extraAllocationBytes = 0) {
    return Buffer.concat([...this.parts, Buffer.alloc(extraAllocationBytes)]);
  }
}

const hash = (seed) => Buffer.alloc(32, seed).toString('hex');
const pubkey = (seed) => base58Encode(Buffer.alloc(32, seed));

function dealTermsFixture() {
  const writer = new Writer('DealTerms').u16(1);
  for (let seed = 1; seed <= 11; seed += 1) writer.hash(seed);
  for (let seed = 12; seed <= 16; seed += 1) writer.pubkey(seed);
  writer.u8(6);
  // receiptMint..mseUsdcAta (seeds 17-22), then the MSE rail-kind discriminant,
  // then servicerAuthority..complianceEscrowAta (seeds 23-25).
  for (let seed = 17; seed <= 22; seed += 1) writer.pubkey(seed);
  writer.u8(1);
  for (let seed = 23; seed <= 25; seed += 1) writer.pubkey(seed);
  return writer
    .i64(1_700_000_000)
    .i64(1_700_100_000)
    .i64(1_701_000_000)
    .i64(1_702_000_000)
    .i64(1_703_000_000)
    .u64(20_000_000)
    .u64(30_000_000)
    .u16(1_000)
    .u16(125)
    .u32(86_400)
    .u8(4)
    .bool(true)
    .u8(254)
    .reserved()
    .finish(601);
}

function dealStateFixture() {
  return new Writer('DealStateAccount')
    .u16(1)
    .hash(1)
    .u8(3)
    .u64(30_000_000)
    .u64(1_000_000)
    .u64(29_000_000)
    .u64(9_000_000)
    .u64(33_000_000)
    .u64(1)
    .u64(33_000_000)
    .u64(0)
    .u64(0)
    .u64(16_500_000)
    .u64(30_000_000)
    .u64(33_000_000)
    .u16(10_000)
    .u8(4)
    .u8(1)
    .u8(1)
    .bool(true)
    .bool(false)
    .u8(253)
    .reserved()
    .finish(565);
}

function milestoneFixture() {
  return new Writer('ReleaseMilestone')
    .u16(1)
    .hash(1)
    .u8(2)
    .u8(2)
    .u16(3_000)
    .u64(9_000_000)
    .pubkey(24)
    .u32(7)
    .hash(25)
    .pubkey(26)
    .i64(1_700_000_000)
    .i64(1_700_086_400)
    .i64(1_700_172_800)
    .bool(false)
    .bool(true)
    .i64(1_700_090_000)
    .hash(27)
    .u8(252)
    .reserved()
    .finish(363);
}

function positionFixture() {
  return new Writer('InvestorDealPosition')
    .u16(1)
    .hash(1)
    .hash(28)
    .pubkey(29)
    .u8(4)
    .i64(1_800_000_000)
    .hash(9)
    .u64(15_000_000)
    .u64(15_000_000)
    .u64(15_000_000)
    .u64(2_000_000)
    .u64(0)
    .u64(2_200_000)
    .bool(true)
    .u8(251)
    .reserved()
    .finish(387);
}

function settlementFixture() {
  return new Writer('SettlementSnapshot')
    .u16(1)
    .hash(1)
    .i64(1_710_000_000)
    .i64(1_720_000_000)
    .u64(30_000_000)
    .u64(33_000_001)
    .u64(30_000_000)
    .u64(33_000_000)
    .u64(33_000_000)
    .u64(0)
    .u64(1)
    .u64(16_500_000)
    .u64(2_000_000)
    .u64(1)
    .bool(false)
    .u8(250)
    .reserved()
    .finish(444);
}

function treasuryMovementFixture() {
  return new Writer('TreasuryMovement')
    .u16(1)
    .hash(1)
    .u8(1)
    .u8(6)
    .u8(0)
    .u64(9_000_000)
    .pubkey(30)
    .hash(31)
    .hash(32)
    .u64(900_000)
    .u64(890_000)
    .u64(100_000_000)
    .u64(5_000)
    .u64(5_000)
    .hash(3)
    .hash(8)
    .hash(33)
    .hash(34)
    .pubkey(35)
    .pubkey(36)
    .i64(1_700_000_000)
    .i64(1_700_000_100)
    .i64(1_700_001_000)
    .i64(1_700_002_000)
    .i64(1_700_003_000)
    .i64(1_700_004_000)
    .u8(249)
    .reserved()
    .finish(410);
}

function mseBeneficiaryFixture() {
  return new Writer('MseBeneficiary')
    .u16(1)
    .hash(40)
    .pubkey(41)
    .pubkey(42)
    .u8(1)
    .u8(0)
    .u64(1_700_500_000)
    .u64(1_700_600_000)
    .u8(248)
    .reserved()
    .finish(75);
}

test('Anchor account discriminator constants are stable', () => {
  assert.equal(ACCOUNT_DISCRIMINATORS.DealTerms.toString('hex'), '6f3e2fd8cdaa8188');
  assert.equal(
    ACCOUNT_DISCRIMINATORS.DealStateAccount.toString('hex'),
    'dcc8064b23682dbd',
  );
  assert.equal(
    ACCOUNT_DISCRIMINATORS.ReleaseMilestone.toString('hex'),
    '2044640fa930fa9d',
  );
  assert.equal(
    ACCOUNT_DISCRIMINATORS.InvestorDealPosition.toString('hex'),
    '22a48327b39ec615',
  );
  assert.equal(
    ACCOUNT_DISCRIMINATORS.SettlementSnapshot.toString('hex'),
    'eeb6590d601f85c4',
  );
  assert.equal(
    ACCOUNT_DISCRIMINATORS.TreasuryMovement.toString('hex'),
    'b00809ab299bb77d',
  );
});

test('binary fixtures match the Rust account allocation constants', () => {
  assert.equal(dealTermsFixture().length, 8 + 1_536);
  assert.equal(dealStateFixture().length, 8 + 768);
  assert.equal(milestoneFixture().length, 8 + 640);
  assert.equal(positionFixture().length, 8 + 640);
  assert.equal(settlementFixture().length, 8 + 640);
  assert.equal(treasuryMovementFixture().length, 8 + 896);
  assert.equal(mseBeneficiaryFixture().length, 8 + 256);
});

test('decodes DealTerms V1 with allocated trailing space', () => {
  const decoded = decodeDealTerms(dealTermsFixture());
  assert.equal(decoded.schemaVersion, 1);
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.issuerEntityHash, hash(2));
  assert.equal(decoded.beneficiaryEntityHash, hash(3));
  assert.equal(decoded.compliancePolicyHash, hash(11));
  assert.equal(decoded.settlementMint, pubkey(15));
  assert.equal(decoded.settlementTokenProgram, pubkey(16));
  assert.equal(decoded.receiptMint, pubkey(17));
  assert.equal(decoded.subscriptionVault, pubkey(19));
  assert.equal(decoded.repaymentVault, pubkey(20));
  assert.equal(decoded.mseWalletOwner, pubkey(21));
  assert.equal(decoded.mseUsdcAta, pubkey(22));
  assert.equal(decoded.mseRailKind, 'DIRECT_USDC');
  assert.equal(decoded.servicerAuthority, pubkey(23));
  assert.equal(decoded.settlementDecimals, 6);
  assert.equal(decoded.minimumRaise, 20_000_000n);
  assert.equal(decoded.hardCap, 30_000_000n);
  assert.equal(decoded.couponBps, 1_000);
  assert.equal(decoded.feeBps, 125);
  assert.equal(decoded.releaseDelaySeconds, 86_400);
  assert.equal(decoded.milestoneCount, 4);
  assert.equal(decoded.locked, true);
  assert.equal(decoded.bump, 254);
});

test('decodes DealStateAccount V1 and its enum/flags', () => {
  const decoded = decodeDealStateAccount(dealStateFixture());
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.state, 'ACTIVE');
  assert.equal(decoded.grossSubscriptions, 30_000_000n);
  assert.equal(decoded.refundedPrincipal, 1_000_000n);
  assert.equal(decoded.netDeployable, 29_000_000n);
  assert.equal(decoded.accountedRepayments, 33_000_000n);
  assert.equal(decoded.receiptSupplySnapshot, 30_000_000n);
  assert.equal(decoded.milestoneBpsTotal, 10_000);
  assert.equal(decoded.nextMilestoneIndex, 1);
  assert.equal(decoded.mintAuthorityRevoked, true);
  assert.equal(decoded.settlementFinalized, false);
});

test('decodes ReleaseMilestone V1', () => {
  const decoded = decodeReleaseMilestone(milestoneFixture());
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.index, 2);
  assert.equal(decoded.gateKind, 'T2_PASS');
  assert.equal(decoded.allocationBps, 3_000);
  assert.equal(decoded.amount, 9_000_000n);
  assert.equal(decoded.gateAddress, pubkey(24));
  assert.equal(decoded.gateRevision, 7);
  assert.equal(decoded.gateContentHash, hash(25));
  assert.equal(decoded.executed, true);
  assert.equal(decoded.cancelled, false);
  assert.equal(decoded.releaseSignatureHash, hash(27));
});

test('decodes InvestorDealPosition V1 without revealing legal identity', () => {
  const decoded = decodeInvestorDealPosition(positionFixture());
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.investorId, hash(28));
  assert.equal(decoded.wallet, pubkey(29));
  assert.equal(decoded.eligibilityStatus, 'SANCTIONS_HOLD');
  assert.equal(decoded.contributionCap, 15_000_000n);
  assert.equal(decoded.receiptsIssued, 15_000_000n);
  assert.equal(decoded.receiptsBurned, 2_000_000n);
  assert.equal(decoded.redeemed, 2_200_000n);
  assert.equal(decoded.restrictedClaim, true);
});

test('decodes SettlementSnapshot V1', () => {
  const decoded = decodeSettlementSnapshot(settlementFixture());
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.supplySnapshot, 30_000_000n);
  assert.equal(decoded.actualRepaymentBalance, 33_000_001n);
  assert.equal(decoded.investorPool, 33_000_000n);
  assert.equal(decoded.claimedInvestorPool, 16_500_000n);
  assert.equal(decoded.restrictedEscrowTotal, 2_000_000n);
  assert.equal(decoded.dustTotal, 1n);
  assert.equal(decoded.defaulted, false);
});

test('decodes TreasuryMovement V1', () => {
  const decoded = decodeTreasuryMovement(treasuryMovementFixture());
  assert.equal(decoded.dealId, hash(1));
  assert.equal(decoded.milestoneIndex, 1);
  assert.equal(decoded.status, 'RECONCILED');
  assert.equal(decoded.railKind, 'SQUADS_FIAT_FORWARD');
  assert.equal(decoded.releasedUsdc, 9_000_000n);
  assert.equal(decoded.releaseRecord, pubkey(30));
  assert.equal(decoded.releaseSignatureHash, hash(31));
  assert.equal(decoded.conversionProviderHash, hash(32));
  assert.equal(decoded.grossUsdMinor, 900_000n);
  assert.equal(decoded.netUsdMinor, 890_000n);
  assert.equal(decoded.providerFeesUsdMinor, 5_000n);
  assert.equal(decoded.bankFeesUsdMinor, 5_000n);
  assert.equal(decoded.swiftUetrHash, hash(33));
  assert.equal(decoded.bankConfirmationHash, hash(34));
  assert.equal(decoded.treasuryApprover, pubkey(35));
  assert.equal(decoded.riskApprover, pubkey(36));
  assert.equal(decoded.reconciledAt, 1_700_004_000n);
});

test('decodes MseBeneficiary V1', () => {
  const decoded = decodeMseBeneficiary(mseBeneficiaryFixture());
  assert.equal(decoded.schemaVersion, 1);
  assert.equal(decoded.entityHash, hash(40));
  assert.equal(decoded.walletOwner, pubkey(41));
  assert.equal(decoded.usdcAta, pubkey(42));
  assert.equal(decoded.railKind, 'DIRECT_USDC');
  assert.equal(decoded.status, 'ACTIVE');
  assert.equal(decoded.registeredAtSlot, 1_700_500_000n);
  assert.equal(decoded.updatedAtSlot, 1_700_600_000n);
  assert.equal(decoded.bump, 248);
});

test('rejects an MseBeneficiary with an unknown rail-kind discriminant', () => {
  const corrupt = mseBeneficiaryFixture();
  // discriminator(8) + schema(2) + entityHash(32) + walletOwner(32) + usdcAta(32)
  corrupt[8 + 2 + 32 + 32 + 32] = 9;
  assert.throws(() => decodeMseBeneficiary(corrupt), /unknown enum variant 9/);
});

test('rejects wrong discriminator, unsupported schema, unknown enums, and truncation', () => {
  const wrongDiscriminator = dealTermsFixture();
  wrongDiscriminator[0] ^= 0xff;
  assert.throws(() => decodeDealTerms(wrongDiscriminator), /discriminator mismatch/);

  const unsupportedSchema = dealTermsFixture();
  unsupportedSchema.writeUInt16LE(2, 8);
  assert.throws(() => decodeDealTerms(unsupportedSchema), /schema 2 is unsupported/);

  const unknownState = dealStateFixture();
  unknownState[8 + 2 + 32] = 99;
  assert.throws(() => decodeDealStateAccount(unknownState), /unknown enum variant 99/);

  assert.throws(
    () => decodeTreasuryMovement(treasuryMovementFixture().subarray(0, 100)),
    /is truncated/,
  );
});
