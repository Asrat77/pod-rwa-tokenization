import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import type { RwaDeal, RwaEligibility } from "./types";
import type { InjectedSolanaProvider } from "./wallet";

const protocolSeed = new TextEncoder().encode("protocol");
const dealTermsSeed = new TextEncoder().encode("deal_terms");
const dealStateSeed = new TextEncoder().encode("deal_state");
const seriesSeed = new TextEncoder().encode("series");
const positionSeed = new TextEncoder().encode("position");
const receiptSeed = new TextEncoder().encode("subscription_receipt");
const hexPattern = /^[0-9a-f]{64}$/;

function fromHex(value: string, field: string): Uint8Array {
  if (!hexPattern.test(value)) throw new Error(`${field} is not a 32-byte lowercase hex value`);
  return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value > (1n << 64n) - 1n) throw new Error("Amount is outside u64 range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

async function sha256(value: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digestInput = Uint8Array.from(bytes).buffer;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

export async function submitSubscription({
  deal,
  eligibility,
  amountBaseUnits,
  provider,
}: {
  deal: RwaDeal;
  eligibility: RwaEligibility;
  amountBaseUnits: string;
  provider: InjectedSolanaProvider;
}): Promise<string> {
  if (deal.state !== "SUBSCRIPTION_OPEN") throw new Error("Subscription is not open");
  if (eligibility.status !== "ACTIVE") throw new Error("Investor eligibility must be active");
  if (!provider.publicKey) throw new Error("Wallet is not connected");
  if (provider.publicKey.toBase58() !== eligibility.wallet) {
    throw new Error("Connected wallet does not match the eligible investor wallet");
  }
  if (!/^[1-9][0-9]*$/.test(amountBaseUnits)) throw new Error("Subscription must be greater than zero");
  if (!deal.chain?.programId || !deal.dealIdHash || !deal.receiptMint) {
    throw new Error("The indexed deal is missing its on-chain subscription configuration");
  }
  if (deal.receiptTokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) {
    throw new Error("Receipt mint is not configured for Token-2022");
  }

  const program = new PublicKey(deal.chain.programId);
  const settlementMint = new PublicKey(deal.settlementMint);
  const receiptMint = new PublicKey(deal.receiptMint);
  const investor = provider.publicKey;
  const dealId = fromHex(deal.dealIdHash, "dealIdHash");
  const investorId = fromHex(
    eligibility.investorIdHash || "",
    "eligibility.investorIdHash",
  );
  const nonce = randomNonce();
  const nonceBytes = u64(nonce);
  const amount = BigInt(amountBaseUnits);

  const [protocol] = PublicKey.findProgramAddressSync([protocolSeed], program);
  const [dealTerms] = PublicKey.findProgramAddressSync([dealTermsSeed, dealId], program);
  const [dealState] = PublicKey.findProgramAddressSync([dealStateSeed, dealId], program);
  const [series] = PublicKey.findProgramAddressSync(
    [seriesSeed, dealId, Uint8Array.of(0)],
    program,
  );
  const [position] = PublicKey.findProgramAddressSync(
    [positionSeed, dealId, investorId],
    program,
  );
  const [operationReceipt] = PublicKey.findProgramAddressSync(
    [receiptSeed, dealId, investorId, nonceBytes],
    program,
  );
  const investorUsdc = getAssociatedTokenAddressSync(
    settlementMint,
    investor,
    false,
    TOKEN_PROGRAM_ID,
  );
  const subscriptionVault = getAssociatedTokenAddressSync(
    settlementMint,
    dealState,
    true,
    TOKEN_PROGRAM_ID,
  );
  const investorReceipt = getAssociatedTokenAddressSync(
    receiptMint,
    investor,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const payloadHash = await sha256(
    [
      "pod-rwa-subscription-intent-v1",
      deal.id,
      deal.dealIdHash,
      eligibility.investorId,
      investor.toBase58(),
      amountBaseUnits,
      nonce.toString(10),
      deal.termsHash,
    ].join("\n"),
  );
  const discriminator = (await sha256("global:subscribe")).slice(0, 8);
  const data = joinBytes(discriminator, u64(amount), nonceBytes, payloadHash);

  const instruction = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: protocol, isSigner: false, isWritable: false },
      { pubkey: dealTerms, isSigner: false, isWritable: false },
      { pubkey: dealState, isSigner: false, isWritable: true },
      { pubkey: series, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: operationReceipt, isSigner: false, isWritable: true },
      { pubkey: investorUsdc, isSigner: false, isWritable: true },
      { pubkey: subscriptionVault, isSigner: false, isWritable: true },
      { pubkey: investorReceipt, isSigner: false, isWritable: true },
      { pubkey: settlementMint, isSigner: false, isWritable: true },
      { pubkey: receiptMint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: investor, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const account = await connection.getAccountInfo(investorReceipt, "confirmed");
  const transaction = new Transaction();
  if (!account) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        investor,
        investorReceipt,
        investor,
        receiptMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  transaction.add(instruction);
  const blockhash = await connection.getLatestBlockhash("finalized");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.feePayer = investor;

  let signature: string;
  if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(transaction);
    signature = typeof result === "string" ? result : result.signature;
  } else if (provider.signTransaction) {
    const signed = await provider.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
  } else {
    throw new Error("The connected wallet cannot sign Solana transactions");
  }
  await connection.confirmTransaction({ signature, ...blockhash }, "finalized");
  return signature;
}
