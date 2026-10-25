import type { Section } from "@crewtavo/core/geo";
import { lineChanges, snapshotLines, SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import type { LineMaterials } from "@crewtavo/core/materials";
import { optionTotals, quoteTotals } from "@crewtavo/core/money";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { takeoffVariables, type TakeoffRow } from "../src/features/paving/data";
import { editKey, estimateKey, refreshEstimateAfterEdits } from "../src/features/roofing/estimate/data";
import {
  baseFormula,
  baseName,
  changeLabel,
  changesTotal,
  countLabel,
  countNoun,
  counts,
  destinationText,
  estimateFigures,
  estimateRows,
  isPendingLine,
  lessOf,
  lineDestination,
  lineDetail,
  lineKind,
  measuredInto,
  measuredWhat,
  moreOf,
  nothingToMeasure,
  ownServices,
  packageServices,
  quickAddPrice,
  rangePosition,
  removedLine,
  searchServices,
  serviceDetail,
  signedMoney,
  threadItems,
  unitPricePhrase,
  whenText,
  withLines,
  withSavedLine,
} from "../src/features/roofing/estimate/rows";
import type { EstimateLine, EstimateService } from "../src/features/roofing/estimate/types";

let n = 0;
const line = (patch: Partial<EstimateLine>): EstimateLine => ({
  id: `l${++n}`,
  option_id: null,
  service_id: `s${n}`,
  name: "Line",
  description: null,
  quantity: 1,
  unit: "ea",
  unit_price: 0,
  unit_cost: null,
  taxable: true,
  optional: false,
  selected: true,
  option_group: null,
  formula: null,
  sort: n,
  materials: null,
  material_cost: null,
  ...patch,
});

const service = (patch: Partial<EstimateService>): EstimateService => ({ id: "svc", name: "Service", unit: "ea", unit_price: 0, unit_cost: null, taxable: true, formula: null, formula_target: "quantity", category: null, ...patch });

// The Whitfield roof: shingles, a tear-off, drip edge, ridge cap, three pipe boots and a dumpster.
const shingles = line({ id: "shingles", name: "Architectural shingle roof", formula: "squares", unit: "square", quantity: 24.2, unit_price: 560, unit_cost: 330, sort: 1 });
const tearoff = line({ id: "tearoff", name: "Tear-off and disposal", formula: "roof_squares", unit: "square", quantity: 22, unit_price: 85, unit_cost: 45, sort: 2 });
const drip = line({ id: "drip", name: "Drip edge", formula: "eave_ft + rake_ft", unit: "ft", quantity: 210, unit_price: 3.5, unit_cost: 1.6, sort: 3 });
const ridge = line({ id: "ridge", name: "Ridge cap", formula: "ridge_ft + hip_ft", unit: "ft", quantity: 64, unit_price: 9, unit_cost: 4.5, sort: 4 });
const boots = line({ id: "boots", name: "Pipe boot", unit: "ea", quantity: 3, unit_price: 45, unit_cost: 15, sort: 5 });
const dumpster = line({ id: "dumpster", name: "Dumpster", unit: "ea", quantity: 1, unit_price: 450, unit_cost: 325, sort: 6 });
const whitfield = [shingles, tearoff, drip, ridge, boots, dumpster];

describe("what kind of line it is", () => {
  it("tells the roof, the tear-off, measured lines, counts and the site price apart", () => {
    expect(lineKind(shingles)).toBe("roof");
    expect(lineKind(tearoff)).toBe("layers");
    expect(lineKind({ ...tearoff, formula: "(roof_squares) * 2", name: "Tear-off and disposal (2 layers)" })).toBe("layers");
    expect(lineKind(drip)).toBe("measured");
    expect(lineKind(line({ name: "Two stories or higher", formula: "roof_squares" }))).toBe("measured");
    expect(lineKind(line({ name: "Gutters off and back on", formula: "eave_ft" }))).toBe("measured");
    expect(lineKind(boots)).toBe("count");
    expect(lineKind(line({ name: SITE_ADJUSTMENT_NAME, service_id: null, formula: null }))).toBe("adjustment");
    // A line someone typed called "Price adjustment" that's from the price list is a count.
    expect(lineKind(line({ name: SITE_ADJUSTMENT_NAME }))).toBe("count");
    // One still saving waits before − and + work on it.
    expect(isPendingLine({ id: "pending:drip" })).toBe(true);
    expect(isPendingLine(drip)).toBe(false);
  });

  it("reads a tear-off's own formula and name back from its layers", () => {
    expect(baseFormula("(roof_squares) * 2")).toBe("roof_squares");
    expect(baseFormula("roof_squares")).toBe("roof_squares");
    expect(baseName("Tear-off and disposal (2 layers)")).toBe("Tear-off and disposal");
    expect(baseName("Tear-off and disposal")).toBe("Tear-off and disposal");
  });

  it("decides what − and + do", () => {
    expect(moreOf(boots)).toEqual({ op: "quantity", quantity: 4 });
    expect(lessOf(boots)).toEqual({ op: "quantity", quantity: 2 });
    expect(lessOf(dumpster)).toEqual({ op: "delete" });
    expect(lessOf({ ...boots, quantity: 0.5 })).toEqual({ op: "delete" });
    expect(moreOf({ ...boots, quantity: 2.5 })).toEqual({ op: "quantity", quantity: 3.5 });
    expect(moreOf(tearoff)).toEqual({ op: "layers", layers: 2 });
    expect(lessOf(tearoff)).toEqual({ op: "delete" });
    expect(lessOf({ ...tearoff, formula: "(roof_squares) * 2" })).toEqual({ op: "layers", layers: 1 });
    expect(moreOf({ ...tearoff, formula: "(roof_squares) * 3" })).toBeNull();
    expect(lessOf(drip)).toEqual({ op: "delete" });
    expect(moreOf(drip)).toBeNull();
    expect(lessOf(shingles)).toBeNull();
    expect(moreOf(shingles)).toBeNull();
  });
});

describe("the words beside a line", () => {
  it("counts the thing a line is for", () => {
    expect(countLabel(3, "Pipe boot", "ea")).toBe("3 boots");
    expect(countLabel(1, "Pipe boot", "ea")).toBe("1 boot");
    expect(countLabel(1, "Chimney flashing", "ea")).toBe("1 chimney");
    expect(countLabel(2, "Chimney flashing", "ea")).toBe("2 chimneys");
    expect(countLabel(6, "Rotten decking", "sheet")).toBe("6 sheets");
    expect(countLabel(2, "Satellite dish off and back", "ea")).toBe("2 dishes");
    expect(countLabel(8, "Solar panels off and back", "panel")).toBe("8 panels");
    expect(countLabel(4, "Box vent", "ea")).toBe("4 vents");
    expect(countLabel(1, "Dumpster", "ea")).toBe("1 dumpster");
    expect(countLabel(1, "Building permit", "ea")).toBe("1 permit");
    expect(countLabel(2, "Low-slope section", "square")).toBe("2 squares");
    expect(countLabel(2.5, "Low-slope section", "square")).toBe("2.5 squares");
    expect(countLabel(120, "Fascia repair", "ft")).toBe("120 ft");
    expect(countLabel(2, "Labor", "ea")).toBe("2");
    expect(countNoun("Reflash a skylight", "ea")).toEqual(["skylight", "skylights"]);
    expect(countNoun("Gutter guards", "ft")).toBeNull();
  });

  it("prices one in plain words", () => {
    expect(unitPricePhrase(560, "square")).toBe("$560 a square");
    expect(unitPricePhrase(3.5, "ft")).toBe("$3.50 a foot");
    expect(unitPricePhrase(45, "ea")).toBe("$45 each");
    expect(unitPricePhrase(650, "lump sum")).toBe("$650 each");
    expect(unitPricePhrase(95, "sheet")).toBe("$95 a sheet");
    expect(unitPricePhrase(9, "sq ft")).toBe("$9 a sq ft");
    expect(unitPricePhrase(60, "hour")).toBe("$60 an hour");
    expect(unitPricePhrase(250, "panel")).toBe("$250 a panel");
  });

  it("says what a measured line measures", () => {
    expect(measuredWhat("eave_ft + rake_ft")).toBe("eaves and rakes");
    expect(measuredWhat("rake_ft+eave_ft")).toBe("eaves and rakes");
    expect(measuredWhat("ridge_ft + hip_ft")).toBe("ridges and hips");
    expect(measuredWhat("ridge_ft")).toBe("ridge");
    expect(measuredWhat("eave_ft + valley_ft")).toBe("eaves and valleys");
    expect(measuredWhat("(valley_ft) * 2")).toBe("valleys");
    expect(measuredWhat("squares")).toBeNull();
    expect(measuredWhat(null)).toBeNull();
    expect(nothingToMeasure("Ridge vent", "ridge_ft")).toBe("This roof has nothing to measure Ridge vent from. Mark the ridge on the map first, then add it.");
    expect(nothingToMeasure("Steep roof charge", "steep_squares")).toMatch(/steep parts of the roof \(8\/12 and up\), and this roof has none/);
    expect(nothingToMeasure("Gutters", "length_ft")).toMatch(/Measure it on the map first/);
  });

  it("describes each kind of line", () => {
    expect(lineDetail(shingles, 10)).toBe("24.2 squares with 10% waste · $560 a square");
    expect(lineDetail(tearoff)).toBe("22.0 squares · $85 a square");
    expect(lineDetail({ ...tearoff, formula: "(roof_squares) * 2", quantity: 44 })).toBe("22.0 squares · $85 a square for each layer");
    expect(lineDetail(drip)).toBe("210 ft of eaves and rakes · $3.50 a foot");
    expect(lineDetail(ridge)).toBe("64 ft of ridges and hips · $9 a foot");
    expect(lineDetail(boots)).toBe("$45 each");
    expect(lineDetail(line({ name: "Building permit", description: "City of Columbus", unit_price: 250 }))).toBe("City of Columbus · $250 each");
    expect(lineDetail(line({ name: "Rotten decking", unit: "sheet", unit_price: 95 }))).toBe("$95 a sheet");
    expect(lineDetail(line({ name: SITE_ADJUSTMENT_NAME, service_id: null, description: "Extra flashing at the dormer" }))).toBe("Extra flashing at the dormer");
    expect(lineDetail(line({ name: SITE_ADJUSTMENT_NAME, service_id: null }))).toBe("Set on site");
  });
});

describe("the rows", () => {
  it("puts measured lines under the roof and counts under everything else, in order", () => {
    const { roof, other } = estimateRows([dumpster, boots, ridge, drip, tearoff, shingles], { wastePct: 10 });
    expect(roof.map((r) => r.key)).toEqual(["shingles", "tearoff", "drip", "ridge"]);
    expect(other.map((r) => r.key)).toEqual(["boots", "dumpster"]);
    expect(roof[0]!.detail).toBe("24.2 squares with 10% waste · $560 a square");
    expect(roof[1]!.quantity).toBe("1 layer");
    expect(other[0]!.quantity).toBe("3 boots");
    expect(other[0]!.amount).toBe(135);
    expect(other[0]!.lessLabel).toBe("One fewer boot");
    expect(other[0]!.moreLabel).toBe("One more boot");
    expect(other[1]!.lessLabel).toBe("Take Dumpster off");
    expect(roof[2]!.lessLabel).toBe("Take Drip edge off");
    expect(roof.every((r) => r.tag === null)).toBe(true);
  });

  it("leaves out choices the client didn't pick and keeps the site price last", () => {
    const better = line({ id: "better", name: "Designer shingle roof", formula: "squares", unit: "square", optional: true, selected: true, option_group: "Roof", sort: 1 });
    const good = line({ id: "good", name: "Architectural shingle roof", formula: "squares", unit: "square", optional: true, selected: false, option_group: "Roof", sort: 2 });
    const extra = line({ id: "extra", name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: 220, sort: 0 });
    const { roof, other } = estimateRows([better, good, extra, boots]);
    expect(roof.map((r) => r.key)).toEqual(["better"]);
    expect(other.map((r) => r.key)).toEqual(["boots", "extra"]);
    expect(other[1]!.kind).toBe("adjustment");
    expect(other[1]!.less).toBeNull();
  });

  it("shows a price set below the estimate on an option as one row, though it's booked as a taxed and an untaxed line", () => {
    const taxed = line({ id: "taxed", option_id: "o1", name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: -952.38, sort: 8 });
    const untaxed = line({ id: "untaxed", option_id: "o1", name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: -47.62, taxable: false, sort: 9 });
    const { other } = estimateRows([{ ...boots, option_id: null }, taxed, untaxed], { optionId: "o1" });
    expect(other.map((r) => [r.key, r.kind, r.amount])).toEqual([["boots", "count", 135], ["taxed", "adjustment", -1000]]);
  });

  it("tags what changed since the range, and puts a line taken off back where it was", () => {
    const range = snapshotLines(whitfield);
    const chimney = line({ id: "chimney", name: "Chimney flashing", unit: "ea", quantity: 1, unit_price: 650, sort: 7 });
    const now = [shingles, tearoff, ridge, { ...boots, quantity: 4 }, dumpster, chimney];
    const changes = lineChanges(range, now);
    const { roof, other } = estimateRows(now, { changes, rangeLines: range });
    expect(roof.map((r) => [r.key, r.tag])).toEqual([
      ["shingles", null],
      ["tearoff", null],
      ["removed:drip", "removed"],
      ["ridge", null],
    ]);
    const gone = roof[2]!;
    expect(gone.line).toBeNull();
    expect(gone.removed?.name).toBe("Drip edge");
    expect(gone.amount).toBe(735);
    expect(gone.less).toBeNull();
    expect(other.map((r) => [r.key, r.tag])).toEqual([
      ["boots", "changed"],
      ["dumpster", null],
      ["chimney", "added"],
    ]);
  });

  it("puts a line taken off before the first one when nothing comes before it", () => {
    const range = snapshotLines(whitfield);
    const changes = lineChanges(range, [tearoff, drip, ridge, boots, dumpster]);
    const { roof } = estimateRows([tearoff, drip, ridge, boots, dumpster], { changes, rangeLines: range });
    expect(roof.map((r) => r.key)).toEqual(["removed:shingles", "tearoff", "drip", "ridge"]);
  });

  it("shows this screen's own changes when there's no range", () => {
    const taken = removedLine(drip);
    const { roof, other } = estimateRows([shingles, tearoff, ridge, boots], { removed: [taken], added: ["boots"], changed: ["tearoff"] });
    expect(roof.map((r) => [r.key, r.tag])).toEqual([
      ["shingles", null],
      ["tearoff", "changed"],
      ["removed:drip", "removed"],
      ["ridge", null],
    ]);
    expect(other[0]!.tag).toBe("added");
    // Once it's back on (put back), it isn't shown twice.
    expect(estimateRows([shingles, drip], { removed: [taken] }).roof.map((r) => r.key)).toEqual(["shingles", "drip"]);
  });

  it("works out the totals the way the database will", () => {
    const quote = { lines: whitfield, tax_rate: 0.07, discount_amount: 0, promo_code_id: null, subtotal: 0, tax_amount: 0, total: 0 };
    const after = withLines(quote, [...whitfield.slice(0, 4), { ...boots, quantity: 4 }, dumpster]);
    expect(after.subtotal).toBe(13552 + 1870 + 735 + 576 + 180 + 450);
    expect(after.tax_amount).toBe(Math.round(after.subtotal * 0.07 * 100) / 100);
    expect(after.total).toBe(Math.round((after.subtotal + after.tax_amount) * 100) / 100);
    // A promo code's discount comes from the database: the totals wait for it.
    expect(withLines({ ...quote, promo_code_id: "p1", subtotal: 5 }, []).subtotal).toBe(5);
  });
});

const area = (value: number, pitch?: string): Section => ({ feature_id: `a${value}`, label: "Roof", kind: "Area", value, unit: "sq ft", manual_override: false, pitch });
const edge = (value: number, kind: NonNullable<Section["edge"]>): Section => ({ feature_id: `${kind}${value}`, label: kind, kind: "Length", value, unit: "ft", manual_override: false, edge: kind });
const takeoff: TakeoffRow = {
  id: "m1", title: "Whitfield roof", sections: [area(2000, "6/12"), edge(132, "eave"), edge(78, "rake"), edge(48, "ridge")], total_area_sqft: 2000, total_area_sqyd: 0,
  total_length_ft: 0, roof_pitch: "6/12", waste_pct: 10, roofing_squares: 24.6, snapshot_path: null, show_on_quote: false, updated_at: "2026-10-22T12:00:00Z",
};

describe("adding to the estimate", () => {
  it("prices a quick add for this roof, or for one", () => {
    const vars = takeoffVariables(takeoff, null);
    expect(quickAddPrice(service({ name: "Ridge vent", formula: "ridge_ft", unit: "ft", unit_price: 9 }), vars)).toBe("$432");
    expect(quickAddPrice(service({ name: "Ice and water shield", formula: "eave_ft + valley_ft", unit: "ft", unit_price: 4 }), vars)).toBe("$528");
    // Nothing to measure it from yet: its price for one.
    expect(quickAddPrice(service({ name: "Valley flashing", formula: "valley_ft", unit: "ft", unit_price: 8 }), vars)).toBe("$8 a foot");
    expect(quickAddPrice(service({ name: "Ridge vent", formula: "ridge_ft", unit: "ft", unit_price: 9 }), null)).toBe("$9 a foot");
    expect(quickAddPrice(service({ name: "Chimney flashing", unit: "ea", unit_price: 650 }))).toBe("$650");
    expect(quickAddPrice(service({ name: "Rotten decking", unit: "sheet", unit_price: 95 }))).toBe("$95 a sheet");
    expect(serviceDetail(service({ formula: "ridge_ft", unit: "ft", unit_price: 9 }))).toBe("$9 a foot · measured from the roof");
  });

  it("finds services by what's typed, names starting with it first", () => {
    const list = [
      service({ id: "1", name: "Chimney flashing", category: "Edges and flashing" }),
      service({ id: "2", name: "Valley flashing", category: "Edges and flashing" }),
      service({ id: "3", name: "Flashing tape", category: null }),
      service({ id: "4", name: "Rotten decking", category: "Roof extras" }),
    ];
    expect(searchServices(list, "flash").map((s) => s.id)).toEqual(["3", "1", "2"]);
    expect(searchServices(list, "roof extras").map((s) => s.id)).toEqual(["4"]);
    expect(searchServices(list, "chim flash").map((s) => s.id)).toEqual(["1"]);
    expect(searchServices(list, "  ").map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
    expect(searchServices(list, "skylight")).toEqual([]);
  });
});

describe("a line just saved", () => {
  it("takes the amount the roof gave it, as a quantity or a price", () => {
    const vent = line({ name: "Ridge vent", formula: "ridge_ft", unit: "ft", quantity: 0, unit_price: 9 });
    expect(measuredInto(vent, { field: "quantity", value: 42 }).quantity).toBe(42);
    expect(measuredInto(line({ formula: "steep_squares * 25", quantity: 1, unit_price: 0 }), { field: "unit_price", value: 112.505 }).unit_price).toBe(112.51);
    // Nothing measured (a put-back line the roof couldn't work out) keeps what it had.
    expect(measuredInto(vent, { field: "quantity" })).toBe(vent);
    expect(measuredInto(vent, null)).toBe(vent);
  });

  it("shows a measured quick add as soon as it's saved, so a second tap finds it", () => {
    const boots = line({ id: "boots", sort: 1 });
    const dumpster = line({ id: "dumpster", sort: 3 });
    const vent = line({ id: "vent-1", name: "Ridge vent", formula: "ridge_ft", quantity: 42, sort: 2 });
    expect(withSavedLine([boots, dumpster], vent, null).map((l) => l.id)).toEqual(["boots", "vent-1", "dumpster"]);
    // Loaded again already: not twice.
    expect(withSavedLine([boots, vent, dumpster], vent, null).map((l) => l.id)).toEqual(["boots", "vent-1", "dumpster"]);
  });

  it("swaps the line shown while saving for the saved one", () => {
    const boots = line({ id: "boots", sort: 1 });
    const pending = line({ id: "pending:svc-chimney", name: "Chimney flashing", sort: 2 });
    const saved = { ...pending, id: "chimney-1" };
    expect(withSavedLine([boots, pending], saved, pending.id).map((l) => l.id)).toEqual(["boots", "chimney-1"]);
  });
});

describe("loading the estimate again while − and + save", () => {
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let loads = 0;
    const observer = new QueryObserver(client, { queryKey: estimateKey("q1"), queryFn: async () => ++loads });
    const unsubscribe = observer.subscribe(() => {});
    return { client, loads: () => loads, unsubscribe };
  };

  it("waits for the taps still saving instead of bringing back an old quantity", async () => {
    const { client, loads, unsubscribe } = setup();
    await client.refetchQueries({ queryKey: estimateKey("q1") });
    const before = loads();
    let finish = () => {};
    const saved = new Promise<void>((resolve) => (finish = resolve));
    const tap = new MutationObserver(client, { mutationKey: editKey("q1"), mutationFn: () => saved });
    const saving = tap.mutate();
    expect(refreshEstimateAfterEdits(client, "q1", "c1")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads()).toBe(before);
    // Marked out of date, so whatever loads it next (the editor, once the taps have saved) does.
    expect(client.getQueryState(estimateKey("q1"))?.isInvalidated).toBe(true);
    finish();
    await saving;
    unsubscribe();
  });

  it("loads it straight away when nothing is saving", async () => {
    const { client, loads, unsubscribe } = setup();
    await client.refetchQueries({ queryKey: estimateKey("q1") });
    const before = loads();
    expect(refreshEstimateAfterEdits(client, "q1", "c1")).toBe(true);
    await client.getQueryCache().find({ queryKey: estimateKey("q1") })?.promise;
    expect(loads()).toBe(before + 1);
    unsubscribe();
  });
});

describe("what changed and the range", () => {
  it("says what changed in a line, with the amount", () => {
    expect(changeLabel({ kind: "added", name: "Chimney flashing", unit: "ea", to: 1 })).toBe("Chimney flashing, 1 chimney");
    expect(changeLabel({ kind: "changed", name: "Rotten decking", unit: "sheet", to: 6 })).toBe("Rotten decking, 6 sheets");
    expect(changeLabel({ kind: "changed", name: "Tear-off and disposal (2 layers)", unit: "square", to: 44 })).toBe("Tear-off and disposal (2 layers)");
    expect(changeLabel({ kind: "removed", name: "Valley flashing", unit: "ft", to: null })).toBe("Valley flashing");
    expect(signedMoney(650)).toBe("$650");
    expect(signedMoney(-304)).toBe("−$304");
    expect(signedMoney(-3.5)).toBe("−$3.50");
    expect(changesTotal([{ amount: 650 }, { amount: 570 }, { amount: -304.1 }])).toBe(915.9);
  });

  it("places a price on the range", () => {
    expect(rangePosition(18300, 21050, 19524)).toEqual({ at: (19524 - 18300) / 2750, where: "inside", over: 0 });
    expect(rangePosition(18300, 21050, 18300)).toEqual({ at: 0, where: "inside", over: 0 });
    expect(rangePosition(18300, 21050, 21050)).toEqual({ at: 1, where: "inside", over: 0 });
    expect(rangePosition(18300, 21050, 21500.5)).toEqual({ at: 1, where: "above", over: 450.5 });
    expect(rangePosition(18300, 21050, 17000)).toEqual({ at: 0, where: "below", over: 0 });
    expect(rangePosition(500, 500, 500).at).toBe(0.5);
  });
});

describe("the office's numbers", () => {
  const priced = (cost: number, unpriced = false): LineMaterials => ({
    supplier: "abc_supply", branch: "123", branch_name: "ABC Supply - Columbus, OH", priced_at: "2026-10-22T13:12:00Z", line_quantity: 24.2,
    items: [{ item_number: "1", name: "Shingles", uom: "BD", uom_name: "Bundle", per_unit: 3, length_ft: null, quantity: 73, unit_price: unpriced ? null : cost / 73, total: unpriced ? null : cost, note: null }],
  });

  it("works out the cost, profit and margin", () => {
    const quote = { subtotal: 13552 + 135, discount_amount: 0, lines: [{ ...shingles, materials: priced(5000), material_cost: 5000 }, boots] };
    const f = estimateFigures(quote)!;
    expect(f.materials).toBe(5000);
    expect(f.materialsPartial).toBe(false);
    expect(f.cost).toBe(7986 + 45);
    expect(f.costPartial).toBe(false);
    expect(f.price).toBe(13687);
    expect(f.profit).toBe(13687 - (7986 + 45));
    expect(f.margin).toBe(Math.round(((13687 - 8031) / 13687) * 100));
    expect(f.pricedAt).toBe("2026-10-22T13:12:00Z");
  });

  it("takes a discount off the price, leaves the site price out of the cost and flags what's missing", () => {
    const extra = line({ name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: 300 });
    const noCost = line({ name: "Building permit", unit_price: 250, unit_cost: null });
    const f = estimateFigures({ subtotal: 1000, discount_amount: 100, lines: [{ ...dumpster, materials: priced(0, true), material_cost: 0 }, extra, noCost] })!;
    expect(f.price).toBe(900);
    expect(f.cost).toBe(325);
    expect(f.costPartial).toBe(true);
    expect(f.materialsPartial).toBe(true);
    expect(f.margin).toBe(64);
  });

  it("shows nothing when no cost is known", () => {
    expect(estimateFigures({ subtotal: 500, discount_amount: 0, lines: [line({ unit_price: 500 })] })).toBeNull();
    expect(estimateFigures({ subtotal: 0, discount_amount: 0, lines: [] })).toBeNull();
  });
});

describe("an estimate that offers options", () => {
  // Good is shown: its roof is selected. Better's and Best's are kept unselected by the database,
  // and Better's ridge vent is an add-on nobody picked. The tear-off, drip edge, boots and dumpster are on every option.
  const good = line({ id: "good", option_id: "o-good", name: "Architectural shingle roof", formula: "squares", unit: "square", quantity: 24.2, unit_price: 560, unit_cost: 330, sort: 1 });
  const better = line({ id: "better", option_id: "o-better", name: "Designer shingle roof", formula: "squares", unit: "square", quantity: 24.2, unit_price: 690, unit_cost: 410, selected: false, sort: 1 });
  const vent = line({ id: "vent", option_id: "o-better", name: "Ridge vent", unit: "ea", quantity: 1, unit_price: 380, unit_cost: 150, optional: true, selected: false, sort: 7 });
  const best = line({ id: "best", option_id: "o-best", name: "Standing-seam metal roof", formula: "squares", unit: "square", quantity: 24.2, unit_price: 1150, unit_cost: 700, selected: false, sort: 1 });
  const lines = [good, better, vent, best, tearoff, drip, boots, dumpster];
  const opts = { taxRate: 0.07, discountAmount: 250, promo: null };
  // What the database has with Good shown: only Good's lines and the shared ones are selected.
  const shown = quoteTotals(lines, opts);
  const quote = { option_id: "o-good", subtotal: shown.subtotal, discount_amount: 250, tax_rate: 0.07, promo: null, lines };

  it("counts the shared lines on every option, and an option's own lines only on it", () => {
    expect(counts(tearoff, "o-better")).toBe(true);
    // Better's roof isn't selected while Good is shown, but it's what Better is made of.
    expect(counts(better, "o-better")).toBe(true);
    expect(counts(better, "o-good")).toBe(false);
    expect(counts(vent, "o-better")).toBe(false);
    expect(counts(good, null)).toBe(false);
  });

  it("lists the option looked at with the shared lines, and keeps another option's lines taken off to it", () => {
    const rows = estimateRows(lines, { optionId: "o-better" });
    expect([...rows.roof, ...rows.other].map((r) => r.key)).toEqual(["better", "tearoff", "drip", "boots", "dumpster"]);
    const takenOff = removedLine(good);
    expect(takenOff.option_id).toBe("o-good");
    expect(estimateRows(lines.filter((l) => l !== good), { optionId: "o-better", removed: [takenOff] }).roof.map((r) => r.key)).toEqual(["better", "tearoff", "drip"]);
    expect(estimateRows(lines.filter((l) => l !== good), { optionId: "o-good", removed: [takenOff] }).roof.map((r) => r.key)).toEqual(["removed:good", "tearoff", "drip"]);
  });

  it("works out the numbers for the option looked at, as the database will price it once shown", () => {
    const f = estimateFigures(quote, "o-better")!;
    const totals = optionTotals(lines, "o-better", "o-good", opts);
    expect(f.price).toBe(totals.subtotal - totals.discount);
    // Better's roof and the shared lines; not the ridge vent nobody picked.
    expect(f.cost).toBe(9922 + 990 + 336 + 45 + 325);
    // The option shown is the quote's own saved totals.
    expect(estimateFigures(quote)!.price).toBe(shown.subtotal - 250);
    expect(estimateFigures(quote, "o-good")!.cost).toBe(7986 + 990 + 336 + 45 + 325);
  });

  it("keeps the totals on screen to the option shown while lines change", () => {
    const after = withLines({ lines, tax_rate: 0.07, discount_amount: 250, promo_code_id: null, subtotal: 0, tax_amount: 0, total: 0 }, lines.map((l) => (l.id === "boots" ? { ...l, quantity: 4 } : l)));
    expect(after.total).toBe(optionTotals(after.lines, "o-good", "o-good", opts).total);
  });

  it("puts a line added on screen on every option, unless it's the option's own service or they choose otherwise", () => {
    const own = packageServices({ roof_service_id: "s-designer", items: [{ service_id: "s-underlayment", kind: "included" }, { service_id: "s-decking", kind: "quick" }] });
    expect([...own].sort()).toEqual(["s-designer", "s-underlayment"]);
    expect(lineDestination(service({ id: "s-decking" }), "o-better", { own })).toBeNull();
    expect(lineDestination(service({ id: "s-underlayment" }), "o-better", { own })).toBe("o-better");
    // Chosen: only on the option looked at. The option's own stays on it whatever's chosen.
    expect(lineDestination(service({ id: "s-decking" }), "o-better", { own, place: "only" })).toBe("o-better");
    expect(lineDestination(service({ id: "s-underlayment" }), "o-better", { own, place: "every" })).toBe("o-better");
    // A roof by the square is the option's own roof, even before its package loads.
    expect(lineDestination(service({ id: "s-metal", name: "Standing-seam metal roof", formula: "squares" }), "o-best")).toBe("o-best");
    expect(lineDestination(service({ id: "s-designer" }), null, { own, place: "only" })).toBeNull();
    expect(lineDestination(null, "o-better", { place: "only" })).toBe("o-better");
    expect(lineDestination(null, "o-better")).toBeNull();
    expect(packageServices(null).size).toBe(0);
    expect(destinationText("o-better", "Better")).toBe("Only on Better");
    expect(destinationText(null, "Better")).toBe("On every option");
  });

  it("never puts a line on every option when another option has its own line of that service", () => {
    // Better's package includes a ridge vent; Good has it as a quick add. On every option, Better would have two.
    const betterVent = line({ id: "better-vent", option_id: "o-better", service_id: "s-vent", name: "Ridge vent", formula: "ridge_ft", unit: "ft", quantity: 48, unit_price: 9, selected: false });
    const quoteLines = [...lines, betterVent];
    const vent = service({ id: "s-vent", name: "Ridge vent", formula: "ridge_ft", unit: "ft", unit_price: 9 });
    expect(lineDestination(vent, "o-good", { lines: quoteLines })).toBe("o-good");
    expect(lineDestination(vent, "o-good", { lines: quoteLines, place: "every" })).toBe("o-good");
    // Even with the option's package not loaded (no own services known).
    expect(lineDestination(vent, "o-good", { own: new Set(), lines: quoteLines })).toBe("o-good");
    // Looking at Better itself, or a service no other option has its own line of: as usual.
    expect(lineDestination(vent, "o-better", { lines: quoteLines })).toBeNull();
    expect(lineDestination(service({ id: "s-skylight", name: "Skylight" }), "o-good", { lines: quoteLines })).toBeNull();
    // A shared line of it doesn't count: that one is on Good already.
    expect(lineDestination(service({ id: dumpster.service_id! }), "o-good", { lines: quoteLines })).toBeNull();
  });

  it("knows an option's own services from its package and the lines it had", () => {
    const pkg = new Set(["s-designer"]);
    const had = [{ option_id: "o-better", service_id: "s-underlayment" }, { option_id: "o-good", service_id: "s-felt" }, { option_id: null, service_id: "s-dumpster" }, { option_id: "o-better", service_id: null }];
    expect([...ownServices(pkg, "o-better", had)].sort()).toEqual(["s-designer", "s-underlayment"]);
    expect(ownServices(pkg, "o-best", had)).toBe(pkg);
    expect(ownServices(pkg, null, had)).toBe(pkg);
    // Taken off on this screen with its package not loaded: put on again, it goes back on Better.
    const taken = removedLine(better);
    expect(lineDestination(service({ id: better.service_id! }), "o-better", { own: ownServices(new Set(), "o-better", [taken]) })).toBe("o-better");
  });

  it("marks the shared lines while one option is looked at, since taking one off takes it off every option", () => {
    const rows = estimateRows(lines, { optionId: "o-better" });
    const all = [...rows.roof, ...rows.other];
    expect(all.filter((r) => r.shared).map((r) => r.key)).toEqual(["tearoff", "drip", "boots", "dumpster"]);
    expect(all.find((r) => r.key === "dumpster")!.lessLabel).toBe("Take Dumpster off every option");
    expect(all.find((r) => r.key === "boots")!.lessLabel).toBe("One fewer boot");
    expect(all.find((r) => r.key === "better")!.shared).toBe(false);
    // Without options nothing is marked.
    expect([...estimateRows(whitfield).roof, ...estimateRows(whitfield).other].some((r) => r.shared)).toBe(false);
    expect(estimateRows(whitfield).other.find((r) => r.key === "dumpster")!.lessLabel).toBe("Take Dumpster off");
  });
});

describe("notes and photos", () => {
  const note = (id: string, at: string, author: string | null = "mike") => ({ id, created_at: at, author_id: author, body: id });
  const photo = (id: string, at: string, author: string | null = "mike") => ({ id, created_at: at, author_id: author, path: `${id}.jpg` });

  it("keeps photos with the note their author wrote around them, newest first", () => {
    const items = threadItems(
      [note("sarah-note", "2026-10-22T14:00:00Z", "sarah"), note("mike-note", "2026-10-24T18:09:00Z")],
      [photo("p1", "2026-10-24T18:01:00Z"), photo("p2", "2026-10-24T18:05:00Z"), photo("p3", "2026-10-24T18:20:00Z"), photo("p4", "2026-10-24T20:00:00Z")],
    );
    expect(items.map((i) => [i.note?.id ?? null, i.photos.map((p) => p.id)])).toEqual([
      [null, ["p4"]],
      ["mike-note", ["p1", "p2", "p3"]],
      ["sarah-note", []],
    ]);
    expect(items[1]!.at).toBe("2026-10-24T18:01:00Z");
  });

  it("starts a new item for another person's note or a second note", () => {
    const items = threadItems([note("a", "2026-10-24T18:00:00Z"), note("b", "2026-10-24T18:01:00Z"), note("c", "2026-10-24T18:02:00Z", "sarah")], [photo("p", "2026-10-24T18:03:00Z")]);
    expect(items.map((i) => [i.note?.id ?? null, i.photos.length])).toEqual([[null, 1], ["c", 0], ["b", 0], ["a", 0]]);
  });

  it("says when, in the business's time zone", () => {
    const now = new Date("2026-10-24T18:30:00Z");
    const plain = (s: string) => s.replace(/ /g, " ");
    expect(plain(whenText("2026-10-24T18:09:00Z", "America/New_York", now))).toBe("today at 2:09 PM");
    expect(plain(whenText("2026-10-23T13:12:00Z", "America/New_York", now))).toBe("yesterday at 9:12 AM");
    expect(plain(whenText("2026-10-22T14:00:00Z", "America/New_York", now))).toBe("Oct 22 at 10:00 AM");
    expect(plain(whenText("2025-12-01T15:00:00Z", "America/New_York", now))).toBe("Dec 1, 2025 at 10:00 AM");
    // 1 AM UTC on the 25th is still the evening of the 24th in New York.
    expect(plain(whenText("2026-10-25T01:00:00Z", "America/New_York", new Date("2026-10-25T02:00:00Z")))).toBe("today at 9:00 PM");
  });
});
