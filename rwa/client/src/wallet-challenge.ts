import {
  validateContentCommitment,
  validateIsoTimestamp,
  type ContentCommitment,
  type IsoTimestamp,
} from "./domain.js";
import { invariant } from "./errors.js";
import {
  createEvidenceCommitment,
  EVIDENCE_DOMAINS,
  type EvidenceValue,
} from "./evidence.js";
import {
  validateSolanaHash,
  validateSolanaPublicKey,
} from "./manifest.js";

export interface WalletChallengeV1 {
  readonly schemaVersion: 1;
  readonly domain: string;
  readonly walletAddress: string;
  readonly cognitoSubjectCommitment: ContentCommitment;
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly nonce: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly message: string;
  readonly challengeCommitment: ContentCommitment;
}

export interface CreateWalletChallengeInput {
  readonly domain: string;
  readonly walletAddress: string;
  readonly cognitoSubjectCommitment: ContentCommitment;
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly nonce: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface WalletChallengeExpectation {
  readonly domain: string;
  readonly walletAddress: string;
  readonly cognitoSubjectCommitment: ContentCommitment;
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly nonce: string;
  readonly now: Date | IsoTimestamp;
  readonly maxClockSkewMs?: number;
}

export type WalletSignature = string | Uint8Array;

export type WalletSignatureVerifier = (input: {
  readonly walletAddress: string;
  readonly message: Uint8Array;
  readonly signature: WalletSignature;
}) => boolean | Promise<boolean>;

export type WalletChallengeNonceConsumer = (input: {
  readonly nonce: string;
  readonly challengeCommitment: ContentCommitment;
  readonly expiresAt: IsoTimestamp;
}) => boolean | Promise<boolean>;

export interface VerifyWalletChallengeInput {
  readonly challenge: WalletChallengeV1;
  readonly expected: WalletChallengeExpectation;
  readonly signature: WalletSignature;
  readonly verifySignature: WalletSignatureVerifier;
  readonly consumeNonce: WalletChallengeNonceConsumer;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;

function validateDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invariant(false, "INVALID_ARGUMENT", "challenge domain must be an origin");
  }
  invariant(
    url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    "INVALID_ARGUMENT",
    "challenge domain must not contain credentials, a path, query, or fragment",
  );
  const localDevelopment =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  invariant(
    url.protocol === "https:" ||
      (localDevelopment && url.protocol === "http:"),
    "INVALID_ARGUMENT",
    "challenge domain must use HTTPS outside local development",
  );
  invariant(
    value === url.origin,
    "INVALID_ARGUMENT",
    "challenge domain must use its canonical origin form",
    { canonicalOrigin: url.origin },
  );
  return url.origin;
}

function validateNonce(value: string): string {
  invariant(
    NONCE_PATTERN.test(value),
    "INVALID_ARGUMENT",
    "challenge nonce must contain at least 128 bits of base64url-style entropy",
  );
  return value;
}

