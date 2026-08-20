import { describe, expect, it } from "vitest";
import { consignmentSplit, netToPay, tradeInIsDescribed } from "./acquisition";

describe("netToPay", () => {
  it("subtracts the discount and the allowance from the agreed price", () => {
    expect(netToPay({ agreedPrice: 900_000, discount: 20_000, tradeInAllowance: 150_000 })).toBe(
      730_000
    );
  });

  it("is the agreed price when there is neither", () => {
    expect(netToPay({ agreedPrice: 900_000 })).toBe(900_000);
    expect(netToPay({ agreedPrice: 900_000, discount: 0, tradeInAllowance: null })).toBe(900_000);
  });

  it("never goes negative — an over-allowance is an error, not a refund", () => {
    expect(netToPay({ agreedPrice: 100_000, tradeInAllowance: 400_000 })).toBe(0);
  });

  it("treats a non-number as absent rather than as NaN", () => {
    expect(netToPay({ agreedPrice: Number.NaN })).toBe(0);
    expect(netToPay({ agreedPrice: 500_000, discount: Number.NaN })).toBe(500_000);
    expect(netToPay({ agreedPrice: 500_000, tradeInAllowance: Number.NaN })).toBe(500_000);
  });

  it("rounds to piastres", () => {
    expect(netToPay({ agreedPrice: 100_000.555, discount: 0.11 })).toBe(100_000.45);
  });
});

describe("consignmentSplit", () => {
  it("takes a percentage of the settled price", () => {
    // The case the migration's own functional test books: 5% of 500,000.
    expect(consignmentSplit({ salePrice: 500_000, commissionType: "percent", commissionValue: 5 }))
      .toEqual({ commission: 25_000, amountDue: 475_000 });
  });

  it("takes a fixed fee as typed", () => {
    expect(consignmentSplit({ salePrice: 500_000, commissionType: "fixed", commissionValue: 30_000 }))
      .toEqual({ commission: 30_000, amountDue: 470_000 });
  });

  it("pays the consignor everything when no terms were ever recorded", () => {
    // Stock taken in before 0032's intake rule existed. Inventing a fee
    // the consignor never agreed to is the one thing this must not do.
    expect(consignmentSplit({ salePrice: 500_000, commissionType: null, commissionValue: null }))
      .toEqual({ commission: 0, amountDue: 500_000 });
    expect(
      consignmentSplit({ salePrice: 500_000, commissionType: undefined, commissionValue: 12 })
    ).toEqual({ commission: 0, amountDue: 500_000 });
  });

  it("clamps a fee larger than the sale, so amount_due can never be negative", () => {
    // consignment_payouts.amount_due is CHECKed >= 0; the SQL clamps
    // rather than refusing an otherwise valid sale, and so does this.
    expect(consignmentSplit({ salePrice: 100_000, commissionType: "fixed", commissionValue: 250_000 }))
      .toEqual({ commission: 100_000, amountDue: 0 });
    expect(consignmentSplit({ salePrice: 100_000, commissionType: "percent", commissionValue: 400 }))
      .toEqual({ commission: 100_000, amountDue: 0 });
  });

  it("clamps a negative fee to zero", () => {
    expect(consignmentSplit({ salePrice: 100_000, commissionType: "fixed", commissionValue: -5_000 }))
      .toEqual({ commission: 0, amountDue: 100_000 });
  });

  it("rounds the percentage to piastres, and the two halves still sum", () => {
    const { commission, amountDue } = consignmentSplit({
      salePrice: 333_333.33,
      commissionType: "percent",
      commissionValue: 7.5,
    });
    expect(commission).toBe(25_000);
    expect(commission + amountDue).toBeCloseTo(333_333.33, 2);
  });

  it("survives a non-number sale price", () => {
    expect(consignmentSplit({ salePrice: Number.NaN, commissionType: "percent", commissionValue: 5 }))
      .toEqual({ commission: 0, amountDue: 0 });
  });
});

describe("tradeInIsDescribed", () => {
  it("asks nothing of a ticket with no allowance", () => {
    expect(tradeInIsDescribed({ allowance: null, make: "", model: "" })).toBe(true);
  });

  it("requires a make and a model once an allowance is granted", () => {
    expect(tradeInIsDescribed({ allowance: 150_000, make: "Hyundai", model: "Elantra" })).toBe(true);
    expect(tradeInIsDescribed({ allowance: 150_000, make: "Hyundai", model: "" })).toBe(false);
    expect(tradeInIsDescribed({ allowance: 150_000, make: "", model: "Elantra" })).toBe(false);
    expect(tradeInIsDescribed({ allowance: 150_000, make: "   ", model: "  " })).toBe(false);
  });
});
