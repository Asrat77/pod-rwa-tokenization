import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_ETB_PER_USD,
  isPlaceholderPriced,
  resolveContractUsdAmount,
} from "../src/index.js";

describe("contract FX resolution", () => {
  it("prefers an explicit USD amount and marks it as real", () => {
    const r = resolveContractUsdAmount(
      { financingAmount: 9_023_112, financingAmountUsd: 75_000, fxRate: 120 },
      { cluster: "devnet" },
    );
    expect(r.source).toBe("CONTRACT_USD");
    expect(r.rateApplied).toBe(1);
    expect(r.baseUnits).toBe("75000000000");
    expect(isPlaceholderPriced(r)).toBe(false);
  });

  it("uses a contract-supplied fx rate when no USD amount exists", () => {
    const r = resolveContractUsdAmount(
      { financingAmount: 12_000, fxRate: 120 },
      { cluster: "devnet" },
    );
    expect(r.source).toBe("CONTRACT_FX_RATE");
    expect(r.rateApplied).toBe(120);
    expect(r.baseUnits).toBe("100000000");
    expect(r.warning).toBeUndefined();
  });

  it("falls back to the placeholder and says so loudly", () => {
    const r = resolveContractUsdAmount({ financingAmount: 16_000 }, { cluster: "devnet" });
    expect(r.source).toBe("PLACEHOLDER_DEFAULT");
    expect(r.rateApplied).toBe(PLACEHOLDER_ETB_PER_USD);
    expect(isPlaceholderPriced(r)).toBe(true);
    expect(r.warning).toMatch(/UNVERIFIED FX/);
    expect(r.warning).toMatch(/Not valid for a priced offering/);
  });

  it("refuses to price a mainnet deal from the placeholder", () => {
    expect(() =>
      resolveContractUsdAmount({ financingAmount: 16_000 }, { cluster: "mainnet-beta" }),
    ).toThrow(/never price a mainnet deal/);
  });

  it("still allows mainnet when the contract carries real FX data", () => {
    expect(
      resolveContractUsdAmount(
        { financingAmount: 12_000, financingAmountUsd: 100 },
        { cluster: "mainnet-beta" },
      ).source,
    ).toBe("CONTRACT_USD");
  });

  it("rejects amounts that do not land on whole USDC base units", () => {
    expect(() =>
      resolveContractUsdAmount({ financingAmount: 1, fxRate: 3 }, { cluster: "devnet" }),
    ).toThrow(/whole USDC base units/);
  });

  it("rejects a non-positive or unparseable financing amount", () => {
    expect(() => resolveContractUsdAmount({ financingAmount: 0 }, { cluster: "devnet" })).toThrow(
      /positive finite number/,
    );
    expect(() => resolveContractUsdAmount({}, { cluster: "devnet" })).toThrow(
      /positive finite number/,
    );
  });
});
