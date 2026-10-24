import { describe, expect, it } from "vitest";
import { breakPay, isUnpaidBreak } from "../src/breaks";

const at = (minutes: number) => new Date(Date.parse("2026-10-24T16:00:00Z") + minutes * 60_000).toISOString();
const entry = (category: string, minutes: number | null) => ({ category, started_at: at(0), ended_at: minutes === null ? null : at(minutes) });

describe("paid and unpaid breaks", () => {
  it("follows the federal rule unless the company chose otherwise", () => {
    expect(breakPay({})).toBe("short_paid");
    expect(breakPay(null)).toBe("short_paid");
    expect(breakPay({ clock: { breaks: "unpaid" } })).toBe("unpaid");
    expect(breakPay({ clock: { breaks: "paid", record_location: false } })).toBe("paid");
    expect(breakPay({ clock: { breaks: "sometimes" } })).toBe("short_paid");
  });

  it("pays a short rest break and not a lunch, under the federal rule", () => {
    expect(isUnpaidBreak(entry("break", 10), "short_paid")).toBe(false);
    expect(isUnpaidBreak(entry("break", 20), "short_paid")).toBe(false);
    expect(isUnpaidBreak(entry("break", 30), "short_paid")).toBe(true);
  });

  it("judges a break still running on its length so far", () => {
    expect(isUnpaidBreak(entry("break", null), "short_paid", Date.parse(at(15)))).toBe(false);
    expect(isUnpaidBreak(entry("break", null), "short_paid", Date.parse(at(45)))).toBe(true);
  });

  it("pays every break, or none, when the company says so", () => {
    expect(isUnpaidBreak(entry("break", 45), "paid")).toBe(false);
    expect(isUnpaidBreak(entry("break", 5), "unpaid")).toBe(true);
  });

  it("never leaves out work, driving or shop time", () => {
    for (const category of ["visit", "assessment", "drive", "shop", "other"]) expect(isUnpaidBreak(entry(category, 600), "unpaid")).toBe(false);
  });
});
