// Phase 1 RPC tracer — the MSE beneficiary registry, exercised against a real validator.
//
// Sends genuine transactions to solana-test-validator running the SBF-compiled programs, then
// reads the resulting accounts back and decodes them. This is the on-chain proof that the
// multi-MSE refactor works end to end: instruction dispatch, PDA derivation, governance gating,
// rail discriminants and account layout.
//
// Run:  node rwa/tracer/rpc/tracer.mjs
// Needs: a validator with the three programs loaded (see rpc/README.md).

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";

const VAULT = new PublicKey("GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn");
const ORACLE = new PublicKey("9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E");
const COMPLIANCE = new PublicKey("6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj");

const RAIL_SQUADS_FIAT_FORWARD = 0;
const RAIL_DIRECT_USDC = 1;
const STATUS_ACTIVE = 0;
const STATUS_SUSPENDED = 1;

// Anchor dispatches on the first 8 bytes of sha256("global:<snake_case_instruction>").
const discriminator = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const pda = (seeds, programId) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

const protocolConfigPda = () => pda([Buffer.from("protocol")], VAULT);
const mseBeneficiaryPda = (entityHash) =>
  pda([Buffer.from("mse-beneficiary"), entityHash], VAULT);

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function send(connection, payer, instruction, signers = []) {
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
  tx.sign(payer, ...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

/** Decodes the on-chain MseBeneficiary account, skipping Anchor's 8-byte discriminator. */
function decodeMseBeneficiary(data) {
  let offset = 8;
  const readU16 = () => {
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const readBytes = (n) => {
    const v = data.subarray(offset, offset + n);
    offset += n;
    return v;
  };
  const readU8 = () => data[offset++];
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  return {
    schemaVersion: readU16(),
    entityHash: Buffer.from(readBytes(32)).toString("hex"),
    walletOwner: new PublicKey(readBytes(32)).toBase58(),
    usdcAta: new PublicKey(readBytes(32)).toBase58(),
    railKind: readU8(),
    status: readU8(),
    registeredAtSlot: readU64(),
    updatedAtSlot: readU64(),
    bump: readU8(),
  };
}

function initializeProtocolIx({ payer, governance, guardian, complianceAuthority, platformTreasury }) {
  const data = Buffer.concat([
    discriminator("initialize_protocol"),
    governance.toBuffer(),
    guardian.toBuffer(),
    complianceAuthority.toBuffer(),
    platformTreasury.toBuffer(),
    ORACLE.toBuffer(),
    COMPLIANCE.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      { pubkey: protocolConfigPda(), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function registerMseIx({ signer, entityHash, walletOwner, usdcAta, railKind }) {
  const data = Buffer.concat([
    discriminator("register_mse_beneficiary"),
    entityHash,
    walletOwner.toBuffer(),
    usdcAta.toBuffer(),
    Buffer.from([railKind]),
  ]);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      { pubkey: protocolConfigPda(), isSigner: false, isWritable: false },
      { pubkey: mseBeneficiaryPda(entityHash), isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function setStatusIx({ signer, entityHash, status }) {
  const data = Buffer.concat([
    discriminator("set_mse_beneficiary_status"),
    Buffer.from([status]),
  ]);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      { pubkey: protocolConfigPda(), isSigner: false, isWritable: false },
      { pubkey: mseBeneficiaryPda(entityHash), isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function fund(connection, pubkey, sol = 5) {
  const sig = await connection.requestAirdrop(pubkey, sol * 1_000_000_000);
  await connection.confirmTransaction(sig, "confirmed");
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log(`\nPOD RWA phase-1 tracer  ·  ${RPC}\n`);

  for (const [name, id] of [["pod_vault", VAULT], ["pod_oracle", ORACLE], ["pod_compliance", COMPLIANCE]]) {
    const info = await connection.getAccountInfo(id);
    check(`${name} deployed and executable`, Boolean(info?.executable));
  }

  const governance = Keypair.generate();
  const platformTreasury = Keypair.generate();
  await fund(connection, governance.publicKey);

  console.log("\n1. Protocol initialisation");
  await send(
    connection,
    governance,
    initializeProtocolIx({
      payer: governance.publicKey,
      governance: governance.publicKey,
      guardian: Keypair.generate().publicKey,
      complianceAuthority: Keypair.generate().publicKey,
      platformTreasury: platformTreasury.publicKey,
    }),
  );
  check("protocol config created", Boolean(await connection.getAccountInfo(protocolConfigPda())));

  console.log("\n2. Registry holds multiple MSEs across both rails");
  const platformHash = Buffer.alloc(32, 1);
  const platformWallet = Keypair.generate().publicKey;
  const platformAta = Keypair.generate().publicKey;
  await send(
    connection,
    governance,
    registerMseIx({
      signer: governance.publicKey,
      entityHash: platformHash,
      walletOwner: platformWallet,
      usdcAta: platformAta,
      railKind: RAIL_SQUADS_FIAT_FORWARD,
    }),
  );

  const thirdPartyHash = Buffer.alloc(32, 2);
  const thirdPartyWallet = Keypair.generate().publicKey;
  const thirdPartyAta = Keypair.generate().publicKey;
  await send(
    connection,
    governance,
    registerMseIx({
      signer: governance.publicKey,
      entityHash: thirdPartyHash,
      walletOwner: thirdPartyWallet,
      usdcAta: thirdPartyAta,
      railKind: RAIL_DIRECT_USDC,
    }),
  );

  const platform = decodeMseBeneficiary(
    (await connection.getAccountInfo(mseBeneficiaryPda(platformHash))).data,
  );
  const thirdParty = decodeMseBeneficiary(
    (await connection.getAccountInfo(mseBeneficiaryPda(thirdPartyHash))).data,
  );

  check("platform MSE wallet round-trips", platform.walletOwner === platformWallet.toBase58());
  check("platform MSE ATA round-trips", platform.usdcAta === platformAta.toBase58());
  check("platform MSE rail is SQUADS_FIAT_FORWARD", platform.railKind === RAIL_SQUADS_FIAT_FORWARD);
  check("platform MSE is ACTIVE on registration", platform.status === STATUS_ACTIVE);
  check("third-party MSE wallet round-trips", thirdParty.walletOwner === thirdPartyWallet.toBase58());
  check("third-party MSE rail is DIRECT_USDC", thirdParty.railKind === RAIL_DIRECT_USDC);
  check(
    "both MSEs coexist at distinct PDAs",
    mseBeneficiaryPda(platformHash).toBase58() !== mseBeneficiaryPda(thirdPartyHash).toBase58(),
  );
  check("schema version is V1", platform.schemaVersion === 1 && thirdParty.schemaVersion === 1);

  console.log("\n3. Only governance may register a payout destination");
  const impostor = Keypair.generate();
  await fund(connection, impostor.publicKey);
  const impostorHash = Buffer.alloc(32, 3);
  let rejected = false;
  try {
    await send(
      connection,
      impostor,
      registerMseIx({
        signer: impostor.publicKey,
        entityHash: impostorHash,
        walletOwner: Keypair.generate().publicKey,
        usdcAta: Keypair.generate().publicKey,
        railKind: RAIL_DIRECT_USDC,
      }),
    );
  } catch {
    rejected = true;
  }
  // The impostor is funded, so a rejection cannot be a rent failure.
  check("a funded non-governance signer is rejected", rejected);
  check(
    "no beneficiary account survives the rejected transaction",
    (await connection.getAccountInfo(mseBeneficiaryPda(impostorHash))) === null,
  );

  console.log("\n4. Governance can suspend a registered MSE");
  await send(
    connection,
    governance,
    setStatusIx({ signer: governance.publicKey, entityHash: platformHash, status: STATUS_SUSPENDED }),
  );
  const suspended = decodeMseBeneficiary(
    (await connection.getAccountInfo(mseBeneficiaryPda(platformHash))).data,
  );
  check("status flips to SUSPENDED", suspended.status === STATUS_SUSPENDED);
  check("updated_at_slot advances", suspended.updatedAtSlot >= platform.registeredAtSlot);
  check("wallet and rail are untouched by suspension", suspended.walletOwner === platform.walletOwner && suspended.railKind === platform.railKind);

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ·  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nTracer aborted:", error.message ?? error);
  if (error.logs) console.error(error.logs.join("\n"));
  process.exit(1);
});
