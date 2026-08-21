import { invariant } from "./errors.js";
import type { SolanaCluster } from "./manifest.js";
import { baseUnits, type BaseUnitString } from "./money.js";

/**
 * Where a deal's USD amount came from. Recorded alongside the amount so the
 * provenance travels with the money instead of being lost at conversion.
 */
export type FxRateSourceV1 =
  | "CONTRACT_USD"
  | "CONTRACT_FX_RATE"
  | "PLACEHOLDER_DEFAULT";

/**
 * Stand-in ETB-per-USD rate used only to unblock staging while the contract
 * pipeline does not capture FX.
 *
 * This number is NOT a verified market rate. Every amount derived from it is
 * tagged `PLACEHOLDER_DEFAULT` and is rejected outside localnet/devnet. Replace
 * it by populating `financingAmountUsd` or `fxRate` on the source contract —
 * both fields already exist on the platform's `Contract` type and are currently
 * null on every record.
 */
export const PLACEHOLDER_ETB_PER_USD = 160;

/** Six-decimal USDC. */
const USDC_DECIMALS = 6;

export interface ContractAmountsV1 {
  readonly financingAmount?: number | string | null;
  readonly financingAmountUsd?: number | string | null;
  readonly fxRate?: number | string | null;
}

export interface ResolvedUsdAmountV1 {
  readonly baseUnits: BaseUnitString;
  readonly source: FxRateSourceV1;
  /** Local-currency units per USD actually applied. 1 when the source was already USD. */
  readonly rateApplied: number;
  /** Present only when the amount rests on the placeholder. */
  readonly warning?: string;
}

function toNumber(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  invariant(
    typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0,
    "INVALID_AMOUNT",
    `${field} must be a positive finite number`,
    { field, value: String(value) },
  );
  return parsed;
}

/** Converts a USD figure to six-decimal USDC base units, rejecting sub-cent dust. */
function usdToBaseUnits(usd: number, field: string): BaseUnitString {
  const scaled = usd * 10 ** USDC_DECIMALS;
  const rounded = Math.round(scaled);
  invariant(
    Math.abs(scaled - rounded) < 1e-6,
    "INVALID_AMOUNT",
    `${field} does not convert to whole USDC base units`,
    { field, usd, scaled },
  );
  invariant(
    Number.isSafeInteger(rounded),
    "INVALID_AMOUNT",
    `${field} exceeds the safe integer range`,
    { field, usd },
  );
  return baseUnits(BigInt(rounded), field);
}

/**
 * Resolves a contract's financing amount into USDC base units, preferring real
 * data and falling back to the placeholder only when the contract carries no FX
 * information at all.
 *
 * Precedence: an explicit USD amount, then a contract-supplied FX rate, then the
 * placeholder. The placeholder is refused on mainnet-beta.
 */
export function resolveContractUsdAmount(
  contract: ContractAmountsV1,
  options: { readonly cluster: SolanaCluster; readonly placeholderEtbPerUsd?: number } = {
    cluster: "localnet",
  },
): ResolvedUsdAmountV1 {
  if (contract.financingAmountUsd != null) {
    const usd = toNumber(contract.financingAmountUsd, "financingAmountUsd");
    return {
      baseUnits: usdToBaseUnits(usd, "financingAmountUsd"),
      source: "CONTRACT_USD",
      rateApplied: 1,
    };
  }

  const local = toNumber(contract.financingAmount, "financingAmount");

  if (contract.fxRate != null) {
    const rate = toNumber(contract.fxRate, "fxRate");
    return {
      baseUnits: usdToBaseUnits(local / rate, "financingAmount"),
      source: "CONTRACT_FX_RATE",
      rateApplied: rate,
    };
  }

  const rate = options.placeholderEtbPerUsd ?? PLACEHOLDER_ETB_PER_USD;
  invariant(
    options.cluster !== "mainnet-beta",
    "INVALID_ARGUMENT",
    "the placeholder FX rate must never price a mainnet deal — populate financingAmountUsd or fxRate on the contract",
    { cluster: options.cluster },
  );
  return {
    baseUnits: usdToBaseUnits(local / rate, "financingAmount"),
    source: "PLACEHOLDER_DEFAULT",
    rateApplied: rate,
    warning:
      `UNVERIFIED FX: ${local} local units converted at a placeholder ${rate} per USD. ` +
      "The contract carries neither financingAmountUsd nor fxRate. Not valid for a priced offering.",
  };
}

/** True when an amount rests on the placeholder and must not back a real deal. */
export function isPlaceholderPriced(resolved: ResolvedUsdAmountV1): boolean {
  return resolved.source === "PLACEHOLDER_DEFAULT";
}
