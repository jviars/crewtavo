import { describe, expect, it } from "vitest";
import {
  applyJob,
  calculate,
  DEFAULT_SETUP,
  jobFrom,
  keptOverrides,
  newInput,
  parseSetup,
  parseWorksheet,
  pricesDiffer,
  scopeText,
  withPrices,
  type CalcInput,
  type CalcSetup,
} from "../src/features/paving/calculator";

const at = (setup: CalcSetup, values: Record<string, number>, rest: Partial<CalcInput> = {}): CalcInput => ({ ...applyJob(setup, newInput(setup), null), values, ...rest });
const lineOf = (calc: ReturnType<typeof calculate>, id: string) => calc.lines.find((l) => l.item.id === id)!;

/** The first sheet: 12,000 sq ft, mill 2", 2" top coat, three full-crew days at $7,000 a day profit. */
const SHEET_1 = at(DEFAULT_SETUP, { mill: 2, top: 2, stone21a: 8, stone8: 35, fullCrew: 3 }, { sqft: 12_000 });

/** The second: the driveway with its circle, in four pieces; his own prices, profit in a $8,000 day. */
const SHEET_2_SETUP: CalcSetup = {
  ...withPrices(DEFAULT_SETUP, {
    ...DEFAULT_SETUP,
    profit: { by: "none", amount: 0 },
    items: DEFAULT_SETUP.items.map((i) => ({ ...i, price: ({ liquid: 4, stone21a: 25, stone8: 27, stone68: 27, top: 100, intermediate: 90, base: 88, fullCrew: 8000 } as Record<string, number>)[i.id] ?? i.price })),
  }),
};
const SIDES = [{ length: 240, width: 24 }, { length: 12, width: 26 }, { length: 36, width: 12 }, { length: 441, width: 12 }];
const SHEET_2 = at(SHEET_2_SETUP, { liquid: 0.4, stone21a: 8, stone68: 35, top: 2, fullCrew: 4 }, { sqft: 11_796, sides: SIDES, profit: { by: "none", amount: 0 } });

