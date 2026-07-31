import { invariant } from "./errors.js";

export type SolanaCluster = "localnet" | "devnet" | "mainnet-beta";

export interface DeploymentProgramsV1 {
  readonly podOracle: string;
  readonly podCompliance: string;
  readonly podVault: string;
}

export interface SettlementAssetManifestV1 {
  readonly mint: string | null;
  readonly decimals: number;
  readonly tokenProgram: string;
}

export interface DeploymentAuthoritiesV1 {
  readonly protocolGovernanceSquadsVault: string | null;
  readonly issuerTreasurySquadsVault: string | null;
  readonly riskSquadsVault: string | null;
  readonly guardian: string | null;
}

export interface DeploymentManifestV1 {
  readonly schemaVersion: 1;
  readonly cluster: SolanaCluster;
  readonly genesisHash: string | null;
  readonly programs: DeploymentProgramsV1;
  readonly settlementAssets: Readonly<
    Record<string, SettlementAssetManifestV1>
  >;
  readonly authorities: DeploymentAuthoritiesV1;
  readonly generatedAt?: string | null;
  readonly sourceCommit?: string | null;
  readonly binaryHashes?: Readonly<Record<string, string>>;
  readonly idlHashes?: Readonly<Record<string, string>>;
  readonly signedBy?: string | null;
  readonly signature?: string | null;
}

export interface ManifestValidationOptions {
  readonly expectedCluster?: SolanaCluster;
  readonly expectedGenesisHash?: string;
  readonly requireConfiguredAuthorities?: boolean;
  readonly requireSignature?: boolean;
}

export interface DeploymentContextExpectation {
  readonly cluster: SolanaCluster;
  readonly genesisHash: string;
  readonly podVaultProgramId: string;
  readonly settlementAssetSymbol: string;
  readonly settlementMint: string;
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)]),
);

const KNOWN_GENESIS_HASHES: Readonly<
  Partial<Record<SolanaCluster, string>>
> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

export const CIRCLE_DEVNET_USDC_MINT =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SOLANA_LEGACY_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "cluster",
  "genesisHash",
  "programs",
  "settlementAssets",
  "authorities",
  "generatedAt",
  "sourceCommit",
  "binaryHashes",
  "idlHashes",
  "signedBy",
  "signature",
]);

function objectValue(
  value: unknown,
  field: string,
): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_MANIFEST",
    `${field} must be an object`,
  );
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  invariant(
    unexpected.length === 0,
    "INVALID_MANIFEST",
    `${field} contains unsupported properties`,
    { unexpected },
  );
}

function requiredString(value: unknown, field: string): string {
  invariant(
    typeof value === "string" && value.trim() === value && value.length > 0,
    "INVALID_MANIFEST",
    `${field} must be a non-empty canonical string`,
  );
  return value;
}

function optionalStringOrNull(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requiredString(value, field);
}

function decodeBase58(value: string): Uint8Array {
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    invariant(
      digit !== undefined,
      "INVALID_MANIFEST",
      "Solana identifiers must use base58",
      { value },
    );
    decoded = decoded * 58n + digit;
  }

  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  const leadingZeros = [...value].findIndex((character) => character !== "1");
  const zeroCount = leadingZeros === -1 ? value.length : leadingZeros;
  return Uint8Array.from([...new Array<number>(zeroCount).fill(0), ...bytes]);
}

export function validateSolanaPublicKey(
  value: string,
  field = "publicKey",
): string {
  invariant(
    value.length >= 32 &&
      value.length <= 44 &&
      decodeBase58(value).length === 32,
    "INVALID_MANIFEST",
    `${field} must decode to exactly 32 bytes`,
    { field, value },
  );
  return value;
}

export function validateSolanaHash(value: string, field = "hash"): string {
  invariant(
    value.length >= 32 && value.length <= 44,
    "INVALID_MANIFEST",
    `${field} must be a canonical base58-encoded Solana hash`,
    { field, value },
  );
  decodeBase58(value);
  return value;
}

export function validateSolanaSignature(
  value: string,
  field = "signature",
): string {
  invariant(
    value.length >= 64 &&
      value.length <= 88 &&
      decodeBase58(value).length === 64,
    "INVALID_MANIFEST",
    `${field} must decode to exactly 64 bytes`,
    { field, value },
  );
  return value;
}

function parseNullablePublicKey(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return validateSolanaPublicKey(requiredString(value, field), field);
}

function parseStringRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = objectValue(value, field);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      const hash = requiredString(item, `${field}.${key}`);
      invariant(
        /^sha256:[0-9a-f]{64}$/.test(hash),
        "INVALID_MANIFEST",
        `${field}.${key} must be a lowercase SHA-256 commitment`,
      );
      return [key, hash];
    }),
  );
}

function validateDistinct(
  entries: readonly (readonly [string, string | null])[],
  field: string,
): void {
  const configured = entries.filter(
    (entry): entry is readonly [string, string] => entry[1] !== null,
  );
  const duplicates = configured.filter(
    ([, value], index) =>
      configured.findIndex(([, candidate]) => candidate === value) !== index,
  );
  invariant(
    duplicates.length === 0,
    "INVALID_MANIFEST",
    `${field} must use distinct public keys`,
    { duplicateRoles: duplicates.map(([role]) => role) },
  );
}

