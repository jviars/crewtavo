import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_KINDS,
  PLAN_PRESETS,
  defaultMeter,
  describeInterval,
  dueProgress,
  dueSummary,
  dueTone,
  FormulaError,
  checkCondition,
  describeRuleSentence,
  evaluateConditions,
  renderTemplate,
  validateRule,
  PRESETS,
  evaluateFormula,
  formulaVariables,
  lineLengthM,
  localDate,
  mToFt,
  occurrenceDates,
  orderStops,
  pitchFactor,
  pitchFromDegrees,
  polygonAreaM2,
  ringAreaM2,
  roofingSquares,
  routeLengthM,
  sqmToSqft,
  summarizeFeatureCollection,
  validateFormula,
  weatherRisks,
  zonedTimeToUtc,
} from "../src";

// A ~100 ft x 50 ft rectangle near Radford, VA ([lng, lat]).
const LAT = 37.1318;
const FT_PER_DEG_LAT = 364_000;
const DLAT = 50 / FT_PER_DEG_LAT;
const DLNG = 100 / (FT_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));
const RECT = [
  [-80.5764, LAT],
  [-80.5764 + DLNG, LAT],
  [-80.5764 + DLNG, LAT + DLAT],
  [-80.5764, LAT + DLAT],
  [-80.5764, LAT],
];

describe("geo", () => {
  it("measures a 100 x 50 ft rectangle", () => {
    expect(sqmToSqft(ringAreaM2(RECT))).toBeCloseTo(5000, -2); // within ±50
    expect(Math.abs(sqmToSqft(ringAreaM2(RECT)) - 5000)).toBeLessThan(50);
  });

  it("subtracts holes", () => {
    const inner = RECT.map((p) => [RECT[0][0] + (p[0] - RECT[0][0]) * 0.5, RECT[0][1] + (p[1] - RECT[0][1]) * 0.5]);
    expect(polygonAreaM2([RECT, inner]) / polygonAreaM2([RECT])).toBeCloseTo(0.75, 2);
  });

  it("measures line length", () => {
    expect(Math.abs(mToFt(lineLengthM([RECT[0], RECT[1]])) - 100)).toBeLessThan(1.5);
  });

  it("handles roof pitch", () => {
    expect(pitchFactor("12/12")).toBeCloseTo(Math.SQRT2, 6);
    expect(pitchFactor("7/12")).toBeCloseTo(1.1577, 3);
    expect(pitchFactor(null)).toBe(1);
    expect(pitchFromDegrees(30.26)).toBe("7/12");
    expect(roofingSquares(2000, "6/12", 10)).toBeCloseTo(24.6, 1);
  });

  it("summarizes a drawing", () => {
    const summary = summarizeFeatureCollection({
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "a", properties: { label: "Main drive", depth_in: 4 }, geometry: { type: "Polygon", coordinates: [RECT] } },
        { type: "Feature", id: "b", properties: { label: "Edge" }, geometry: { type: "LineString", coordinates: [RECT[0], RECT[1]] } },
        { type: "Feature", id: "c", properties: { label: "Apron", manual_value: 90 }, geometry: { type: "Polygon", coordinates: [RECT] } },
        { type: "Feature", id: "d", properties: {}, geometry: { type: "Point", coordinates: RECT[0] } },
      ],
    });
    expect(summary.sections.map((s) => s.kind)).toEqual(["Area", "Length", "Area", "Count"]);
    expect(Math.abs(summary.total_area_sqft - 5090)).toBeLessThan(60);
    expect(summary.total_area_sqyd).toBeCloseTo(summary.total_area_sqft / 9, 1);
    expect(summary.sections[2].manual_override).toBe(true);
    expect(summary.count).toBe(1);
  });
});

describe("formulas", () => {
  it("computes asphalt tons", () => {
    expect(evaluateFormula("area_sqyd * depth_in * 110 / 2000", { area_sqyd: 205.6, depth_in: 4 })).toBeCloseTo(45.23, 2);
  });

  it("supports functions and precedence", () => {
    expect(evaluateFormula("max(45, area_sqft / 1000 * 4.5)", { area_sqft: 4000 })).toBe(45);
    expect(evaluateFormula("ceil(2.1)", {})).toBe(3);
    expect(evaluateFormula("-2 ** 2", {})).toBe(-4);
    expect(evaluateFormula("2 ^ 3 + 7 // 2 + 7 % 4", {})).toBe(14);
    expect(evaluateFormula("round(2.5) + round(-2.5) + round(1.234, 2)", {})).toBeCloseTo(1.23, 6);
  });

  it("rejects anything unsafe", () => {
    for (const bad of ["__import__('os')", "area.__class__", "[1, 2]", "'a' * 3", "open('x')", "2 ** 999", "constructor", "1 +", "(1"]) {
      expect(() => evaluateFormula(bad, { area: 1 }), bad).toThrow(FormulaError);
    }
  });

  it("reports unknown and missing values", () => {
    expect(() => evaluateFormula("area_sqft * 2", {})).toThrow(/Unknown value/);
    expect(() => evaluateFormula("depth_in * 2", { depth_in: null })).toThrow(/no value yet/);
    expect(() => evaluateFormula("1 / 0", {})).toThrow(/Division by zero/);
  });

  it("lists the values a formula needs", () => {
    expect(formulaVariables("area_sqft * pitch_factor * (1 + waste) / 100")).toEqual(new Set(["area_sqft", "pitch_factor", "waste"]));
  });
});