describe("Paving calculator", () => {
  it("works out amounts the way the sheet does, bought whole", () => {
    const calc = calculate(DEFAULT_SETUP, { ...SHEET_1, values: { ...SHEET_1.values, liquid: 0.1 } });
    expect(calc.sqyd).toBe(1333.333);
    expect(lineOf(calc, "top").worked).toBe(147); // 146.67 tons
    expect(lineOf(calc, "stone21a").worked).toBe(587); // 586.67 tons at 8"
    expect(lineOf(calc, "stone8").worked).toBe(24); // 23.33 tons at 35 lb/sq yd
    expect(lineOf(calc, "liquid").worked).toBe(134); // 133.33 gal of tack
    expect(lineOf(calc, "mill")).toMatchObject({ quantity: 1333.333, price: 6, total: 8000 });
    expect(calc.profitDays).toBe(3);
  });

  it("matches the first sheet's $59,390 to the penny with its typed-over amounts", () => {
    const calc = calculate(DEFAULT_SETUP, { ...SHEET_1, values: { ...SHEET_1.values, stone8: 0 } }, { stone21a: 13, top: 150 });
    expect(calc).toMatchObject({ materials: 15_390, work: 23_000, cost: 38_390, profit: 21_000, total: 59_390 });
    expect(calc.perSqft).toBeCloseTo(4.949, 3);
  });

  it("matches the second sheet's $63,802, with no profit line", () => {
    const calc = calculate(SHEET_2_SETUP, SHEET_2, { liquid: 526, stone21a: 578, stone68: 24, top: 146 });
    expect(calc.sqyd).toBe(1310.667);
    expect(calc.lines.filter((l) => l.total > 0).map((l) => [l.item.id, l.worked])).toEqual([
      ["top", 145], // 144.17 tons; he bought 146
      ["stone21a", 577], // 576.69
      ["stone68", 23], // 22.94
      ["liquid", 525], // 524.27 gal
      ["fullCrew", 4],
    ]);
    expect(calc).toMatchObject({ materials: 31_802, work: 32_000, profit: 0, total: 63_802 });
  });

  it("takes profit as a percent of the cost, and adds waste before rounding up", () => {
    const pct = calculate(DEFAULT_SETUP, { ...SHEET_1, values: { ...SHEET_1.values, stone8: 0 }, profit: { by: "percent", amount: 20 } }, { stone21a: 13, top: 150 });
    expect(pct).toMatchObject({ cost: 38_390, profit: 7678, total: 46_068 });
    expect(lineOf(calculate({ ...DEFAULT_SETUP, waste: 5 }, SHEET_1), "top").worked).toBe(154); // 146.67 × 1.05
  });

  it("hauls every ton of material, charges mobilization once, and brings a small job up to the minimum", () => {
    const priced: CalcSetup = { ...DEFAULT_SETUP, minimum: 2500, items: DEFAULT_SETUP.items.map((i) => (i.id === "trucking" ? { ...i, price: 9 } : i.id === "mobilization" ? { ...i, price: 450 } : i)) };
    const fresh = newInput(priced);
    // Priced, they're on for a new job; unpriced (the standard setup), they're off.
    expect(fresh.values).toMatchObject({ trucking: 1, mobilization: 1 });
    expect(fresh.minimum).toBe(2500);
    expect(newInput(DEFAULT_SETUP).values.trucking).toBeUndefined();

    // 150 tons of top coat (typed over) and 587 of base stone, trucked: 737 tons × $9.
    const calc = calculate(priced, { ...SHEET_1, values: { ...SHEET_1.values, stone8: 0, trucking: 1, mobilization: 1 }, minimum: 2500 }, { top: 150 });
    expect(lineOf(calc, "trucking")).toMatchObject({ quantity: 737, total: 6633 });
    expect(lineOf(calc, "mobilization")).toMatchObject({ quantity: 1, total: 450 });
    expect(calc.toMinimum).toBe(0);
    expect(scopeText(calc)).not.toMatch(/Trucking|Mobilization/);

    // A 600 sq ft patch with a half day comes up to $2,500; a job with nothing priced stays at $0.
    const patch = calculate(priced, { ...newInput(priced), sqft: 600, values: { top: 2, halfCrew: 0.1 }, profit: { by: "none", amount: 0 } });
    expect(patch).toMatchObject({ cost: 1050, toMinimum: 1450, total: 2500 });
    expect(calculate(priced, { ...newInput(priced), values: {} }).total).toBe(0);
  });

  it("drops a typed-over amount once what it was worked out from changes", () => {
    const before = calculate(DEFAULT_SETUP, SHEET_1);
    const after = calculate(DEFAULT_SETUP, { ...SHEET_1, values: { ...SHEET_1.values, top: 3 } });
    expect(keptOverrides(before, after, { top: 150, stone21a: 13 })).toEqual({ stone21a: 13 });
  });

  it("starts a job type over from its own depths, keeping the days", () => {
    const next = applyJob(DEFAULT_SETUP, SHEET_1, "chip");
    expect(next.job).toBe("chip");
    expect(next.values).toMatchObject({ liquid: 0.4, stone8: 35, top: 0, mill: 0, stone21a: 0, fullCrew: 3 });
    expect(jobFrom(SHEET_1, "Big lot", "big").values).toEqual({ mill: 2, top: 2, stone21a: 8, stone8: 35, fullCrew: 3 });
  });

  it("keeps prices for every job by item, and only the prices", () => {
    const changed: CalcSetup = {
      ...DEFAULT_SETUP,
      profit: { by: "day", amount: 7500 },
      items: DEFAULT_SETUP.items.map((i) => (i.id === "top" ? { ...i, price: 110, name: "Renamed" } : i.id === "mill" ? { ...i, choices: i.choices!.map((c) => (c.value === 3 ? { ...c, price: 7.5 } : c)) } : i)),
    };
    expect(pricesDiffer(DEFAULT_SETUP, changed)).toBe(true);
    const kept = withPrices(DEFAULT_SETUP, changed);
    expect(kept.items.find((i) => i.id === "top")).toMatchObject({ price: 110, name: "Top coat asphalt" });
    expect(kept.items.find((i) => i.id === "mill")!.choices!.find((c) => c.value === 3)!.price).toBe(7.5);
    expect(kept.profit.amount).toBe(7500);
    expect(pricesDiffer(kept, changed)).toBe(false);
  });

  it("reads a saved setup, dropping what isn't one", () => {
    expect(parseSetup(null)).toEqual(DEFAULT_SETUP);
    const setup = parseSetup({
      items: [
        { id: "seal", name: " Sealcoat ", section: "Seal", basis: "area_sqft", price: 0.18 },
        { id: "seal", name: "Twice", section: "Seal", basis: "count", price: 1 },
        { id: "bad", name: "Bad", basis: "by magic", price: 5 },
        { id: "rock", name: "Crusher run", section: "Stone", basis: "depth", price: -3, weight: "heavy", choices: [{ label: "4 in", value: 4 }, { value: -1 }] },
      ],
      jobs: [{ id: "seal", name: "Seal it", values: { seal: 1, junk: "x" } }],
      profit: { by: "percent", amount: 18 },
      waste: 500,
    });
    expect(setup.items).toEqual([
      { id: "seal", name: "Sealcoat", section: "Seal", basis: "area_sqft", price: 0.18 },
      { id: "rock", name: "Crusher run", section: "Stone", basis: "depth", price: 0, weight: 110, choices: [{ label: "4 in", value: 4 }] },
    ]);
    expect(setup.jobs).toEqual([{ id: "seal", name: "Seal it", values: { seal: 1 } }]);
    expect(setup.profit).toEqual({ by: "percent", amount: 18 });
    expect(setup.waste).toBe(100);
  });

  it("reads back a worksheet as it was saved", () => {
    const data = { v: 1 as const, setup: SHEET_2_SETUP, input: SHEET_2, overrides: { top: 146 } };
    expect(parseWorksheet(JSON.parse(JSON.stringify(data)))).toEqual(data);
    expect(parseWorksheet({ v: 2 })).toBeNull();
  });

  it("describes the job for the client without prices, days or profit", () => {
    const calc = calculate(DEFAULT_SETUP, { ...SHEET_1, values: { ...SHEET_1.values, stone8: 0, liquid: 0.1, sawCut: 120 } }, { stone21a: 13 });
    expect(scopeText(calc)).toBe('12,000 sq ft (1,333 sq yd). Top coat asphalt, 2" deep: 147 tons. Base stone (21A): 13 tons. Liquid asphalt (CRS-2): 134 gal. Milling (2"). Saw cutting: 120 ft.');
  });
});
