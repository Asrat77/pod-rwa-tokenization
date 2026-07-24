import type { PublicKey, Transaction } from "@solana/web3.js";

export interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey?: PublicKey;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect?: () => Promise<void>;
  signMessage: (
    message: Uint8Array,
    display?: "utf8",
  ) => Promise<{ signature: Uint8Array } | Uint8Array>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (
    transaction: Transaction,
  ) => Promise<{ signature: string } | string>;
}

declare global {
  interface Window {
    solana?: InjectedSolanaProvider;
  }
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = base58Alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + encoded;
}

export async function connectWallet(): Promise<{
  provider: InjectedSolanaProvider;
  wallet: string;
}> {
  const provider = window.solana;
  if (!provider) {
    throw new Error("A compatible Solana wallet extension is required");
  }
  const result = await provider.connect();
  return { provider, wallet: result.publicKey.toBase58() };
}

export async function signBindingMessage(
  provider: InjectedSolanaProvider,
  message: string,
): Promise<string> {
  const result = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  const signature = result instanceof Uint8Array ? result : result.signature;
  return encodeBase58(signature);
}
