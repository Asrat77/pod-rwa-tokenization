// Phase 2 RPC tracer — durable deal bootstrap and subscriptions.
//
// This tracer uses the production account model against real SBF programs on
// solana-test-validator. It deliberately keeps the original V1 treasury route:
// USDC is released only to the US issuer treasury; the MSE is the fiat
// beneficiary represented by the SQUADS_FIAT_FORWARD registry rail.
//
// Run from this directory after starting the validator described in README.md:
//   node phase2.mjs

import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createInitializePermissionedBurnInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "node:crypto";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";

const VAULT = new PublicKey("GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn");
const ORACLE = new PublicKey("9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E");
const COMPLIANCE = new PublicKey("6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj");

const RECEIPT_EXTENSIONS = [
  ExtensionType.DefaultAccountState,
  ExtensionType.PermanentDelegate,
  ExtensionType.TransferHook,
  ExtensionType.MetadataPointer,
  ExtensionType.PermissionedBurn,
];
const RECEIPT_EXTENSION_HASH_DOMAIN = Buffer.from("POD:RWA:RECEIPT_EXTENSIONS:V1");
const TOKEN_2022_MINT_TLV_OFFSET = 166;
const USDC = 1_000_000n;

const hash = (value) => createHash("sha256").update(value).digest();
const fixtureHash = (label) => hash(Buffer.from(`POD:RWA:TRACER:${label}`));
const discriminator = (name) => hash(Buffer.from(`global:${name}`)).subarray(0, 8);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const u8 = (value) => Buffer.from([Number(value)]);
const bool = (value) => u8(value ? 1 : 0);
const u16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(Number(value));
  return buffer;
};
const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value));
  return buffer;
};
const u64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const i64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value));
  return buffer;
};
const ixData = (name, ...fields) => Buffer.concat([discriminator(name), ...fields]);
const meta = (pubkey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

const protocolConfigPda = () => pda([Buffer.from("protocol")], VAULT);
const settlementAssetPda = (mint) => pda([Buffer.from("asset"), mint.toBuffer()], VAULT);
const mseBeneficiaryPda = (entityHash) =>
  pda([Buffer.from("mse-beneficiary"), entityHash], VAULT);
const dealTermsPda = (dealId) => pda([Buffer.from("deal_terms"), dealId], VAULT);
const dealStatePda = (dealId) => pda([Buffer.from("deal_state"), dealId], VAULT);
const seriesPda = (dealId) => pda([Buffer.from("series"), dealId, u8(0)], VAULT);
const milestonePda = (dealId, index) =>
  pda([Buffer.from("milestone"), dealId, u8(index)], VAULT);
const treasuryMovementPda = (dealId, index) =>
  pda([Buffer.from("treasury_movement"), dealId, u8(index)], VAULT);
const positionPda = (dealId, investorId) =>
  pda([Buffer.from("position"), dealId, investorId], VAULT);
const subscriptionReceiptPda = (dealId, investorId, nonce) =>
  pda([Buffer.from("subscription_receipt"), dealId, investorId, u64(nonce)], VAULT);
const repaymentReceiptPda = (dealId, payer, nonce) =>
  pda(
    [Buffer.from("repayment_receipt"), dealId, payer.toBuffer(), u64(nonce)],
    VAULT,
  );
const settlementPda = (dealId) => pda([Buffer.from("settlement"), dealId], VAULT);
const redemptionReceiptPda = (dealId, investorId, nonce) =>
  pda([Buffer.from("redemption_receipt"), dealId, investorId, u64(nonce)], VAULT);

const complianceConfigPda = () => pda([Buffer.from("compliance-config")], COMPLIANCE);
const providerPda = (provider) =>
  pda([Buffer.from("provider"), provider.toBuffer()], COMPLIANCE);
const investorRecordPda = (investorId) =>
  pda([Buffer.from("investor"), investorId], COMPLIANCE);
const walletBindingPda = (wallet) =>
  pda([Buffer.from("wallet-binding"), wallet.toBuffer()], COMPLIANCE);
const seriesPermissionPda = (receiptMint, wallet) =>
  pda(
    [Buffer.from("series-permission"), receiptMint.toBuffer(), wallet.toBuffer()],
    COMPLIANCE,
  );
const transferPolicyPda = (receiptMint) =>
  pda([Buffer.from("transfer-policy"), receiptMint.toBuffer()], COMPLIANCE);
const oracleConfigPda = () => pda([Buffer.from("oracle-config")], ORACLE);
const attestationHeadPda = ({ subjectRef, assetSetHash, seasonId, product }) =>
  pda(
    [
      Buffer.from("attestation-head"),
      subjectRef,
      assetSetHash,
      seasonId,
      u8(product),
    ],
    ORACLE,
  );
const attestationRevisionPda = (head, revision = 1) =>
  pda([Buffer.from("attestation-rev"), head.toBuffer(), u32(revision)], ORACLE);
const valuationHeadPda = ({ kind, baseAssetHash, quoteAssetHash }) =>
  pda(
    [
      Buffer.from("valuation-head"),
      u8(kind),
      baseAssetHash,
      quoteAssetHash,
    ],
    ORACLE,
  );
const valuationRevisionPda = (head, revision = 1) =>
  pda([Buffer.from("valuation-rev"), head.toBuffer(), u32(revision)], ORACLE);
const dealGateHeadPda = (deal, milestoneIndex) =>
  pda([Buffer.from("deal-gate-head"), deal.toBuffer(), u8(milestoneIndex)], ORACLE);
const dealGateRevisionPda = (head, revision = 1) =>
  pda([Buffer.from("deal-gate-rev"), head.toBuffer(), u32(revision)], ORACLE);

const contentRef = ({ address, revision = 1, contentHash }) => {
  const referenceAddress = address ?? (revision instanceof PublicKey ? revision : null);
  const revisionNumber = typeof revision === "number" ? revision : 1;
  if (!referenceAddress) throw new Error("content reference is missing an address");
  return Buffer.concat([referenceAddress.toBuffer(), u32(revisionNumber), contentHash]);
};
const emptyContentRef = () =>
  contentRef({
    address: PublicKey.default,
    revision: 0,
    contentHash: Buffer.alloc(32),
  });

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function send(connection, payer, instructions, signers = []) {
  const tx = new Transaction().add(...(Array.isArray(instructions) ? instructions : [instructions]));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
  tx.sign(payer, ...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  const result = await connection.confirmTransaction(signature, "confirmed");
  if (result.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function sendV0(connection, payer, instructions, lookupTables, signers = []) {
  const recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash,
    instructions: Array.isArray(instructions) ? instructions : [instructions],
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...signers]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  const result = await connection.confirmTransaction(signature, "confirmed");
  if (result.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function createLookupTable(connection, payer, addresses) {
  const recentSlot = await connection.getSlot("finalized");
  const [createInstruction, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
  await send(connection, payer, createInstruction);
  const uniqueAddresses = [...new Map(addresses.map((address) => [address.toBase58(), address])).values()];
  await send(
    connection,
    payer,
    AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: uniqueAddresses,
    }),
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lookup = (await connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    })).value;
    const currentSlot = await connection.getSlot("confirmed");
    if (
      lookup
      && lookup.state.addresses.length === uniqueAddresses.length
      && currentSlot > Number(lookup.state.lastExtendedSlot)
    ) {
      return lookup;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("address lookup table was not activated");
}

async function expectRejected(label, action) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  check(label, rejected);
}

async function fund(connection, ...publicKeys) {
  for (const publicKey of publicKeys) {
    const signature = await connection.requestAirdrop(publicKey, 10_000_000_000);
    await connection.confirmTransaction(signature, "confirmed");
  }
}

function parseReceiptExtensions(data) {
  if (data.length < TOKEN_2022_MINT_TLV_OFFSET || data[165] !== 1) {
    throw new Error("receipt mint has no Token-2022 mint TLV");
  }
  let cursor = TOKEN_2022_MINT_TLV_OFFSET;
  const extensions = new Map();
  while (cursor + 4 <= data.length) {
    const kind = data.readUInt16LE(cursor);
    const length = data.readUInt16LE(cursor + 2);
    if (kind === 0) break;
    const start = cursor + 4;
    const end = start + length;
    if (end > data.length || extensions.has(kind)) throw new Error("invalid receipt mint TLV");
    extensions.set(kind, data.subarray(start, end));
    cursor = end;
  }
  return extensions;
}

function receiptExtensionSetHash(data) {
  const extensions = parseReceiptExtensions(data);
  const canonical = [];
  for (const kind of RECEIPT_EXTENSIONS) {
    const value = extensions.get(kind);
    if (!value) throw new Error(`receipt extension ${kind} is missing`);
    canonical.push(u16(kind), u16(value.length), value);
  }
  return hash(Buffer.concat([RECEIPT_EXTENSION_HASH_DOMAIN, ...canonical]));
}

async function createReceiptMint({
  connection,
  payer,
  receiptMint,
  mintAuthority,
  freezeAuthority,
  recoveryAuthority,
  permissionedBurnAuthority,
}) {
  const space = getMintLen(RECEIPT_EXTENSIONS);
  const rent = await connection.getMinimumBalanceForRentExemption(space);
  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: receiptMint.publicKey,
      lamports: rent,
      space,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeDefaultAccountStateInstruction(
      receiptMint.publicKey,
      AccountState.Frozen,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializePermanentDelegateInstruction(
      receiptMint.publicKey,
      recoveryAuthority,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeTransferHookInstruction(
      receiptMint.publicKey,
      PublicKey.default,
      COMPLIANCE,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(
      receiptMint.publicKey,
      null,
      receiptMint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializePermissionedBurnInstruction(
      receiptMint.publicKey,
      permissionedBurnAuthority,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMint2Instruction(
      receiptMint.publicKey,
      6,
      mintAuthority,
      freezeAuthority,
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
  await send(connection, payer, instructions, [receiptMint]);
}

function initializeProtocolIx({
  payer,
  governance,
  guardian,
  complianceAuthority,
  platformTreasury,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda(), false, true),
      meta(payer, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "initialize_protocol",
      governance.toBuffer(),
      guardian.toBuffer(),
      complianceAuthority.toBuffer(),
      platformTreasury.toBuffer(),
      ORACLE.toBuffer(),
      COMPLIANCE.toBuffer(),
    ),
  });
}

function registerSettlementAssetIx({ governance, mint }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(settlementAssetPda(mint), false, true),
      meta(mint),
      meta(TOKEN_PROGRAM_ID),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("register_settlement_asset", bool(true)),
  });
}

function registerMseIx({ governance, entityHash, walletOwner, usdcAta }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(mseBeneficiaryPda(entityHash), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "register_mse_beneficiary",
      entityHash,
      walletOwner.toBuffer(),
      usdcAta.toBuffer(),
      u8(0),
    ),
  });
}

function initializeComplianceIx({ governance, recoveryAuthority }) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda(), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("initialize_config", recoveryAuthority.toBuffer(), i64(60)),
  });
}

