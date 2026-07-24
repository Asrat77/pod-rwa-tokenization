export type RwaDomainErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_AMOUNT"
  | "INVALID_MANIFEST"
  | "INVALID_PARTY_CONFIGURATION"
  | "INVALID_STATE_TRANSITION"
  | "INVARIANT_VIOLATION"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_MISMATCH"
  | "CHALLENGE_REPLAYED"
  | "SIGNATURE_INVALID";

export class RwaDomainError extends Error {
  readonly code: RwaDomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RwaDomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RwaDomainError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: RwaDomainErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): asserts condition {
  if (!condition) {
    throw new RwaDomainError(code, message, details);
  }
}
