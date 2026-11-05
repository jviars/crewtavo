import { describe, expect, it } from "vitest";
import { laborRates, lateFeeAmount, lateFeeOn, lateFeeSettings, minimumCharge, minimumTopUp, workLines, workToBill, type LoggedTime } from "../src/billing";

describe("the minimum charge", () => {
  it("tops the charges up to the minimum, as the database's Minimum charge line does", () => {
    expect(minimumTopUp([{ quantity: 1, unit_price: 100 }], 150)).toBe(50);
    expect(minimumTopUp([{ quantity: 2, unit_price: 40 }, { quantity: 1, unit_price: 30 }], 150)).toBe(40);
    expect(minimumTopUp([{ quantity: 1, unit_price: 200 }], 150)).toBe(0);
  });

  it("counts only charges: not discounts, credits for a deposit, the line itself or a late fee", () => {
    const lines = [
      { quantity: 1, unit_price: 1000 },
      { quantity: 1, unit_price: -900 }, // Less deposit
      { quantity: 1, unit_price: 70, kind: "minimum" },
      { quantity: 1, unit_price: 25, kind: "late_fee" },
    ];
    expect(minimumTopUp(lines, 150)).toBe(0);
    expect(minimumTopUp([{ quantity: 1, unit_price: 80 }, { quantity: 1, unit_price: -20 }], 150)).toBe(70);
  });

  it("is off without a minimum, and an invoice with nothing on it isn't topped up", () => {
    expect(minimumTopUp([{ quantity: 1, unit_price: 10 }], null)).toBe(0);
    expect(minimumTopUp([], 150)).toBe(0);
    expect(minimumCharge({})).toBeNull();
    expect(minimumCharge({ minimum_charge: 0 })).toBeNull();
    expect(minimumCharge({ minimum_charge: 125 })).toBe(125);
  });
});

describe("late fees", () => {
  const fee = { type: "flat" as const, amount: 25, grace_days: 5 };
  const owed = { kind: "standard", status: "overdue", balance_due: 216, due_on: "2026-10-01", late_fee_at: null };

  it("are off unless the owner turns them on", () => {
    expect(lateFeeSettings({})).toBeNull();
    expect(lateFeeSettings({ late_fee: null })).toBeNull();
    expect(lateFeeSettings({ late_fee: { type: "flat", amount: 0 } })).toBeNull();
    expect(lateFeeSettings({ late_fee: { type: "percent", amount: 1.5, grace_days: 10 } })).toEqual({ type: "percent", amount: 1.5, grace_days: 10 });
  });

  it("are a flat amount or a percent of what's owed", () => {
    expect(lateFeeAmount(216, fee)).toBe(25);
    expect(lateFeeAmount(1000, { type: "percent", amount: 1.5, grace_days: 0 })).toBe(15);
    expect(lateFeeAmount(333.33, { type: "percent", amount: 1.5, grace_days: 0 })).toBe(5);
  });

  it("go on the day after the grace days, once", () => {
    expect(lateFeeOn(owed, fee)).toBe("2026-10-07");
    expect(lateFeeOn(owed, { ...fee, grace_days: 0 })).toBe("2026-10-02");
    // It has its fee: never another.
    expect(lateFeeOn({ ...owed, late_fee_at: "2026-10-07T14:00:00Z" }, fee)).toBeNull();
  });

  it("never go on a draft, paid, void or written-off invoice, nor one with nothing owed", () => {
    for (const status of ["draft", "paid", "void", "written_off"]) expect(lateFeeOn({ ...owed, status }, fee)).toBeNull();
    expect(lateFeeOn({ ...owed, balance_due: 0 }, fee)).toBeNull();
    expect(lateFeeOn({ ...owed, due_on: null }, fee)).toBeNull();
    expect(lateFeeOn(owed, null)).toBeNull();
  });

  it("never go on a deposit invoice, as the hourly task skips them", () => {
    expect(lateFeeOn({ ...owed, kind: "deposit" }, fee)).toBeNull();
    expect(lateFeeOn(owed, fee)).toBe("2026-10-07");
  });
});