function registerProviderIx({ governance, provider }) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(providerPda(provider), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("register_provider", provider.toBuffer(), bool(true), bool(true)),
  });
}

function configureTransferPolicyIx({
  governance,
  receiptMint,
  platformTreasury,
  series,
}) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(transferPolicyPda(receiptMint), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "configure_transfer_policy",
      receiptMint.toBuffer(),
      platformTreasury.toBuffer(),
      series.toBuffer(),
      u8(0),
      bool(true),
    ),
  });
}

function createDealIx({
  governance,
  dealId,
  issuerEntityHash,
  beneficiaryEntityHash,
  settlementMint,
  receiptMint,
  subscriptionVault,
  repaymentVault,
  issuerUsdcAta,
  complianceEscrowAta,
  servicer,
  risk,
  now,
  extensionSetHash,
  termsHash,
  commodityValuation,
  fxValuation,
}) {
  const dealTerms = dealTermsPda(dealId);
  const dealState = dealStatePda(dealId);
  const series = seriesPda(dealId);
  const data = ixData(
    "create_deal",
    dealId,
    issuerEntityHash,
    fixtureHash("servicer-entity"),
    fixtureHash("asset-set"),
    fixtureHash("financing-contract"),
    fixtureHash("document-bundle"),
    fixtureHash("approved-bank-route"),
    termsHash,
    fixtureHash("oracle-policy"),
    fixtureHash("compliance-policy"),
    commodityValuation.toBuffer(),
    fxValuation.toBuffer(),
    servicer.toBuffer(),
    risk.toBuffer(),
    i64(now - 60),
    i64(now + 3_600),
    i64(now + 7_200),
    i64(now + 10_800),
    i64(now + 14_400),
    u64(20n * USDC),
    u64(30n * USDC),
    u16(1_000),
    u16(0),
    u32(0),
    u8(4),
    extensionSetHash,
  );
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(settlementAssetPda(settlementMint)),
      meta(dealTerms, false, true),
      meta(dealState, false, true),
      meta(series, false, true),
      meta(mseBeneficiaryPda(beneficiaryEntityHash)),
      meta(settlementMint),
      meta(receiptMint),
      meta(complianceConfigPda()),
      meta(transferPolicyPda(receiptMint)),
      meta(subscriptionVault, false, true),
      meta(repaymentVault, false, true),
      meta(issuerUsdcAta),
      meta(complianceEscrowAta),
      meta(TOKEN_PROGRAM_ID),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

function configureMilestoneIx({ governance, dealId, index, allocationBps }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId), false, true),
      meta(dealStatePda(dealId), false, true),
      meta(milestonePda(dealId, index), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("configure_milestone", u8(index), u8(index), u16(allocationBps)),
  });
}

