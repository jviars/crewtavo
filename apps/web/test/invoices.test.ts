import { describe, expect, it } from "vitest";
import { refundable } from "../src/features/invoices/refunds";

describe("refunds", () => {
  const check = { amount: 100, method: "check", processor: null };

  it("counts earlier refunds against the payment", () => {
    expect(refundable(check, [check])).toBe(100);
    expect(refundable(check, [check, { amount: -40, method: "check" }])).toBe(60);
    // A $100 payment refunded once can't be refunded again.
    expect(refundable(check, [check, { amount: -100, method: "check" }])).toBe(0);
  });

  it("keeps each way of paying separate, and never refunds more than was paid", () => {
    const cash = { amount: 50, method: "cash", processor: null };
    expect(refundable(cash, [check, cash, { amount: -100, method: "check" }])).toBe(50);
    expect(refundable(check, [check, cash, { amount: -100, method: "check" }])).toBe(0);
    expect(refundable(check, [check, { amount: -0.1, method: "check" }, { amount: -0.2, method: "check" }])).toBe(99.7);
  });
});