function challengeEvidence(
  input: Omit<WalletChallengeV1, "message" | "challengeCommitment">,
): EvidenceValue {
  return {
    schemaVersion: input.schemaVersion,
    domain: input.domain,
    walletAddress: input.walletAddress,
    cognitoSubjectCommitment: input.cognitoSubjectCommitment,
    clusterGenesisHash: input.clusterGenesisHash,
    programId: input.programId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

function renderWalletChallengeMessage(
  input: Omit<WalletChallengeV1, "message" | "challengeCommitment">,
): string {
  return [
    "POD RWA Wallet Binding",
    "",
    `Domain: ${input.domain}`,
    `Wallet: ${input.walletAddress}`,
    `Cognito Subject: ${input.cognitoSubjectCommitment}`,
    `Cluster Genesis Hash: ${input.clusterGenesisHash}`,
    `Program ID: ${input.programId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
    "Version: 1",
  ].join("\n");
}

export function createWalletChallenge(
  input: CreateWalletChallengeInput,
): WalletChallengeV1 {
  const domain = validateDomain(input.domain);
  const walletAddress = validateSolanaPublicKey(
    input.walletAddress,
    "walletAddress",
  );
  validateContentCommitment(
    input.cognitoSubjectCommitment,
    "cognitoSubjectCommitment",
  );
  validateSolanaHash(input.clusterGenesisHash, "clusterGenesisHash");
  const programId = validateSolanaPublicKey(input.programId, "programId");
  const nonce = validateNonce(input.nonce);
  const issued = validateIsoTimestamp(input.issuedAt, "issuedAt");
  const expires = validateIsoTimestamp(input.expiresAt, "expiresAt");
  invariant(
    expires.getTime() > issued.getTime() &&
      expires.getTime() - issued.getTime() <= MAX_CHALLENGE_LIFETIME_MS,
    "INVALID_ARGUMENT",
    "wallet challenges must expire within five minutes after issuance",
  );

  const fields = {
    schemaVersion: 1 as const,
    domain,
    walletAddress,
    cognitoSubjectCommitment: input.cognitoSubjectCommitment,
    clusterGenesisHash: input.clusterGenesisHash,
    programId,
    nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  return {
    ...fields,
    message: renderWalletChallengeMessage(fields),
    challengeCommitment: createEvidenceCommitment(
      EVIDENCE_DOMAINS.walletChallenge,
      challengeEvidence(fields),
    ),
  };
}

export function validateWalletChallenge(
  challenge: WalletChallengeV1,
  expected: WalletChallengeExpectation,
): WalletChallengeV1 {
  invariant(
    challenge.schemaVersion === 1,
    "CHALLENGE_MISMATCH",
    "unsupported wallet challenge version",
  );
  const expectedDomain = validateDomain(expected.domain);
  validateContentCommitment(
    expected.cognitoSubjectCommitment,
    "expected.cognitoSubjectCommitment",
  );
  validateNonce(expected.nonce);
  validateSolanaPublicKey(expected.walletAddress, "expected.walletAddress");
  validateSolanaHash(
    expected.clusterGenesisHash,
    "expected.clusterGenesisHash",
  );
  validateSolanaPublicKey(expected.programId, "expected.programId");

  const comparisons: readonly (readonly [string, string, string])[] = [
    ["domain", challenge.domain, expectedDomain],
    ["walletAddress", challenge.walletAddress, expected.walletAddress],
    [
      "cognitoSubjectCommitment",
      challenge.cognitoSubjectCommitment,
      expected.cognitoSubjectCommitment,
    ],
    [
      "clusterGenesisHash",
      challenge.clusterGenesisHash,
      expected.clusterGenesisHash,
    ],
    ["programId", challenge.programId, expected.programId],
    ["nonce", challenge.nonce, expected.nonce],
  ];
  const mismatch = comparisons.find(([, actual, wanted]) => actual !== wanted);
  invariant(
    mismatch === undefined,
    "CHALLENGE_MISMATCH",
    mismatch === undefined
      ? "wallet challenge mismatch"
      : `wallet challenge ${mismatch[0]} does not match the expected context`,
  );

  const issued = validateIsoTimestamp(challenge.issuedAt, "issuedAt");
  const expires = validateIsoTimestamp(challenge.expiresAt, "expiresAt");
  invariant(
    expires.getTime() > issued.getTime() &&
      expires.getTime() - issued.getTime() <= MAX_CHALLENGE_LIFETIME_MS,
    "CHALLENGE_MISMATCH",
    "wallet challenge lifetime is invalid",
  );
  const now =
    expected.now instanceof Date
      ? expected.now
      : validateIsoTimestamp(expected.now, "now");
  const maxClockSkewMs = expected.maxClockSkewMs ?? 30_000;
  invariant(
    Number.isSafeInteger(maxClockSkewMs) &&
      maxClockSkewMs >= 0 &&
      maxClockSkewMs <= 60_000,
    "INVALID_ARGUMENT",
    "maxClockSkewMs must be between zero and sixty seconds",
  );
  invariant(
    issued.getTime() <= now.getTime() + maxClockSkewMs,
    "CHALLENGE_MISMATCH",
    "wallet challenge was issued too far in the future",
  );
  invariant(
    now.getTime() < expires.getTime(),
    "CHALLENGE_EXPIRED",
    "wallet challenge has expired",
  );

  const fields = {
    schemaVersion: 1 as const,
    domain: challenge.domain,
    walletAddress: challenge.walletAddress,
    cognitoSubjectCommitment: challenge.cognitoSubjectCommitment,
    clusterGenesisHash: challenge.clusterGenesisHash,
    programId: challenge.programId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
  invariant(
    challenge.message === renderWalletChallengeMessage(fields),
    "CHALLENGE_MISMATCH",
    "wallet challenge message was modified",
  );
  const expectedCommitment = createEvidenceCommitment(
    EVIDENCE_DOMAINS.walletChallenge,
    challengeEvidence(fields),
  );
  invariant(
    challenge.challengeCommitment === expectedCommitment,
    "CHALLENGE_MISMATCH",
    "wallet challenge commitment was modified",
  );
  return challenge;
}

export async function verifyWalletChallenge(
  input: VerifyWalletChallengeInput,
): Promise<WalletChallengeV1> {
  const challenge = validateWalletChallenge(input.challenge, input.expected);
  const signatureIsValid = await input.verifySignature({
    walletAddress: challenge.walletAddress,
    message: new TextEncoder().encode(challenge.message),
    signature: input.signature,
  });
  invariant(
    signatureIsValid,
    "SIGNATURE_INVALID",
    "wallet challenge signature is invalid",
  );
  const consumed = await input.consumeNonce({
    nonce: challenge.nonce,
    challengeCommitment: challenge.challengeCommitment,
    expiresAt: challenge.expiresAt,
  });
  invariant(
    consumed,
    "CHALLENGE_REPLAYED",
    "wallet challenge nonce has already been consumed",
  );
  return challenge;
}