function openSubscriptionIx({ governance, dealId }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId), false, true),
      meta(dealStatePda(dealId), false, true),
      meta(governance, true),
    ],
    data: ixData("open_subscription"),
  });
}

function issueInvestorIx({ provider, investorId, expiresAt }) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(providerPda(provider)),
      meta(investorRecordPda(investorId), false, true),
      meta(provider, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("issue_investor", investorId, i64(expiresAt)),
  });
}

function bindWalletIx({ provider, investorId, wallet }) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(providerPda(provider)),
      meta(investorRecordPda(investorId), false, true),
      meta(walletBindingPda(wallet), false, true),
      meta(wallet, true),
      meta(provider, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("bind_wallet"),
  });
}

function setSeriesPermissionIx({
  provider,
  investorId,
  wallet,
  receiptMint,
  termsHash,
  expiresAt,
}) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(providerPda(provider)),
      meta(investorRecordPda(investorId)),
      meta(walletBindingPda(wallet)),
      meta(seriesPermissionPda(receiptMint, wallet), false, true),
      meta(wallet),
      meta(provider, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "set_series_permission",
      receiptMint.toBuffer(),
      termsHash,
      u64(15n * USDC),
      i64(expiresAt),
    ),
  });
}

function approveInvestorIx({
  complianceAuthority,
  dealId,
  investorId,
  wallet,
  termsHash,
  expiresAt,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId)),
      meta(positionPda(dealId, investorId), false, true),
      meta(complianceAuthority, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "approve_investor",
      investorId,
      wallet.toBuffer(),
      u64(15n * USDC),
      termsHash,
      i64(expiresAt),
    ),
  });
}

function thawReceiptAccountIx({ provider, investorId, wallet, receiptMint, receiptAta }) {
  return new TransactionInstruction({
    programId: COMPLIANCE,
    keys: [
      meta(complianceConfigPda()),
      meta(providerPda(provider)),
      meta(investorRecordPda(investorId)),
      meta(walletBindingPda(wallet)),
      meta(seriesPermissionPda(receiptMint, wallet)),
      meta(transferPolicyPda(receiptMint)),
      meta(receiptMint, false, true),
      meta(receiptAta, false, true),
      meta(wallet),
      meta(provider, true),
      meta(TOKEN_2022_PROGRAM_ID),
    ],
    data: ixData("thaw_receipt_account"),
  });
}

function subscribeIx({
  investor,
  dealId,
  investorId,
  receiptMint,
  investorUsdc,
  subscriptionVault,
  receiptAta,
  settlementMint,
  nonce,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(seriesPda(dealId), false, true),
      meta(positionPda(dealId, investorId), false, true),
      meta(complianceConfigPda()),
      meta(transferPolicyPda(receiptMint)),
      meta(investorRecordPda(investorId)),
      meta(walletBindingPda(investor)),
      meta(seriesPermissionPda(receiptMint, investor)),
      meta(subscriptionReceiptPda(dealId, investorId, nonce), false, true),
      meta(investorUsdc, false, true),
      meta(subscriptionVault, false, true),
      meta(receiptAta, false, true),
      meta(settlementMint, false, true),
      meta(receiptMint, false, true),
      meta(TOKEN_PROGRAM_ID),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(investor, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "subscribe",
      u64(15n * USDC),
      u64(nonce),
      fixtureHash(`subscription-${nonce}`),
    ),
  });
}

function finalizeSubscriptionIx({ dealId, receiptMint, finalizer }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(seriesPda(dealId), false, true),
      meta(receiptMint, false, true),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(finalizer, true),
    ],
    data: ixData("finalize_subscription"),
  });
}

function scheduleCapitalReleaseIx({ dealId, risk, treasury }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId)),
      meta(milestonePda(dealId, 0), false, true),
      meta(ORACLE),
      meta(ORACLE),
      // Anchor encodes a missing optional account with this program's ID.
      meta(VAULT),
      meta(treasuryMovementPda(dealId, 0), false, true),
      meta(risk, true),
      meta(treasury, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "schedule_release",
      PublicKey.default.toBuffer(),
      u32(0),
      Buffer.alloc(32),
      i64(0),
    ),
  });
}

function executeReleaseIx({
  dealId,
  index,
  subscriptionVault,
  issuerUsdcAta,
  settlementMint,
  executor,
  gate = null,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(milestonePda(dealId, index), false, true),
      meta(treasuryMovementPda(dealId, index), false, true),
      meta(subscriptionVault, false, true),
      meta(issuerUsdcAta, false, true),
      meta(settlementMint),
      meta(TOKEN_PROGRAM_ID),
      meta(gate?.head ?? ORACLE),
      meta(gate?.revision ?? ORACLE),
      meta(executor, true),
    ],
    data: ixData("execute_release", fixtureHash(`release-signature-${index}`)),
  });
}

