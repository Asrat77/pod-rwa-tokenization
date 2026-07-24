import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PILOT_TERMS_V1,
  allocateMilestoneAmounts,
  allocateProRataPayouts,
  applyBasisPoints,
  baseUnits,
  calculateProRataPayout,
  calculateSettlementWaterfall,
  parseBaseUnits,
} from "../src/index.js";

describe("base-unit money", () => {
  it("uses canonical strings and bigint without floating-point values", () => {
    expect(baseUnits(15_000_000n)).toBe("15000000");
    expect(parseBaseUnits("15000000")).toBe(15_000_000n);
    expect(applyBasisPoints("30000000", 1_000)).toBe("3000000");
  });

  it.each(["-1", "01", "1.5", "1e6", "", " 1"])(
    "rejects non-canonical amount %s",
    (amount) => {
      expect(() => baseUnits(amount)).toThrow();
    },
  );

  it("rejects a value above the on-chain u64 range", () => {
    expect(() => baseUnits(1n << 64n)).toThrow(/u64 maximum/);
  });
});

describe("pilot economics", () => {
  it("matches the two durable pilot fixtures", () => {
    const checkedInFixture = JSON.parse(
      readFileSync(
        new URL("../../fixtures/pilot-deals-v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(PILOT_TERMS_V1).toEqual(checkedInFixture);
    expect(PILOT_TERMS_V1.deals).toHaveLength(2);
    expect(PILOT_TERMS_V1.hardCapBaseUnits).toBe("30000000");
    expect(PILOT_TERMS_V1.milestones.map((item) => item.allocationBps)).toEqual([
      3_000, 3_000, 3_000, 1_000,
    ]);
  });

  it("allocates every base unit and assigns rounding remainder to the final milestone", () => {
    expect(
      allocateMilestoneAmounts(
        "30000000",
        PILOT_TERMS_V1.milestones.map((item) => item.allocationBps),
      ),
    ).toEqual(["9000000", "9000000", "9000000", "3000000"]);
    expect(allocateMilestoneAmounts("7", [3_000, 3_000, 3_000, 1_000])).toEqual(
      ["2", "2", "2", "1"],
    );
    expect(allocateMilestoneAmounts("1", [3_000, 3_000, 3_000, 1_000])).toEqual(
      ["0", "0", "0", "1"],
    );
  });

  it("calculates the full-repayment waterfall and equal fixture payouts", () => {
    const waterfall = calculateSettlementWaterfall(
      "30000000",
      "33000000",
      1_000,
      0,
    );
    expect(waterfall).toMatchObject({
      outcome: "FULL_REPAYMENT",
      principalPoolBaseUnits: "30000000",
      couponPoolBaseUnits: "3000000",
      investorPoolBaseUnits: "33000000",
      feePoolBaseUnits: "0",
      issuerResidualBaseUnits: "0",
    });
    expect(
      allocateProRataPayouts(
        ["15000000", "15000000"],
        waterfall.investorPoolBaseUnits,
        "30000000",
      ),
    ).toEqual({
      payoutsBaseUnits: ["16500000", "16500000"],
      allocatedBaseUnits: "33000000",
      roundingDustBaseUnits: "0",
    });
  });

  it("puts a shortfall entirely into the investor pool pro rata", () => {
    const waterfall = calculateSettlementWaterfall(
      "30000000",
      "24000000",
      1_000,
      100,
    );
    expect(waterfall.outcome).toBe("DEFAULT");
    expect(waterfall.investorPoolBaseUnits).toBe("24000000");
    expect(waterfall.feePoolBaseUnits).toBe("0");
    expect(waterfall.issuerResidualBaseUnits).toBe("0");
    expect(calculateProRataPayout("15000000", "24000000", "30000000")).toBe(
      "12000000",
    );
  });

  it("pays disclosed fees only after principal and coupon, then issuer residual", () => {
    const waterfall = calculateSettlementWaterfall(
      "30000000",
      "35000000",
      1_000,
      100,
    );
    expect(waterfall.investorPoolBaseUnits).toBe("33000000");
    expect(waterfall.feePoolBaseUnits).toBe("300000");
    expect(waterfall.issuerResidualBaseUnits).toBe("1700000");
  });

  it("leaves rounding dust unassigned rather than favoring the last holder", () => {
    expect(allocateProRataPayouts(["1", "1", "1"], "10", "3")).toEqual({
      payoutsBaseUnits: ["3", "3", "3"],
      allocatedBaseUnits: "9",
      roundingDustBaseUnits: "1",
    });
  });

  it("rejects malformed allocations and incomplete holder snapshots", () => {
    expect(() => allocateMilestoneAmounts("100", [5_000, 4_999])).toThrow(
      /10,000/,
    );
    expect(() =>
      allocateProRataPayouts(["10", "9"], "20", "20"),
    ).toThrow(/must equal/);
  });
});