describe("time and materials", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 5, h)).toISOString();
  const entry = (id: string, from: number, to: number | null, extra: Partial<LoggedTime> = {}): LoggedTime => ({ id, user_id: "u1", started_at: at(from), ended_at: to === null ? null : at(to), category: "visit", approved_at: null, ...extra });
  const labor = { id: "labor", name: "Labor", unit: "hr", unit_price: 85, taxable: false };
  const pipe = { id: "pipe", name: "Copper pipe", unit: "ft", unit_price: 4, taxable: true };
  const services = [pipe, { id: "trip", name: "Trip charge", unit: "visit", unit_price: 45, taxable: false }, { id: "senior", name: "Senior tech", unit: "hr", unit_price: 110, taxable: false }, labor];

  it("offers finished hours, approved or not, but not breaks, running clocks or hours already billed", () => {
    const offered = workToBill({
      time: [entry("a", 13, 16, { approved_at: at(17) }), entry("b", 8, 10), entry("lunch", 11, 12, { category: "break" }), entry("now", 9, null), entry("billed", 6, 7)],
      materials: [],
      billed: [{ time_entry_ids: ["billed"], material_ids: null }],
      services,
    });
    expect(offered.hours.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("offers materials not billed yet, priced from the price list, and lists ones with no item to price", () => {
    const offered = workToBill({
      time: [],
      materials: [
        { id: "m1", name: "Copper pipe", quantity: 20, unit: "ft", service_id: "pipe", logged_at: at(9) },
        { id: "m2", name: "Copper pipe", quantity: 12.5, unit: "ft", service_id: "pipe", logged_at: at(10) },
        { id: "m3", name: "Gasket kit ", quantity: 1, unit: "ea", service_id: null, logged_at: at(11) },
        { id: "m4", name: "gasket kit", quantity: 2, unit: "ea", service_id: null, logged_at: at(12) },
        { id: "m5", name: "Copper pipe", quantity: 3, unit: "ft", service_id: "pipe", logged_at: at(8) },
      ],
      billed: [{ time_entry_ids: null, material_ids: ["m5"] }],
      services,
    });
    expect(offered.materials).toEqual([
      { key: "pipe|ft", name: "Copper pipe", unit: "ft", quantity: 32.5, ids: ["m1", "m2"], service_id: "pipe", unit_price: 4, taxable: true },
      { key: "name:gasket kit|ea", name: "Gasket kit", unit: "ea", quantity: 3, ids: ["m3", "m4"], service_id: null, unit_price: null, taxable: true },
    ]);
  });

  it("bills hours at the Labor item's price, never what the worker is paid, and materials at theirs", () => {
    expect(laborRates(services).map((s) => s.id)).toEqual(["labor", "senior"]);
    const { hours, materials } = workToBill({
      time: [entry("a", 13, 16), entry("b", 8, 9, { started_at: new Date(Date.UTC(2026, 9, 6, 13)).toISOString(), ended_at: new Date(Date.UTC(2026, 9, 6, 14, 30)).toISOString() })],
      materials: [
        { id: "m1", name: "Copper pipe", quantity: 20, unit: "ft", service_id: "pipe", logged_at: at(9) },
        { id: "m3", name: "Gasket kit", quantity: 1, unit: "ea", service_id: null, logged_at: at(11) },
      ],
      billed: [],
      services,
    });
    const lines = workLines({ hours, rate: labor, materials, timeZone: "America/New_York" });
    expect(lines).toEqual([
      { service_id: "labor", name: "Labor", description: "Logged hours: Oct 5, Oct 6", quantity: 4.5, unit: "hr", unit_price: 85, taxable: false, time_entry_ids: ["a", "b"] },
      { service_id: "pipe", name: "Copper pipe", description: null, quantity: 20, unit: "ft", unit_price: 4, taxable: true, material_ids: ["m1"] },
    ]);
    // The gasket kit has no price list item: it goes on once the office prices it.
    expect(workLines({ hours: [], rate: labor, materials, prices: { "name:gasket kit|ea": 12 }, timeZone: "UTC" }).at(-1)).toMatchObject({ name: "Gasket kit", unit_price: 12, material_ids: ["m3"] });
  });
});