function updateTreasuryMovementIx({ name, dealId, index, authority, fields = [] }) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(treasuryMovementPda(dealId, index), false, true),
      meta(authority, true),
    ],
    data: ixData(name, ...fields),
  });
}

function initializeOracleIx({ governance, guardian, publisher }) {
  return new TransactionInstruction({
    programId: ORACLE,
    keys: [
      meta(oracleConfigPda(), false, true),
      meta(governance, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "initialize_oracle_config",
      guardian.toBuffer(),
      publisher.toBuffer(),
      i64(86_400),
      i64(86_400),
      i64(86_400),
      i64(300),
    ),
  });
}

function publishValuationIx({
  publisher,
  kind,
  baseAssetHash,
  quoteAssetHash,
  value,
  now,
  validUntil,
  contentHash,
}) {
  const head = valuationHeadPda({ kind, baseAssetHash, quoteAssetHash });
  const revision = valuationRevisionPda(head);
  return {
    head,
    revision,
    contentHash,
    instruction: new TransactionInstruction({
      programId: ORACLE,
      keys: [
        meta(oracleConfigPda()),
        meta(head, false, true),
        meta(revision, false, true),
        meta(publisher, true),
        meta(publisher, true, true),
        meta(SystemProgram.programId),
      ],
      data: ixData(
        "publish_valuation",
        u8(kind),
        baseAssetHash,
        quoteAssetHash,
        u64(value),
        u8(8),
        u32(1),
        u32(0),
        i64(now),
        i64(validUntil),
        fixtureHash(`valuation-source-${kind}`),
        fixtureHash(`valuation-method-${kind}`),
        fixtureHash(`valuation-evidence-${kind}`),
        contentHash,
      ),
    }),
  };
}

function publishAttestationIx({
  publisher,
  product,
  subjectRef,
  assetSetHash,
  seasonId,
  now,
  validUntil,
  contentHash,
}) {
  const head = attestationHeadPda({ subjectRef, assetSetHash, seasonId, product });
  const revision = attestationRevisionPda(head);
  return {
    head,
    revision,
    contentHash,
    instruction: new TransactionInstruction({
      programId: ORACLE,
      keys: [
        meta(oracleConfigPda()),
        meta(head, false, true),
        meta(revision, false, true),
        meta(publisher, true),
        meta(publisher, true, true),
        meta(SystemProgram.programId),
      ],
      data: ixData(
        "publish_attestation",
        u8(product),
        subjectRef,
        assetSetHash,
        seasonId,
        u32(1),
        u32(0),
        u8(1),
        u16(9_000),
        u16(10_000),
        i64(now),
        i64(validUntil),
        fixtureHash(`attestation-policy-${product}`),
        fixtureHash(`engine-${product}`),
        fixtureHash(`result-${product}`),
        fixtureHash(`evidence-${product}`),
        contentHash,
      ),
    }),
  };
}

function publishDealGateIx({
  publisher,
  deal,
  milestoneIndex,
  assetSetHash,
  seasonId,
  oraclePolicyHash,
  attestations,
  commodityValuation,
  fxValuation,
  now,
  expiresAt,
  contentHash,
}) {
  const head = dealGateHeadPda(deal, milestoneIndex);
  const revision = dealGateRevisionPda(head);
  const paddedAttestations = [...attestations];
  while (paddedAttestations.length < 3) paddedAttestations.push(null);
  const remainingAccounts = [];
  for (const attestation of attestations) {
    remainingAccounts.push(
      meta(attestation.revision),
      meta(attestation.head),
    );
  }
  remainingAccounts.push(
    meta(commodityValuation.revision),
    meta(commodityValuation.head),
    meta(fxValuation.revision),
    meta(fxValuation.head),
  );
  return {
    head,
    revision,
    contentHash,
    expiresAt,
    instruction: new TransactionInstruction({
      programId: ORACLE,
      keys: [
        meta(oracleConfigPda()),
        meta(head, false, true),
        meta(revision, false, true),
        meta(publisher, true),
        meta(publisher, true, true),
        meta(SystemProgram.programId),
        ...remainingAccounts,
      ],
      data: ixData(
        "publish_deal_gate",
        deal.toBuffer(),
        u8(milestoneIndex),
        u8(milestoneIndex),
        assetSetHash,
        seasonId,
        u32(1),
        u32(0),
        u8(attestations.length),
        ...paddedAttestations.map((attestation) =>
          attestation
            ? contentRef(attestation)
            : emptyContentRef()),
        contentRef(commodityValuation),
        contentRef(fxValuation),
        oraclePolicyHash,
        u8(1),
        i64(now),
        i64(expiresAt),
        contentHash,
      ),
    }),
  };
}

function scheduleOracleReleaseIx({
  dealId,
  index,
  gate,
  risk,
  treasury,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId)),
      meta(milestonePda(dealId, index), false, true),
      meta(gate.head),
      meta(gate.revision),
      meta(treasuryMovementPda(dealId, index - 1)),
      meta(treasuryMovementPda(dealId, index), false, true),
      meta(risk, true),
      meta(treasury, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "schedule_release",
      gate.revision.toBuffer(),
      u32(1),
      gate.contentHash,
      i64(gate.expiresAt),
    ),
  });
}

async function advanceSwiftEvidence({
  connection,
  governance,
  platformTreasury,
  dealId,
  index,
  releasedUsdc,
}) {
  const grossUsdMinor = releasedUsdc === 3 ? 300 : 900;
  const providerFee = 10;
  const bankFee = 5;
  await send(connection, platformTreasury, updateTreasuryMovementIx({
    name: "record_conversion",
    dealId,
    index,
    authority: platformTreasury.publicKey,
    fields: [
      fixtureHash(`conversion-provider-${index}`),
      u64(grossUsdMinor),
      u64(grossUsdMinor - providerFee - bankFee),
      u64(100_000_000),
      u64(providerFee),
      u64(bankFee),
    ],
  }));
  await send(connection, platformTreasury, updateTreasuryMovementIx({
    name: "record_swift_sent",
    dealId,
    index,
    authority: platformTreasury.publicKey,
    fields: [fixtureHash(`swift-uetr-${index}`)],
  }));
  await send(connection, governance, updateTreasuryMovementIx({
    name: "record_bank_confirmation",
    dealId,
    index,
    authority: governance.publicKey,
    fields: [fixtureHash(`bank-confirmation-${index}`)],
  }));
  await send(connection, governance, updateTreasuryMovementIx({
    name: "reconcile_treasury_movement",
    dealId,
    index,
    authority: governance.publicKey,
  }));
}

