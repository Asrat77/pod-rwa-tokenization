import { describe, expect, it, vi } from "vitest";

import {
  createWalletChallenge,
  validateWalletChallenge,
  verifyWalletChallenge,
  type WalletChallengeExpectation,
  type WalletChallengeV1,
} from "../src/index.js";
import {
  commitment,
  DEVNET_GENESIS,
  PROGRAM_ID,
  WALLET,
} from "./helpers.js";

const NONCE = "0123456789abcdefghijkl";
const SUBJECT = commitment("cognito-subject");

function challenge(): WalletChallengeV1 {
  return createWalletChallenge({
    domain: "https://invest.pod.example",
    walletAddress: WALLET,
    cognitoSubjectCommitment: SUBJECT,
    clusterGenesisHash: DEVNET_GENESIS,
    programId: PROGRAM_ID,
    nonce: NONCE,
    issuedAt: "2026-07-23T18:00:00.000Z",
    expiresAt: "2026-07-23T18:05:00.000Z",
  });
}

function expectation(
  overrides: Partial<WalletChallengeExpectation> = {},
): WalletChallengeExpectation {
  return {
    domain: "https://invest.pod.example",
    walletAddress: WALLET,
    cognitoSubjectCommitment: SUBJECT,
    clusterGenesisHash: DEVNET_GENESIS,
    programId: PROGRAM_ID,
    nonce: NONCE,
    now: "2026-07-23T18:01:00.000Z",
    ...overrides,
  };
}

describe("wallet binding challenge", () => {
  it("binds the signature message to domain, wallet, identity, cluster, program, nonce, and expiry", () => {
    const value = challenge();
    expect(value.message).toContain("Domain: https://invest.pod.example");
    expect(value.message).toContain(`Wallet: ${WALLET}`);
    expect(value.message).toContain(`Cognito Subject: ${SUBJECT}`);
    expect(value.message).toContain(`Cluster Genesis Hash: ${DEVNET_GENESIS}`);
    expect(value.message).toContain(`Program ID: ${PROGRAM_ID}`);
    expect(value.message).toContain(`Nonce: ${NONCE}`);
    expect(value.challengeCommitment).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateWalletChallenge(value, expectation())).toBe(value);
  });

  it("rejects a challenge replayed across domain, cluster, program, wallet, or identity", () => {
    const value = challenge();
    const mismatches: Partial<WalletChallengeExpectation>[] = [
      { domain: "https://admin.pod.example" },
      {
        clusterGenesisHash:
          "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      {
        programId: "6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj",
      },
      {
        walletAddress:
          "6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj",
      },
      { cognitoSubjectCommitment: commitment("other-subject") },
      { nonce: "abcdefghijkl0123456789" },
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        validateWalletChallenge(value, expectation(mismatch)),
      ).toThrow(/does not match/);
    }
  });

  it("rejects expiration, excessive lifetime, noncanonical domains, and message tampering", () => {
    expect(() =>
      validateWalletChallenge(
        challenge(),
        expectation({ now: "2026-07-23T18:05:00.001Z" }),
      ),
    ).toThrow(/expired/);
    expect(() =>
      validateWalletChallenge(
        challenge(),
        expectation({ now: "2026-07-23T18:05:00.000Z" }),
      ),
    ).toThrow(/expired/);
    expect(() =>
      createWalletChallenge({
        domain: "https://invest.pod.example/path",
        walletAddress: WALLET,
        cognitoSubjectCommitment: SUBJECT,
        clusterGenesisHash: DEVNET_GENESIS,
        programId: PROGRAM_ID,
        nonce: NONCE,
        issuedAt: "2026-07-23T18:00:00.000Z",
        expiresAt: "2026-07-23T18:05:01.000Z",
      }),
    ).toThrow();
    const original = challenge();
    expect(() =>
      validateWalletChallenge(
        {
          ...original,
          message: `${original.message}\nInjected: true`,
        },
        expectation(),
      ),
    ).toThrow(/message was modified/);
  });

  it("injects signature crypto and atomically consumes the nonce after verification", async () => {
    const verifier = vi.fn(() => true);
    const consumer = vi.fn(() => true);
    const value = challenge();
    await expect(
      verifyWalletChallenge({
        challenge: value,
        expected: expectation(),
        signature: new Uint8Array([1, 2, 3]),
        verifySignature: verifier,
        consumeNonce: consumer,
      }),
    ).resolves.toBe(value);
    expect(verifier).toHaveBeenCalledWith({
      walletAddress: WALLET,
      message: new TextEncoder().encode(value.message),
      signature: new Uint8Array([1, 2, 3]),
    });
    expect(consumer).toHaveBeenCalledWith({
      nonce: NONCE,
      challengeCommitment: value.challengeCommitment,
      expiresAt: value.expiresAt,
    });
  });

  it("does not consume a nonce for an invalid signature and rejects an already consumed nonce", async () => {
    const consumer = vi.fn(() => true);
    await expect(
      verifyWalletChallenge({
        challenge: challenge(),
        expected: expectation(),
        signature: "bad-signature",
        verifySignature: () => false,
        consumeNonce: consumer,
      }),
    ).rejects.toThrow(/signature is invalid/);
    expect(consumer).not.toHaveBeenCalled();

    await expect(
      verifyWalletChallenge({
        challenge: challenge(),
        expected: expectation(),
        signature: "valid-signature",
        verifySignature: () => true,
        consumeNonce: () => false,
      }),
    ).rejects.toThrow(/already been consumed/);
  });
});
