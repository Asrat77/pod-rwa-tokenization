import {
  createEvidenceCommitment,
  EVIDENCE_DOMAINS,
  type ContentCommitment,
} from "../src/index.js";

export const PROGRAM_ID = "GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn";
export const WALLET = "9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E";
export const OTHER_WALLET =
  "6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function commitment(value: string): ContentCommitment {
  return createEvidenceCommitment(EVIDENCE_DOMAINS.legalDocument, value);
}

export const NOW = "2026-07-23T18:00:00.000Z";