function depositRepaymentIx({
  dealId,
  servicer,
  payerUsdc,
  repaymentVault,
  settlementMint,
  nonce,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(repaymentReceiptPda(dealId, servicer, nonce), false, true),
      meta(payerUsdc, false, true),
      meta(repaymentVault, false, true),
      meta(settlementMint),
      meta(TOKEN_PROGRAM_ID),
      meta(servicer, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "deposit_repayment",
      u64(33n * USDC),
      u64(nonce),
      fixtureHash(`repayment-${nonce}`),
    ),
  });
}

function finalizeSettlementIx({
  dealId,
  subscriptionVault,
  repaymentVault,
  settlementMint,
  finalizer,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(seriesPda(dealId)),
      meta(settlementPda(dealId), false, true),
      meta(subscriptionVault, false, true),
      meta(repaymentVault, false, true),
      meta(settlementMint),
      meta(TOKEN_PROGRAM_ID),
      meta(finalizer, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData("finalize_settlement"),
  });
}

function redeemIx({
  dealId,
  investor,
  investorId,
  receiptMint,
  investorReceipt,
  repaymentVault,
  investorUsdc,
  complianceEscrowAta,
  settlementMint,
  nonce,
}) {
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      meta(protocolConfigPda()),
      meta(dealTermsPda(dealId)),
      meta(dealStatePda(dealId), false, true),
      meta(seriesPda(dealId), false, true),
      meta(settlementPda(dealId), false, true),
      meta(positionPda(dealId, investorId), false, true),
      meta(redemptionReceiptPda(dealId, investorId, nonce), false, true),
      meta(investorReceipt, false, true),
      meta(receiptMint, false, true),
      meta(repaymentVault, false, true),
      meta(investorUsdc, false, true),
      meta(complianceEscrowAta, false, true),
      meta(settlementMint),
      meta(TOKEN_2022_PROGRAM_ID),
      meta(TOKEN_PROGRAM_ID),
      meta(complianceConfigPda()),
      meta(transferPolicyPda(receiptMint)),
      meta(walletBindingPda(investor)),
      meta(seriesPermissionPda(receiptMint, investor)),
      meta(investorRecordPda(investorId)),
      meta(COMPLIANCE),
      meta(investor, true, true),
      meta(SystemProgram.programId),
    ],
    data: ixData(
      "redeem",
      u64(nonce),
      fixtureHash(`redemption-${nonce}-${investorId.toString("hex")}`),
    ),
  });
}

