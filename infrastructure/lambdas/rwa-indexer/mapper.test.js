'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { mapPosition } = require('./mapper');

const context = {
  clusterGenesis: 'test-genesis',
  programId: 'test-program',
  reconciledAt: '2026-07-23T18:00:00.000Z',
  nowUnixSeconds: 1_800_000_000n,
};

function positionAccount(overrides = {}) {
  return {
    address: 'position-address',
    slot: 123,
    signature: 'finalized-signature',
    accountHash: 'ab'.repeat(32),
    decoded: {
      schemaVersion: 1,
      dealId: '01'.repeat(32),
      investorId: '02'.repeat(32),
      wallet: 'wallet-address',
      eligibilityStatus: 'ACTIVE',
      eligibilityExpiresAt: 1_900_000_000n,
      acceptedTermsHash: '03'.repeat(32),
      contributionCap: 15_000_000n,
      contributed: 15_000_000n,
      receiptsIssued: 15_000_000n,
      receiptsBurned: 2_000_000n,
      refunded: 0n,
      redeemed: 2_200_000n,
      restrictedClaim: false,
      bump: 1,
      ...overrides,
    },
  };
}

test('position mirror uses issued-minus-burned and flags it as non-authoritative', () => {
  const item = mapPosition(positionAccount(), context);
  assert.equal(item.receiptBaseUnits, '13000000');
  assert.equal(item.receiptsIssuedBaseUnits, '15000000');
  assert.equal(item.receiptsBurnedBaseUnits, '2000000');
  assert.equal(item.receiptAccountingBasis, 'ISSUED_MINUS_BURNED');
  assert.equal(item.receiptBalanceAuthoritative, false);
  assert.equal(item.investorId, '02'.repeat(32));
  assert.equal(item.chain.finalizedSlot, '123');
});

test('position mirror rejects impossible burn accounting', () => {
  assert.throws(
    () => mapPosition(positionAccount({
      receiptsIssued: 1n,
      receiptsBurned: 2n,
    }), context),
    /burned more receipts than were issued/,
  );
});

test('position mirror joins the opaque wallet binding expected by GraphQL', () => {
  const opaqueInvestorId = 'investor_d4c253184c6d67eb122c9559';
  const investorHash = crypto
    .createHash('sha256')
    .update(opaqueInvestorId)
    .digest('hex');
  const account = positionAccount({ investorId: investorHash });
  const item = mapPosition(account, {
    ...context,
    investorBindingsByWallet: new Map([[account.decoded.wallet, opaqueInvestorId]]),
  });
  assert.equal(item.SK, `POSITION#${opaqueInvestorId}`);
  assert.equal(item.investorId, opaqueInvestorId);
  assert.equal(item.investorIdHash, investorHash);
});

test('position mirror rejects a wallet binding whose opaque id hashes differently', () => {
  assert.throws(
    () => mapPosition(positionAccount(), {
      ...context,
      investorBindingsByWallet: new Map([['wallet-address', 'wrong-investor']]),
    }),
    /investor hash does not match its opaque wallet binding/,
  );
});