export function validateDeploymentManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): DeploymentManifestV1 {
  const root = objectValue(input, "manifest");
  exactKeys(root, TOP_LEVEL_KEYS, "manifest");
  invariant(
    root.schemaVersion === 1,
    "INVALID_MANIFEST",
    "manifest.schemaVersion must be 1",
  );
  invariant(
    root.cluster === "localnet" ||
      root.cluster === "devnet" ||
      root.cluster === "mainnet-beta",
    "INVALID_MANIFEST",
    "manifest.cluster is unsupported",
  );
  const cluster = root.cluster;
  if (options.expectedCluster !== undefined) {
    invariant(
      cluster === options.expectedCluster,
      "INVALID_MANIFEST",
      "deployment cluster does not match the expected cluster",
      { expected: options.expectedCluster, actual: cluster },
    );
  }

  let genesisHash: string | null;
  if (root.genesisHash === null || root.genesisHash === undefined) {
    invariant(
      cluster === "localnet",
      "INVALID_MANIFEST",
      "a genesis hash is required outside localnet",
    );
    genesisHash = null;
  } else {
    genesisHash = requiredString(root.genesisHash, "manifest.genesisHash");
    validateSolanaHash(genesisHash, "manifest.genesisHash");
  }
  const knownGenesis = KNOWN_GENESIS_HASHES[cluster];
  if (knownGenesis !== undefined) {
    invariant(
      genesisHash === knownGenesis,
      "INVALID_MANIFEST",
      "manifest genesis hash does not match its declared cluster",
      { cluster, expected: knownGenesis, actual: genesisHash },
    );
  }
  if (options.expectedGenesisHash !== undefined) {
    invariant(
      genesisHash === options.expectedGenesisHash,
      "INVALID_MANIFEST",
      "manifest genesis hash does not match the connected cluster",
      { expected: options.expectedGenesisHash, actual: genesisHash },
    );
  }

  const programInput = objectValue(root.programs, "manifest.programs");
  exactKeys(
    programInput,
    new Set(["podOracle", "podCompliance", "podVault"]),
    "manifest.programs",
  );
  const programs: DeploymentProgramsV1 = {
    podOracle: validateSolanaPublicKey(
      requiredString(programInput.podOracle, "programs.podOracle"),
      "programs.podOracle",
    ),
    podCompliance: validateSolanaPublicKey(
      requiredString(programInput.podCompliance, "programs.podCompliance"),
      "programs.podCompliance",
    ),
    podVault: validateSolanaPublicKey(
      requiredString(programInput.podVault, "programs.podVault"),
      "programs.podVault",
    ),
  };
  validateDistinct(
    Object.entries(programs),
    "manifest program identifiers",
  );

  const settlementAssetInput = objectValue(
    root.settlementAssets,
    "manifest.settlementAssets",
  );
  invariant(
    Object.keys(settlementAssetInput).length > 0,
    "INVALID_MANIFEST",
    "at least one settlement asset is required",
  );
  const settlementAssets: Record<string, SettlementAssetManifestV1> = {};
  for (const [symbol, rawAsset] of Object.entries(settlementAssetInput)) {
    invariant(
      /^[A-Z][A-Z0-9_]{1,15}$/.test(symbol),
      "INVALID_MANIFEST",
      "settlement asset symbols must be uppercase identifiers",
      { symbol },
    );
    const asset = objectValue(rawAsset, `settlementAssets.${symbol}`);
    exactKeys(
      asset,
      new Set(["mint", "decimals", "tokenProgram"]),
      `settlementAssets.${symbol}`,
    );
    const mint = parseNullablePublicKey(
      asset.mint,
      `settlementAssets.${symbol}.mint`,
    );
    invariant(
      mint !== null || cluster === "localnet",
      "INVALID_MANIFEST",
      "only localnet settlement assets may have an unconfigured mint",
      { symbol },
    );
    invariant(
      Number.isSafeInteger(asset.decimals) &&
        Number(asset.decimals) >= 0 &&
        Number(asset.decimals) <= 18,
      "INVALID_MANIFEST",
      `settlementAssets.${symbol}.decimals must be an integer from 0 to 18`,
    );
    settlementAssets[symbol] = {
      mint,
      decimals: Number(asset.decimals),
      tokenProgram: validateSolanaPublicKey(
        requiredString(
          asset.tokenProgram,
          `settlementAssets.${symbol}.tokenProgram`,
        ),
        `settlementAssets.${symbol}.tokenProgram`,
      ),
    };
    if (cluster === "devnet" && symbol === "USDC") {
      invariant(
        mint === CIRCLE_DEVNET_USDC_MINT &&
          asset.decimals === 6 &&
          settlementAssets[symbol]?.tokenProgram ===
            SOLANA_LEGACY_TOKEN_PROGRAM_ID,
        "INVALID_MANIFEST",
        "devnet USDC must use Circle's canonical mint, decimals, and token program",
      );
    }
  }

  const authorityInput = objectValue(
    root.authorities,
    "manifest.authorities",
  );
  const authorityKeys = new Set([
    "protocolGovernanceSquadsVault",
    "issuerTreasurySquadsVault",
    "riskSquadsVault",
    "guardian",
  ]);
  exactKeys(authorityInput, authorityKeys, "manifest.authorities");
  const authorities: DeploymentAuthoritiesV1 = {
    protocolGovernanceSquadsVault: parseNullablePublicKey(
      authorityInput.protocolGovernanceSquadsVault,
      "authorities.protocolGovernanceSquadsVault",
    ),
    issuerTreasurySquadsVault: parseNullablePublicKey(
      authorityInput.issuerTreasurySquadsVault,
      "authorities.issuerTreasurySquadsVault",
    ),
    riskSquadsVault: parseNullablePublicKey(
      authorityInput.riskSquadsVault,
      "authorities.riskSquadsVault",
    ),
    guardian: parseNullablePublicKey(
      authorityInput.guardian,
      "authorities.guardian",
    ),
  };
  const authorityEntries = Object.entries(authorities);
  validateDistinct(authorityEntries, "manifest authorities");
  if (
    options.requireConfiguredAuthorities === true ||
    cluster === "mainnet-beta"
  ) {
    invariant(
      authorityEntries.every(([, value]) => value !== null),
      "INVALID_MANIFEST",
      "all deployment authorities must be configured",
    );
  }

  const generatedAt = optionalStringOrNull(
    root.generatedAt,
    "manifest.generatedAt",
  );
  const sourceCommit = optionalStringOrNull(
    root.sourceCommit,
    "manifest.sourceCommit",
  );
  const signedByRaw = optionalStringOrNull(root.signedBy, "manifest.signedBy");
  const signedBy =
    signedByRaw === undefined || signedByRaw === null
      ? signedByRaw
      : validateSolanaPublicKey(signedByRaw, "manifest.signedBy");
  const signature = optionalStringOrNull(
    root.signature,
    "manifest.signature",
  );
  const binaryHashes = parseStringRecord(
    root.binaryHashes,
    "manifest.binaryHashes",
  );
  const idlHashes = parseStringRecord(root.idlHashes, "manifest.idlHashes");
  if (generatedAt !== undefined && generatedAt !== null) {
    const parsed = new Date(generatedAt);
    invariant(
      !Number.isNaN(parsed.getTime()) && parsed.toISOString() === generatedAt,
      "INVALID_MANIFEST",
      "manifest.generatedAt must be an ISO-8601 UTC timestamp",
    );
  }
  if (sourceCommit !== undefined && sourceCommit !== null) {
    invariant(
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit),
      "INVALID_MANIFEST",
      "manifest.sourceCommit must be a lowercase 40- or 64-character commit hash",
    );
  }
  invariant(
    (signedBy === null || signedBy === undefined) ===
      (signature === null || signature === undefined),
    "INVALID_MANIFEST",
    "manifest.signedBy and manifest.signature must be configured together",
  );
  if (signature !== undefined && signature !== null) {
    validateSolanaSignature(signature, "manifest.signature");
  }
  if (options.requireSignature === true || cluster === "mainnet-beta") {
    invariant(
      signedBy !== undefined &&
        signedBy !== null &&
        signature !== undefined &&
        signature !== null,
      "INVALID_MANIFEST",
      "a signed deployment manifest is required",
    );
  }
  const programAndAuthorityValues = [
    ...Object.values(programs),
    ...Object.values(authorities).filter(
      (value): value is string => value !== null,
    ),
  ];
  invariant(
    new Set(programAndAuthorityValues).size === programAndAuthorityValues.length,
    "INVALID_MANIFEST",
    "program identifiers and authority addresses must not overlap",
  );

  return {
    schemaVersion: 1,
    cluster,
    genesisHash,
    programs,
    settlementAssets,
    authorities,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(sourceCommit !== undefined ? { sourceCommit } : {}),
    ...(binaryHashes !== undefined ? { binaryHashes } : {}),
    ...(idlHashes !== undefined ? { idlHashes } : {}),
    ...(signedBy !== undefined ? { signedBy } : {}),
    ...(signature !== undefined ? { signature } : {}),
  };
}

export function assertDeploymentContext(
  manifest: DeploymentManifestV1,
  expected: DeploymentContextExpectation,
): SettlementAssetManifestV1 {
  invariant(
    manifest.cluster === expected.cluster &&
      manifest.genesisHash === expected.genesisHash &&
      manifest.programs.podVault === expected.podVaultProgramId,
    "INVALID_MANIFEST",
    "connected Solana context does not match the signed deployment manifest",
  );
  const asset = manifest.settlementAssets[expected.settlementAssetSymbol];
  invariant(
    asset !== undefined && asset.mint === expected.settlementMint,
    "INVALID_MANIFEST",
    "settlement mint does not match the signed deployment manifest",
    { symbol: expected.settlementAssetSymbol },
  );
  return asset;
}