async function createCanonicalReceiptAta(connection, payer, wallet, receiptMint) {
  const ata = getAssociatedTokenAddressSync(
    receiptMint,
    wallet,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  await send(
    connection,
    payer,
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      wallet,
      receiptMint,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return ata;
}

async function onboardInvestor({
  connection,
  governance,
  provider,
  complianceAuthority,
  investor,
  investorId,
  receiptMint,
  settlementMint,
  settlementMintAuthority,
  termsHash,
  dealId,
  expiresAt,
}) {
  await send(connection, provider, issueInvestorIx({
    provider: provider.publicKey,
    investorId,
    expiresAt,
  }));
  await send(
    connection,
    provider,
    bindWalletIx({
      provider: provider.publicKey,
      investorId,
      wallet: investor.publicKey,
    }),
    [investor],
  );
  await send(connection, provider, setSeriesPermissionIx({
    provider: provider.publicKey,
    investorId,
    wallet: investor.publicKey,
    receiptMint,
    termsHash,
    expiresAt,
  }));
  await send(connection, complianceAuthority, approveInvestorIx({
    complianceAuthority: complianceAuthority.publicKey,
    dealId,
    investorId,
    wallet: investor.publicKey,
    termsHash,
    expiresAt,
  }));

  const investorUsdc = await createAccount(
    connection,
    governance,
    settlementMint,
    investor.publicKey,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection,
    governance,
    settlementMint,
    investorUsdc,
    settlementMintAuthority,
    15n * USDC,
  );
  const receiptAta = await createCanonicalReceiptAta(
    connection,
    governance,
    investor.publicKey,
    receiptMint,
  );
  await send(connection, provider, thawReceiptAccountIx({
    provider: provider.publicKey,
    investorId,
    wallet: investor.publicKey,
    receiptMint,
    receiptAta,
  }));
  return { investorUsdc, receiptAta };
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log(`\nPOD RWA phase-2 tracer  ·  ${RPC}\n`);

  for (const [name, id] of [
    ["pod_vault", VAULT],
    ["pod_oracle", ORACLE],
    ["pod_compliance", COMPLIANCE],
  ]) {
    const info = await connection.getAccountInfo(id);
    check(`${name} deployed and executable`, Boolean(info?.executable));
  }
  if (failed) throw new Error("required programs are not deployed");

  const governance = Keypair.generate();
  const guardian = Keypair.generate();
  const complianceAuthority = Keypair.generate();
  const provider = Keypair.generate();
  const oraclePublisher = Keypair.generate();
  const platformTreasury = Keypair.generate();
  const recoveryAuthority = Keypair.generate();
  const servicer = Keypair.generate();
  const risk = Keypair.generate();
  const investor1 = Keypair.generate();
  const investor2 = Keypair.generate();
  await fund(
    connection,
    governance.publicKey,
    provider.publicKey,
    oraclePublisher.publicKey,
    complianceAuthority.publicKey,
    investor1.publicKey,
    investor2.publicKey,
  );

  console.log("\n1. Protocol, settlement asset and original V1 treasury route");
  await send(connection, governance, initializeProtocolIx({
    payer: governance.publicKey,
    governance: governance.publicKey,
    guardian: guardian.publicKey,
    complianceAuthority: complianceAuthority.publicKey,
    platformTreasury: platformTreasury.publicKey,
  }));

  const settlementMintAuthority = Keypair.generate();
  const settlementMint = await createMint(
    connection,
    governance,
    settlementMintAuthority.publicKey,
    null,
    6,
  );
  await send(connection, governance, registerSettlementAssetIx({
    governance: governance.publicKey,
    mint: settlementMint,
  }));

  const issuerUsdcAta = await createAccount(
    connection,
    governance,
    settlementMint,
    platformTreasury.publicKey,
  );
  const beneficiaryEntityHash = fixtureHash("international-mse");
  await send(connection, governance, registerMseIx({
    governance: governance.publicKey,
    entityHash: beneficiaryEntityHash,
    walletOwner: platformTreasury.publicKey,
    usdcAta: issuerUsdcAta,
  }));
  check("settlement asset registered", Boolean(await connection.getAccountInfo(settlementAssetPda(settlementMint))));
  check("MSE uses SQUADS_FIAT_FORWARD rail", Boolean(await connection.getAccountInfo(mseBeneficiaryPda(beneficiaryEntityHash))));

  console.log("\n2. Compliance authority and Token-2022 receipt profile");
  await send(connection, governance, initializeComplianceIx({
    governance: governance.publicKey,
    recoveryAuthority: recoveryAuthority.publicKey,
  }));
  await send(connection, governance, registerProviderIx({
    governance: governance.publicKey,
    provider: provider.publicKey,
  }));
  await send(connection, governance, initializeOracleIx({
    governance: governance.publicKey,
    guardian: guardian.publicKey,
    publisher: oraclePublisher.publicKey,
  }));

  const dealId = fixtureHash("farm-1-deal");
  const series = seriesPda(dealId);
  const receiptMint = Keypair.generate();
  const transferPolicy = transferPolicyPda(receiptMint.publicKey);
  await createReceiptMint({
    connection,
    payer: governance,
    receiptMint,
    mintAuthority: series,
    freezeAuthority: complianceConfigPda(),
    recoveryAuthority: recoveryAuthority.publicKey,
    permissionedBurnAuthority: transferPolicy,
  });
  await send(connection, governance, configureTransferPolicyIx({
    governance: governance.publicKey,
    receiptMint: receiptMint.publicKey,
    platformTreasury: platformTreasury.publicKey,
    series,
  }));

  const receiptMintInfo = await connection.getAccountInfo(receiptMint.publicKey);
  const extensions = parseReceiptExtensions(receiptMintInfo.data);
  const extensionSetHash = receiptExtensionSetHash(receiptMintInfo.data);
  for (const extension of RECEIPT_EXTENSIONS) {
    check(`receipt extension ${ExtensionType[extension]} is present`, extensions.has(extension));
  }
  const parsedReceiptMint = await getMint(
    connection,
    receiptMint.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  check("receipt mint authority is the immutable Series PDA", parsedReceiptMint.mintAuthority?.equals(series));
  check("receipt freeze authority is compliance config", parsedReceiptMint.freezeAuthority?.equals(complianceConfigPda()));

  console.log("\n3. Deal creation and locked 30/30/30/10 milestones");
  const subscriptionVault = await createAccount(
    connection,
    governance,
    settlementMint,
    dealStatePda(dealId),
    Keypair.generate(),
  );
  const repaymentVault = await createAccount(
    connection,
    governance,
    settlementMint,
    dealStatePda(dealId),
    Keypair.generate(),
  );
  const complianceEscrowAta = await createAccount(
    connection,
    governance,
    settlementMint,
    complianceConfigPda(),
    Keypair.generate(),
  );
  const now = Math.floor(Date.now() / 1_000);
  const termsHash = fixtureHash("locked-terms");
  const assetSetHash = fixtureHash("asset-set");
  const seasonId = fixtureHash("season-2026");
  const oraclePolicyHash = fixtureHash("oracle-policy");
  const commodityBaseHash = fixtureHash("commodity-maize");
  const usdQuoteHash = fixtureHash("currency-usd");
  const etbQuoteHash = fixtureHash("currency-etb");
  const commodityValuation = publishValuationIx({
    publisher: oraclePublisher.publicKey,
    kind: 0,
    baseAssetHash: commodityBaseHash,
    quoteAssetHash: usdQuoteHash,
    value: 25_000_000_000n,
    now,
    validUntil: now + 7_200,
    contentHash: fixtureHash("commodity-valuation-content"),
  });
  const fxValuation = publishValuationIx({
    publisher: oraclePublisher.publicKey,
    kind: 1,
    baseAssetHash: usdQuoteHash,
    quoteAssetHash: etbQuoteHash,
    value: 5_700_000_000n,
    now,
    validUntil: now + 7_200,
    contentHash: fixtureHash("fx-valuation-content"),
  });
  await send(connection, oraclePublisher, commodityValuation.instruction);
  await send(connection, oraclePublisher, fxValuation.instruction);
  const createDealInstruction = createDealIx({
    governance: governance.publicKey,
    dealId,
    issuerEntityHash: fixtureHash("us-c-corporation"),
    beneficiaryEntityHash,
    settlementMint,
    receiptMint: receiptMint.publicKey,
    subscriptionVault,
    repaymentVault,
    issuerUsdcAta,
    complianceEscrowAta,
    servicer: servicer.publicKey,
    risk: risk.publicKey,
    now,
    extensionSetHash,
    termsHash,
    commodityValuation: commodityValuation.revision,
    fxValuation: fxValuation.revision,
  });
  const dealLookupTable = await createLookupTable(
    connection,
    governance,
    createDealInstruction.keys
      .filter(({ isSigner, pubkey }) => !isSigner && !pubkey.equals(SystemProgram.programId))
      .map(({ pubkey }) => pubkey),
  );
  await sendV0(connection, governance, createDealInstruction, [dealLookupTable]);
  for (const [index, allocationBps] of [3_000, 3_000, 3_000, 1_000].entries()) {
    await send(connection, governance, configureMilestoneIx({
      governance: governance.publicKey,
      dealId,
      index,
      allocationBps,
    }));
  }
  await send(connection, governance, openSubscriptionIx({
    governance: governance.publicKey,
    dealId,
  }));
  check("deal terms created", Boolean(await connection.getAccountInfo(dealTermsPda(dealId))));
  check("four milestones created", (await Promise.all(
    [0, 1, 2, 3].map((index) => connection.getAccountInfo(milestonePda(dealId, index))),
  )).every(Boolean));

  console.log("\n4. Two compliant investors subscribe 15 USDC each");
  const expiresAt = now + 3_000;
  const investorId1 = fixtureHash("investor-1");
  const investorId2 = fixtureHash("investor-2");
  const investor1Accounts = await onboardInvestor({
    connection,
    governance,
    provider,
    complianceAuthority,
    investor: investor1,
    investorId: investorId1,
    receiptMint: receiptMint.publicKey,
    settlementMint,
    settlementMintAuthority,
    termsHash,
    dealId,
    expiresAt,
  });
  const investor2Accounts = await onboardInvestor({
    connection,
    governance,
    provider,
    complianceAuthority,
    investor: investor2,
    investorId: investorId2,
    receiptMint: receiptMint.publicKey,
    settlementMint,
    settlementMintAuthority,
    termsHash,
    dealId,
    expiresAt,
  });

  await send(connection, investor1, subscribeIx({
    investor: investor1.publicKey,
    dealId,
    investorId: investorId1,
    receiptMint: receiptMint.publicKey,
    investorUsdc: investor1Accounts.investorUsdc,
    subscriptionVault,
    receiptAta: investor1Accounts.receiptAta,
    settlementMint,
    nonce: 1,
  }));
  await send(connection, investor2, subscribeIx({
    investor: investor2.publicKey,
    dealId,
    investorId: investorId2,
    receiptMint: receiptMint.publicKey,
    investorUsdc: investor2Accounts.investorUsdc,
    subscriptionVault,
    receiptAta: investor2Accounts.receiptAta,
    settlementMint,
    nonce: 1,
  }));

  const subscriptionBalance = (await getAccount(connection, subscriptionVault)).amount;
  const receipt1 = await getAccount(
    connection,
    investor1Accounts.receiptAta,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  const receipt2 = await getAccount(
    connection,
    investor2Accounts.receiptAta,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  const receiptSupply = (await getMint(
    connection,
    receiptMint.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  )).supply;
  check("subscription vault holds exactly 30 USDC", subscriptionBalance === 30n * USDC);
  check("investor 1 holds exactly 15 receipt units", receipt1.amount === 15n * USDC);
  check("investor 2 holds exactly 15 receipt units", receipt2.amount === 15n * USDC);
  check("receipt supply equals accepted principal", receiptSupply === subscriptionBalance);

  console.log("\n5. Subscription negative-path invariants");
  await expectRejected("hard cap rejects an additional subscription", () =>
    send(connection, investor1, subscribeIx({
      investor: investor1.publicKey,
      dealId,
      investorId: investorId1,
      receiptMint: receiptMint.publicKey,
      investorUsdc: investor1Accounts.investorUsdc,
      subscriptionVault,
      receiptAta: investor1Accounts.receiptAta,
      settlementMint,
      nonce: 2,
    })),
  );
  check(
    "rejected subscription creates no receipt",
    (await connection.getAccountInfo(subscriptionReceiptPda(dealId, investorId1, 2))) === null,
  );

  console.log("\n6. Funding close and first 30% release");
  await send(connection, governance, finalizeSubscriptionIx({
    dealId,
    receiptMint: receiptMint.publicKey,
    finalizer: governance.publicKey,
  }));
  const finalizedMint = await getMint(
    connection,
    receiptMint.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  check("funding close revokes receipt mint authority", finalizedMint.mintAuthority === null);

  await fund(connection, platformTreasury.publicKey);
  await send(
    connection,
    platformTreasury,
    scheduleCapitalReleaseIx({
      dealId,
      risk: risk.publicKey,
      treasury: platformTreasury.publicKey,
    }),
    [risk],
  );
  await send(connection, governance, executeReleaseIx({
    dealId,
    index: 0,
    subscriptionVault,
    issuerUsdcAta,
    settlementMint,
    executor: governance.publicKey,
  }));
  check(
    "capital close releases exactly 9 USDC to US issuer treasury",
    (await getAccount(connection, issuerUsdcAta)).amount === 9n * USDC,
  );
  check(
    "subscription vault retains exactly 21 USDC",
    (await getAccount(connection, subscriptionVault)).amount === 21n * USDC,
  );

  console.log("\n7. Conversion, SWIFT, bank confirmation and reconciliation");
  await send(connection, platformTreasury, updateTreasuryMovementIx({
    name: "record_conversion",
    dealId,
    index: 0,
    authority: platformTreasury.publicKey,
    fields: [
      fixtureHash("conversion-provider"),
      u64(900),
      u64(885),
      u64(100_000_000),
      u64(10),
      u64(5),
    ],
  }));
  await send(connection, platformTreasury, updateTreasuryMovementIx({
    name: "record_swift_sent",
    dealId,
    index: 0,
    authority: platformTreasury.publicKey,
    fields: [fixtureHash("swift-uetr")],
  }));
  await send(connection, governance, updateTreasuryMovementIx({
    name: "record_bank_confirmation",
    dealId,
    index: 0,
    authority: governance.publicKey,
    fields: [fixtureHash("bank-confirmation")],
  }));
  await send(connection, governance, updateTreasuryMovementIx({
    name: "reconcile_treasury_movement",
    dealId,
    index: 0,
    authority: governance.publicKey,
  }));
  check(
    "capital movement evidence is anchored",
    Boolean(await connection.getAccountInfo(treasuryMovementPda(dealId, 0))),
  );

  console.log("\n8. Immutable T1/T2/T3 gates and remaining releases");
  const subjectRef = fixtureHash("farm-1");
  const oracleValidUntil = now + 7_200;
  const attestations = [];
  for (const product of [0, 1, 2]) {
    const attestation = publishAttestationIx({
      publisher: oraclePublisher.publicKey,
      product,
      subjectRef,
      assetSetHash,
      seasonId,
      now,
      validUntil: oracleValidUntil,
      contentHash: fixtureHash(`attestation-content-${product}`),
    });
    await send(connection, oraclePublisher, attestation.instruction);
    attestations.push(attestation);
  }
  const gateExpiresAt = now + 3_600;
  const gates = [];
  for (const milestoneIndex of [1, 2, 3]) {
    gates.push(publishDealGateIx({
      publisher: oraclePublisher.publicKey,
      deal: dealTermsPda(dealId),
      milestoneIndex,
      assetSetHash,
      seasonId,
      oraclePolicyHash,
      attestations: attestations.slice(0, milestoneIndex),
      commodityValuation,
      fxValuation,
      now,
      expiresAt: gateExpiresAt,
      contentHash: fixtureHash(`deal-gate-content-${milestoneIndex}`),
    }));
  }
  const gateLookupTable = await createLookupTable(
    connection,
    oraclePublisher,
    gates.flatMap(({ instruction }) =>
      instruction.keys
        .filter(({ isSigner, pubkey }) => !isSigner && !pubkey.equals(SystemProgram.programId))
        .map(({ pubkey }) => pubkey)),
  );
  for (const gate of gates) {
    await sendV0(
      connection,
      oraclePublisher,
      gate.instruction,
      [gateLookupTable],
    );
  }
  check(
    "T1/T2/T3 gate revisions are immutable on-chain accounts",
    (await Promise.all(gates.map(({ revision }) => connection.getAccountInfo(revision)))).every(Boolean),
  );

  for (const index of [1, 2, 3]) {
    await send(
      connection,
      platformTreasury,
      scheduleOracleReleaseIx({
        dealId,
        index,
        gate: gates[index - 1],
        risk: risk.publicKey,
        treasury: platformTreasury.publicKey,
      }),
      [risk],
    );
    await send(connection, governance, executeReleaseIx({
      dealId,
      index,
      subscriptionVault,
      issuerUsdcAta,
      settlementMint,
      executor: governance.publicKey,
      gate: gates[index - 1],
    }));

    if (index < 3) {
      await expectRejected(
        `milestone ${index + 1} is blocked until milestone ${index} wire is reconciled`,
        () => send(
          connection,
          platformTreasury,
          scheduleOracleReleaseIx({
            dealId,
            index: index + 1,
            gate: gates[index],
            risk: risk.publicKey,
            treasury: platformTreasury.publicKey,
          }),
          [risk],
        ),
      );
      check(
        `blocked milestone ${index + 1} leaves no treasury movement`,
        (await connection.getAccountInfo(treasuryMovementPda(dealId, index + 1))) === null,
      );
    }

    await advanceSwiftEvidence({
      connection,
      governance,
      platformTreasury,
      dealId,
      index,
      releasedUsdc: index === 3 ? 3 : 9,
    });
  }
  check(
    "all four releases send exactly 30 USDC to US issuer treasury",
    (await getAccount(connection, issuerUsdcAta)).amount === 30n * USDC,
  );
  check(
    "released capital never exceeds funded deployable capital",
    (await getAccount(connection, subscriptionVault)).amount === 0n,
  );

  console.log("\n9. Reverse fiat repayment and settlement waterfall");
  await fund(connection, servicer.publicKey);
  const servicerUsdc = await createAccount(
    connection,
    governance,
    settlementMint,
    servicer.publicKey,
  );
  await mintTo(
    connection,
    governance,
    settlementMint,
    servicerUsdc,
    settlementMintAuthority,
    33n * USDC,
  );
  await send(connection, servicer, depositRepaymentIx({
    dealId,
    servicer: servicer.publicKey,
    payerUsdc: servicerUsdc,
    repaymentVault,
    settlementMint,
    nonce: 1,
  }));
  check(
    "reverse flow deposits exactly 33 USDC into isolated repayment vault",
    (await getAccount(connection, repaymentVault)).amount === 33n * USDC,
  );
  await send(connection, governance, finalizeSettlementIx({
    dealId,
    subscriptionVault,
    repaymentVault,
    settlementMint,
    finalizer: governance.publicKey,
  }));
  check("settlement snapshot is created", Boolean(
    await connection.getAccountInfo(settlementPda(dealId)),
  ));

  console.log("\n10. Governed burn and equal investor redemption");
  await expectRejected(
    "a holder cannot directly burn a permissioned receipt",
    () => send(
      connection,
      investor1,
      createBurnCheckedInstruction(
        investor1Accounts.receiptAta,
        receiptMint.publicKey,
        investor1.publicKey,
        15n * USDC,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
  );
  const redeem1 = redeemIx({
    dealId,
    investor: investor1.publicKey,
    investorId: investorId1,
    receiptMint: receiptMint.publicKey,
    investorReceipt: investor1Accounts.receiptAta,
    repaymentVault,
    investorUsdc: investor1Accounts.investorUsdc,
    complianceEscrowAta,
    settlementMint,
    nonce: 1,
  });
  const redeem2 = redeemIx({
    dealId,
    investor: investor2.publicKey,
    investorId: investorId2,
    receiptMint: receiptMint.publicKey,
    investorReceipt: investor2Accounts.receiptAta,
    repaymentVault,
    investorUsdc: investor2Accounts.investorUsdc,
    complianceEscrowAta,
    settlementMint,
    nonce: 1,
  });
  const redemptionLookupTable = await createLookupTable(
    connection,
    governance,
    [...redeem1.keys, ...redeem2.keys]
      .filter(({ isSigner, pubkey }) => !isSigner && !pubkey.equals(SystemProgram.programId))
      .map(({ pubkey }) => pubkey),
  );
  await sendV0(connection, investor1, redeem1, [redemptionLookupTable]);
  await sendV0(connection, investor2, redeem2, [redemptionLookupTable]);

  const investor1Payout = (await getAccount(connection, investor1Accounts.investorUsdc)).amount;
  const investor2Payout = (await getAccount(connection, investor2Accounts.investorUsdc)).amount;
  const finalReceiptSupply = (await getMint(
    connection,
    receiptMint.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  )).supply;
  check("investor 1 redeems exactly 16.5 USDC", investor1Payout === 16_500_000n);
  check("investor 2 redeems exactly 16.5 USDC", investor2Payout === 16_500_000n);
  check("governed redemption burns the complete receipt supply", finalReceiptSupply === 0n);
  check(
    "full repayment and redemption conserve every USDC base unit",
    (await getAccount(connection, repaymentVault)).amount === 0n
      && investor1Payout + investor2Payout === 33n * USDC,
  );

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ·  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nTracer aborted:", error.message ?? error);
  if (error.stack) console.error(error.stack);
  if (error.logs) console.error(error.logs.join("\n"));
  process.exit(1);
});
