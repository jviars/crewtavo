import { describe, expect, it } from "vitest";
import { refundable } from "../src/features/invoices/refunds";
import { bankPayment, paidInStripe } from "../src/features/invoices/stripeInvoices";

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

describe("payments on invoices in Stripe", () => {
  const made = (status: string, detached_at: string | null = null) => ({ origin: "stripe", status, detached_at });

  it("are recorded in Stripe while an invoice made there is open there", () => {
    expect(paidInStripe([made("open")])).toBe(true);
    expect(paidInStripe([made("processing")])).toBe(true);
    // Paid, voided or written off there, it no longer asks for money.
    expect(paidInStripe([made("paid")])).toBe(false);
    expect(paidInStripe([made("void")])).toBe(false);
  });

  it("but here for Crewtavo's own, and for one in a Stripe account Crewtavo left", () => {
    // Crewtavo's own Stripe invoice is redone for what's left after a payment here.
    expect(paidInStripe([{ origin: "crewtavo", status: "open", detached_at: null }])).toBe(false);
    expect(paidInStripe([made("open", "2026-10-01T00:00:00Z")])).toBe(false);
    expect(paidInStripe([])).toBe(false);
  });
});

describe("a bank payment on its way through Stripe", () => {
  const row = (status: string, detached_at: string | null = null) => ({ origin: "crewtavo", status, detached_at, amount_due: 160 });
  const now = Date.parse("2026-10-18T12:00:00Z");

  it("is the one still clearing, and says when it's in a Stripe account Crewtavo left", () => {
    expect(bankPayment([row("void"), row("processing")], now)).toMatchObject({ status: "processing", left: false, amount_due: 160 });
    expect(bankPayment([row("processing", "2026-10-10T00:00:00Z")], now)).toMatchObject({ left: true });
    expect(bankPayment([row("open")], now)).toBeNull();
  });

  it("stops counting a month after Crewtavo left its account: it cleared or bounced there by then", () => {
    expect(bankPayment([row("processing", "2026-09-17T00:00:00Z")], now)).toBeNull();
  });
});
