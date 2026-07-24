import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertDeploymentContext,
  validateDeploymentManifest,
} from "../src/index.js";
import { DEVNET_GENESIS, PROGRAM_ID } from "./helpers.js";

function fixture(name: "devnet" | "localnet"): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../deployments/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

describe("deployment manifest validation", () => {
  it("validates the checked-in devnet manifest and its exact connection context", () => {
    const manifest = validateDeploymentManifest(fixture("devnet"), {
      expectedCluster: "devnet",
      expectedGenesisHash: DEVNET_GENESIS,
    });
    expect(manifest.programs.podVault).toBe(PROGRAM_ID);
    expect(
      assertDeploymentContext(manifest, {
        cluster: "devnet",
        genesisHash: DEVNET_GENESIS,
        podVaultProgramId: PROGRAM_ID,
        settlementAssetSymbol: "USDC",
        settlementMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }),
    ).toMatchObject({
      decimals: 6,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
  });

  it("allows an unresolved fixture mint only on localnet", () => {
    const manifest = validateDeploymentManifest(fixture("localnet"));
    expect(manifest.cluster).toBe("localnet");
    expect(manifest.settlementAssets.USDC_FIXTURE?.mint).toBeNull();
  });

  it("rejects a manifest whose declared cluster and genesis hash disagree", () => {
    const input = structuredClone(fixture("devnet")) as Record<string, unknown>;
    input.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    expect(() => validateDeploymentManifest(input)).toThrow(
      /does not match its declared cluster/,
    );
  });

  it("rejects extra properties and malformed public keys", () => {
    const extra = structuredClone(fixture("devnet")) as Record<string, unknown>;
    extra.unsafeRpcOverride = "https://example.invalid";
    expect(() => validateDeploymentManifest(extra)).toThrow(
      /unsupported properties/,
    );

    const badKey = structuredClone(fixture("devnet")) as {
      programs: Record<string, unknown>;
    };
    badKey.programs.podVault = "not-a-solana-key";
    expect(() => validateDeploymentManifest(badKey)).toThrow(/32 bytes/);
  });

  it("requires configured, independent authorities when promotion checks request them", () => {
    expect(() =>
      validateDeploymentManifest(fixture("devnet"), {
        requireConfiguredAuthorities: true,
      }),
    ).toThrow(/must be configured/);

    const input = structuredClone(fixture("devnet")) as {
      authorities: Record<string, unknown>;
    };
    const authority = "9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E";
    input.authorities = {
      protocolGovernanceSquadsVault: authority,
      issuerTreasurySquadsVault: authority,
      riskSquadsVault: "6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj",
      guardian: "GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn",
    };
    expect(() => validateDeploymentManifest(input)).toThrow(/distinct/);
  });

  it("fails closed when the connected program or mint differs", () => {
    const manifest = validateDeploymentManifest(fixture("devnet"));
    expect(() =>
      assertDeploymentContext(manifest, {
        cluster: "devnet",
        genesisHash: DEVNET_GENESIS,
        podVaultProgramId:
          "6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj",
        settlementAssetSymbol: "USDC",
        settlementMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }),
    ).toThrow(/does not match/);
  });

  it("pins Circle devnet USDC and requires signer/signature configuration together", () => {
    const wrongUsdc = structuredClone(fixture("devnet")) as {
      settlementAssets: Record<string, Record<string, unknown>>;
    };
    if (wrongUsdc.settlementAssets.USDC !== undefined) {
      wrongUsdc.settlementAssets.USDC.mint =
        "9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E";
    }
    expect(() => validateDeploymentManifest(wrongUsdc)).toThrow(
      /Circle's canonical mint/,
    );

    const halfSigned = structuredClone(fixture("devnet")) as Record<
      string,
      unknown
    >;
    halfSigned.signedBy =
      "9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E";
    expect(() => validateDeploymentManifest(halfSigned)).toThrow(
      /configured together/,
    );
  });
});