describe("presets", () => {
  it.each(Object.values(PRESETS))("$name is consistent", (preset) => {
    const formulaNames = new Set(preset.formulas.map((f) => f.name));
    for (const f of preset.formulas) expect(() => validateFormula(f.formula), f.formula).not.toThrow();
    for (const s of preset.services) if (s.formula_name) expect(formulaNames.has(s.formula_name), s.name).toBe(true);
    for (const form of preset.intake_forms) expect(form.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    expect(preset.sop_categories.length).toBeGreaterThan(0);
  });
});

describe("recurrence", () => {
  const weekly = { starts_on: "2026-04-07", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU" };

  it("lists weekly dates in a window", () => {
    expect(occurrenceDates(weekly, "2026-04-01", "2026-04-30")).toEqual(["2026-04-07", "2026-04-14", "2026-04-21", "2026-04-28"]);
  });

  it("respects the season and end date", () => {
    const seasonal = { ...weekly, active_months: [4], ends_on: "2026-04-20" };
    expect(occurrenceDates(seasonal, "2026-03-01", "2026-06-30")).toEqual(["2026-04-07", "2026-04-14"]);
  });

  it("handles every other week", () => {
    const biweekly = { starts_on: "2026-05-05", recurrence_rule: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU" };
    expect(occurrenceDates(biweekly, "2026-05-01", "2026-06-10")).toEqual(["2026-05-05", "2026-05-19", "2026-06-02"]);
  });

  it("rejects bad rules", () => {
    expect(() => occurrenceDates({ starts_on: "2026-01-01", recurrence_rule: "every tuesday" }, "2026-01-01", "2026-02-01")).toThrow();
  });
});

describe("time zones", () => {
  it("converts local wall time to UTC across daylight saving", () => {
    expect(zonedTimeToUtc("2026-07-01", "07:30", "America/New_York").toISOString()).toBe("2026-07-01T11:30:00.000Z");
    expect(zonedTimeToUtc("2026-12-01", "07:30", "America/New_York").toISOString()).toBe("2026-12-01T12:30:00.000Z");
    expect(localDate(new Date("2026-07-02T02:00:00Z"), "America/New_York")).toBe("2026-07-01");
  });
});

describe("routing", () => {
  it("orders stops to shorten the route", () => {
    const start = { lat: 37.13, lng: -80.57 };
    const stops = [
      { id: "far", lat: 37.2, lng: -80.57 },
      { id: "near", lat: 37.14, lng: -80.57 },
      { id: "mid", lat: 37.17, lng: -80.57 },
    ];
    const ordered = orderStops(start, stops);
    expect(ordered.map((s) => s.id)).toEqual(["near", "mid", "far"]);
    expect(routeLengthM(start, ordered)).toBeLessThanOrEqual(routeLengthM(start, stops));
  });
});

describe("weather rules", () => {
  it("flags cold paving days and sealcoat dry time", () => {
    const outlook = [
      { date: "2026-10-20", temp_min_f: 44, temp_max_f: 61, rain_chance_pct: 10 },
      { date: "2026-10-21", temp_min_f: 52, temp_max_f: 70, rain_chance_pct: 80 },
    ];
    expect(weatherRisks([{ applies_to: "Asphalt", min_temp_f: 50 }], "2026-10-20", outlook)).toEqual([
      "Asphalt: low of 44°F is below 50°F",
    ]);
    expect(weatherRisks([{ requires_dry_hours: 24 }], "2026-10-20", outlook)).toHaveLength(1);
    expect(weatherRisks([{ max_rain_pct: 90 }], "2026-10-21", outlook)).toEqual([]);
  });
});

describe("automations", () => {
  const facts = { status: "sent", amount: 1200, source: "web_form", line_items: ["Driveway sealcoat", "Crack fill"], client: { tags: ["HOA", "Commercial"], status: "active", lead_source: "Google Ads" } };

  it("renders templates and blanks unknown tokens", () => {
    expect(renderTemplate("Hi {{client.first_name}}, quote #{{ number }} is {{total}}.{{missing}}", { client: { first_name: "Ana" }, number: 12, total: "$1,200.00" })).toBe("Hi Ana, quote #12 is $1,200.00.");
  });

  it("checks conditions case-insensitively", () => {
    expect(checkCondition({ field: "client.tags", op: "includes", value: ["hoa"] }, facts)).toBe(true);
    expect(checkCondition({ field: "client.tags", op: "excludes", value: ["Residential"] }, facts)).toBe(true);
    expect(checkCondition({ field: "client.tags", op: "excludes", value: ["commercial"] }, facts)).toBe(false);
    expect(checkCondition({ field: "amount", op: "gte", value: 1000 }, facts)).toBe(true);
    expect(checkCondition({ field: "amount", op: "lte", value: 1000 }, facts)).toBe(false);
    expect(checkCondition({ field: "line_items", op: "contains", value: "sealcoat" }, facts)).toBe(true);
    expect(checkCondition({ field: "source", op: "in", value: ["hub", "web_form"] }, facts)).toBe(true);
    expect(checkCondition({ field: "client.lead_source", op: "contains", value: "google" }, facts)).toBe(true);
    expect(checkCondition({ field: "status", op: "equals", value: "approved" }, facts)).toBe(false);
  });

  it("reports the first failed condition in words", () => {
    const result = evaluateConditions([{ field: "amount", op: "gte", value: 500 }, { field: "status", op: "equals", value: "approved" }], facts, "quote");
    expect(result).toEqual({ pass: false, failed: "Its status is Approved" });
  });

  it("validates rules", () => {
    expect(validateRule({ name: "", trigger: "nope", delay_minutes: 0, conditions: [], actions: [] })).toEqual(["Give the rule a name.", "Choose what starts the rule.", "Add at least one action."]);
    expect(validateRule({ name: "Follow up", trigger: "quote.sent", delay_minutes: 4320, conditions: [{ field: "status", op: "equals", value: "sent" }], actions: [{ type: "send_email", subject: "Hi", body: "There" }] })).toEqual([]);
    expect(validateRule({ name: "x", trigger: "quote.sent", delay_minutes: 0, conditions: [], actions: [{ type: "notify", title: "Hi" }] })).toEqual(["Action 1: choose who to notify."]);
  });

  it("describes a rule as a sentence", () => {
    expect(describeRuleSentence({ trigger: "quote.sent", delay_minutes: 4320, conditions: [{ field: "status", op: "equals", value: "sent" }], actions: [{ type: "send_email", subject: "s", body: "b" }] }))
      .toBe("When a quote is sent, wait 3 days, if its status is Awaiting response: email the client.");
    expect(describeRuleSentence({ trigger: "visit.completed", delay_minutes: 0, conditions: [{ field: "client.tags", op: "includes", value: ["HOA"] }], actions: [{ type: "add_tag", tag: "Serviced 2026" }] }))
      .toBe("When a visit is completed, if client tags include HOA: tag the client “Serviced 2026”.");
  });
});

describe("equipment", () => {
  it("describes schedules in plain words", () => {
    expect(describeInterval({ every_meter: 100, every_count: 1, every_unit: "year" }, "hours")).toBe("Every 100 hours or 1 year");
    expect(describeInterval({ every_count: 1, every_unit: "year" }, "none")).toBe("Every year");
    expect(describeInterval({ every_count: 6, every_unit: "month" }, "miles")).toBe("Every 6 months");
    expect(describeInterval({ every_meter: 5000 }, "miles")).toBe("Every 5,000 miles");
    // A machine without a meter ignores an hours interval.
    expect(describeInterval({ every_meter: 50 }, "none")).toBe("No schedule");
  });

  it("says when maintenance is due", () => {
    expect(dueSummary({ state: "overdue", days_left: -3, meter_left: null, meter: "none" })).toBe("3 days overdue");
    expect(dueSummary({ state: "overdue", days_left: 40, meter_left: -12.5, meter: "hours" })).toBe("12.5 hours over");
    expect(dueSummary({ state: "overdue", days_left: 40, meter_left: 0, meter: "hours" })).toBe("Due now");
    expect(dueSummary({ state: "due_soon", days_left: 0, meter_left: null, meter: "none" })).toBe("Due today");
    expect(dueSummary({ state: "due_soon", days_left: 120, meter_left: 8, meter: "hours" })).toBe("Due in 8 hours");
    expect(dueSummary({ state: "due_soon", days_left: 5, meter_left: 900, meter: "miles" })).toBe("Due in 5 days");
    expect(dueSummary({ state: "ok", days_left: 1, meter_left: null, meter: "none" })).toBe("Due tomorrow");
    expect(dueSummary({ state: "ok", days_left: null, meter_left: 1, meter: "miles" })).toBe("Due in 1 mile");
    // Both limits: lead with the one that's proportionally closer.
    const mower = { state: "ok", meter: "hours", every_meter: 100, last_done_on: "2026-10-16", next_due_on: "2027-10-16" };
    expect(dueSummary({ ...mower, days_left: 365, meter_left: 100 })).toBe("Due in 100 hours");
    expect(dueSummary({ ...mower, days_left: 30, meter_left: 90 })).toBe("Due in 30 days");
    expect(dueProgress({ ...mower, days_left: 30, meter_left: 90 })).toBeCloseTo(30 / 365);
    expect(dueTone("overdue")).toBe("danger");
  });

  it("starts each kind with sensible defaults", () => {
    expect(defaultMeter("truck")).toBe("miles");
    expect(defaultMeter("mower")).toBe("hours");
    expect(defaultMeter("nonsense")).toBe("none");
    expect(PLAN_PRESETS.mower.length).toBeGreaterThan(0);
    expect(EQUIPMENT_KINDS.every((k) => Array.isArray(PLAN_PRESETS[k.key]))).toBe(true);
  });
});
