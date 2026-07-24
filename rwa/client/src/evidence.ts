import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";

import { invariant } from "./errors.js";
import {
  validateContentCommitment,
  type ContentCommitment,
} from "./domain.js";

export const EVIDENCE_DOMAINS = {
  legalName: "pod.rwa.legal-name.v1",
  assetSet: "pod.rwa.asset-set.v1",
  legalDocument: "pod.rwa.legal-document.v1",
  valuation: "pod.rwa.valuation.v1",
  compliancePolicy: "pod.rwa.compliance-policy.v1",
  fiatRoute: "pod.rwa.fiat-route.v1",
  conversionProvider: "pod.rwa.treasury.conversion-provider.v1",
  conversion: "pod.rwa.treasury.conversion-evidence.v1",
  swiftUetr: "pod.rwa.treasury.swift-uetr.v1",
  swiftSending: "pod.rwa.treasury.swift-sending.v1",
  bankConfirmation: "pod.rwa.treasury.bank-confirmation.v1",
  disbursementReconciliation: "pod.rwa.treasury.disbursement-reconciliation.v1",
  repaymentBankReceipt: "pod.rwa.treasury.repayment-bank-receipt.v1",
  repaymentConversionProvider:
    "pod.rwa.treasury.repayment-conversion-provider.v1",
  repaymentConversion: "pod.rwa.treasury.repayment-conversion-evidence.v1",
  repaymentReconciliation: "pod.rwa.treasury.repayment-reconciliation.v1",
  failure: "pod.rwa.treasury.failure.v1",
  walletChallenge: "pod.rwa.wallet-challenge.v1",
} as const;

export type EvidenceDomain =
  (typeof EVIDENCE_DOMAINS)[keyof typeof EVIDENCE_DOMAINS];

export type EvidenceValue =
  | null
  | boolean
  | number
  | string
  | readonly EvidenceValue[]
  | { readonly [key: string]: EvidenceValue };

const DOMAIN_PATTERN = /^pod\.rwa\.[a-z0-9.-]+\.v[1-9][0-9]*$/;
const ENCODING_PREFIX = utf8ToBytes("POD:RWA:EVIDENCE");

function canonicalJson(
  value: EvidenceValue,
  ancestors: Set<object> = new Set(),
): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      invariant(
        Number.isSafeInteger(value),
        "INVALID_ARGUMENT",
        "evidence numbers must be safe integers; encode money as base-unit strings",
        { value },
      );
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      invariant(
        !ancestors.has(value),
        "INVALID_ARGUMENT",
        "evidence cannot contain cyclic references",
      );
      ancestors.add(value);
      if (Array.isArray(value)) {
        const serialized = `[${value
          .map((item) => canonicalJson(item, ancestors))
          .join(",")}]`;
        ancestors.delete(value);
        return serialized;
      }
      const prototype = Object.getPrototypeOf(value);
      invariant(
        prototype === Object.prototype || prototype === null,
        "INVALID_ARGUMENT",
        "evidence objects must be plain records",
      );
      const entries = Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const serialized = `{${entries
        .map(
          ([key, item]) =>
            `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`,
        )
        .join(",")}}`;
      ancestors.delete(value);
      return serialized;
    }
    default:
      invariant(
        false,
        "INVALID_ARGUMENT",
        "evidence contains an unsupported runtime value",
      );
  }
}

function lengthPrefix(value: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + value.length);
  new DataView(framed.buffer).setUint32(0, value.length, false);
  framed.set(value, 4);
  return framed;
}

/**
 * Creates a domain-separated SHA-256 commitment over canonical JSON. Length
 * framing prevents two fields or domains from being concatenated ambiguously.
 */
export function createEvidenceCommitment(
  domain: EvidenceDomain,
  evidence: EvidenceValue,
): ContentCommitment {
  invariant(
    DOMAIN_PATTERN.test(domain),
    "INVALID_ARGUMENT",
    "evidence domain must use the pod.rwa namespace and an explicit version",
    { domain },
  );
  const domainBytes = utf8ToBytes(domain);
  const evidenceBytes = utf8ToBytes(canonicalJson(evidence));
  const digest = bytesToHex(
    sha256(
      concatBytes(
        lengthPrefix(ENCODING_PREFIX),
        lengthPrefix(domainBytes),
        lengthPrefix(evidenceBytes),
      ),
    ),
  );
  return `sha256:${digest}`;
}

export function verifyEvidenceCommitment(
  commitment: ContentCommitment,
  domain: EvidenceDomain,
  evidence: EvidenceValue,
): boolean {
  validateContentCommitment(commitment, "commitment");
  const expectedCommitment = createEvidenceCommitment(domain, evidence);
  let difference = 0;
  for (let index = 0; index < commitment.length; index += 1) {
    difference |=
      commitment.charCodeAt(index) ^ expectedCommitment.charCodeAt(index);
  }
  return difference === 0;
}
