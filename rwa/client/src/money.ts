import { RwaDomainError, invariant } from "./errors.js";

declare const baseUnitStringBrand: unique symbol;

/**
 * A non-negative integer amount serialized in the settlement asset's smallest
 * unit. The brand can only be constructed through {@link baseUnits}.
 */
export type BaseUnitString = string & {
  readonly [baseUnitStringBrand]: "BaseUnitString";
};

export type BaseUnitInput = BaseUnitString | bigint | string;

const BASE_UNIT_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = (1n << 64n) - 1n;

export function baseUnits(value: BaseUnitInput, field = "amount"): BaseUnitString {
  const serialized = typeof value === "bigint" ? value.toString(10) : value;
  invariant(
    BASE_UNIT_PATTERN.test(serialized),
    "INVALID_AMOUNT",
    `${field} must be a canonical non-negative base-unit integer string`,
    { field, value: serialized },
  );
  invariant(
    BigInt(serialized) <= MAX_U64,
    "INVALID_AMOUNT",
    `${field} exceeds the u64 maximum`,
    { field, value: serialized },
  );
  return serialized as BaseUnitString;
}

export function parseBaseUnits(value: BaseUnitInput, field = "amount"): bigint {
  return BigInt(baseUnits(value, field));
}

export function addBaseUnits(
  left: BaseUnitInput,
  right: BaseUnitInput,
): BaseUnitString {
  return baseUnits(
    checkedU64(parseBaseUnits(left) + parseBaseUnits(right), "sum"),
  );
}

export function subtractBaseUnits(
  left: BaseUnitInput,
  right: BaseUnitInput,
): BaseUnitString {
  const result = parseBaseUnits(left) - parseBaseUnits(right);
  invariant(
    result >= 0n,
    "INVALID_AMOUNT",
    "base-unit subtraction cannot be negative",
    { left: baseUnits(left), right: baseUnits(right) },
  );
  return baseUnits(result);
}

export function checkedU64(value: bigint, field = "amount"): bigint {
  if (value < 0n || value > MAX_U64) {
    throw new RwaDomainError(
      "INVALID_AMOUNT",
      `${field} is outside the u64 range`,
      { field, value: value.toString(10) },
    );
  }
  return value;
}

export function validateBasisPoints(
  value: number,
  field = "basisPoints",
): number {
  invariant(
    Number.isSafeInteger(value) && value >= 0 && value <= 10_000,
    "INVALID_ARGUMENT",
    `${field} must be an integer between 0 and 10,000`,
    { field, value },
  );
  return value;
}

/**
 * Multiplies a u64 amount by basis points using a u128-style intermediate and
 * rounds down. JavaScript bigint is arbitrary precision; the result is checked
 * back into the on-chain u64 range.
 */
export function applyBasisPoints(
  amount: BaseUnitInput,
  basisPoints: number,
): BaseUnitString {
  validateBasisPoints(basisPoints);
  const result = (parseBaseUnits(amount) * BigInt(basisPoints)) / 10_000n;
  return baseUnits(checkedU64(result, "basis-point result"));
}

export function multiplyDivideFloor(
  multiplicand: BaseUnitInput,
  multiplier: BaseUnitInput,
  divisor: BaseUnitInput,
): BaseUnitString {
  const divisorValue = parseBaseUnits(divisor, "divisor");
  invariant(
    divisorValue > 0n,
    "INVALID_AMOUNT",
    "divisor must be greater than zero",
  );
  const result =
    (parseBaseUnits(multiplicand, "multiplicand") *
      parseBaseUnits(multiplier, "multiplier")) /
    divisorValue;
  return baseUnits(checkedU64(result, "multiplication result"));
}
