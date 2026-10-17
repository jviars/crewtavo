import { RRule } from "rrule";
import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_KINDS,
  PLAN_PRESETS,
  defaultMeter,
  describeInterval,
  dueProgress,
  dueSummary,
  dueTone,
  FORMULA_VARIABLES,
  FormulaError,
  checkCondition,
  describeRuleSentence,
  evaluateConditions,
  renderTemplate,
  validateRule,
  PRESETS,
  addDays,
  evaluateFormula,
  formulaVariables,
  isIsoDate,
  isTimeZoneName,
  jobWeatherRules,
  lineLengthM,
  localDate,
  localTime,
  mToFt,
  occurrenceDates,
  orderStops,
  parseRule,
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

  it("refuses pitches that aren't a roof", () => {
    expect(pitchFactor("30deg")).toBeCloseTo(1.1547, 4);
    // Up to 80 degrees, about 68/12: steeper than any roof a crew shingles.
    expect(pitchFactor("24/12")).toBeCloseTo(2.2361, 4);
    expect(pitchFactor("80deg")).toBeCloseTo(5.7588, 4);
    expect(pitchFactor("68/12")).toBeCloseTo(5.7542, 4);
    // "abcdeg" used to be NaN, "90deg" 1.6e16 and "1e200" Infinity; just short of upright was
    // millions of times the plan area.
    for (const bad of ["abcdeg", "90deg", "-90deg", "120deg", "deg30", "1e200", "7/0", "seven", "80.5deg", "89.99999deg", "69/12", "1e9/1", "1e150"]) {
      expect(() => pitchFactor(bad), bad).toThrow(RangeError);
    }
    expect(() => roofingSquares(2000, "90deg")).toThrow(RangeError);
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

  it("refuses shapes whose points aren't numbers, with a message to show", () => {
    const summarize = (geometry: { type: string; coordinates: unknown }, properties = {}) =>
      () => summarizeFeatureCollection({ type: "FeatureCollection", features: [{ type: "Feature", properties: { label: "Drive" }, geometry: { type: "Point", coordinates: RECT[0] } }, { type: "Feature", properties, geometry }] });
    // coordinates: null used to be a TypeError (a 500 from the API).
    for (const type of ["Polygon", "MultiPolygon", "LineString", "Point", "MultiPoint"]) {
      expect(summarize({ type, coordinates: null }), type).toThrow(new RangeError("Shape 2 needs its points as [longitude, latitude] numbers"));
    }
    for (const coordinates of ["abc", RECT, [[["-80.5", "37.1"], RECT[1], RECT[2]]], [[[-80.5, 37.1], [Infinity, 37.1], RECT[2]]], [[[-80.5, 137.1], RECT[1], RECT[2]]], [[[-80.5], RECT[1], RECT[2]]]]) {
      expect(summarize({ type: "Polygon", coordinates }), JSON.stringify(coordinates)).toThrow(RangeError);
    }
    expect(summarize({ type: "LineString", coordinates: [RECT] })).toThrow(RangeError);
    expect(summarize({ type: "Polygon", coordinates: [RECT] }, { manual_value: "about 90" })).toThrow(new RangeError("Shape 2 needs a measured value of zero or more"));
    expect(summarize({ type: "Polygon", coordinates: [RECT] }, { manual_value: -90 })).toThrow(RangeError);
    expect(summarize({ type: "Polygon", coordinates: [RECT] }, { manual_value: "90" })().total_area_sqft).toBe(90);
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

  it("only calls its own functions, not ones every object has", () => {
    // "constructor(5) + 1" used to be 6, and these threw TypeErrors instead of FormulaErrors.
    for (const bad of ["constructor(5) + 1", "__proto__(1)", "__defineGetter__(1, 2)", "toString()", "hasOwnProperty(1)", "valueOf()"]) {
      expect(() => evaluateFormula(bad, { area: 1 }), bad).toThrow(FormulaError);
      expect(() => validateFormula(bad), bad).toThrow(/Unknown function/);
    }
    expect(() => evaluateFormula("toString * 2", {})).toThrow(/Unknown value "toString"/);
  });

  it("reports unknown and missing values", () => {
    expect(() => evaluateFormula("area_sqft * 2", {})).toThrow(/Unknown value/);
    expect(() => evaluateFormula("depth_in * 2", { depth_in: null })).toThrow(/no value yet/);
    expect(() => evaluateFormula("1 / 0", {})).toThrow(/Division by zero/);
  });

  it("accepts only the values a measurement supplies", () => {
    for (const name of FORMULA_VARIABLES) expect(() => validateFormula(`${name} * 2`), name).not.toThrow();
    // These used to be accepted, but nothing ever supplies them, so a formula using one never worked.
    for (const name of ["hours", "rate", "unit_price", "quantity"]) {
      expect(() => validateFormula(`${name} * 2`), name).toThrow(`Unknown value "${name}"`);
    }
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

  it("rejects rules jobs can't use, with a reason", () => {
    // Negative intervals used to loop forever; sub-daily rules piled up hundreds of thousands of dates.
    expect(() => parseRule("FREQ=DAILY;INTERVAL=-1")).toThrow("INTERVAL must be a whole number from 1 to 52");
    expect(() => parseRule("FREQ=WEEKLY;INTERVAL=-2;BYDAY=TU")).toThrow("INTERVAL must be");
    for (const interval of ["0", "53", "x", "+2"]) expect(() => parseRule(`FREQ=DAILY;INTERVAL=${interval}`)).toThrow("INTERVAL must be");
    expect(() => parseRule("FREQ=DAILY;INTERVAL=1.5")).toThrow(RangeError);
    for (const freq of ["SECONDLY;INTERVAL=10", "MINUTELY", "HOURLY"]) expect(() => parseRule(`FREQ=${freq}`)).toThrow("Jobs repeat daily, weekly, monthly or yearly");
    expect(() => parseRule("FREQ=DAILY;BYHOUR=9,10")).toThrow("BYHOUR isn't supported");
    expect(() => parseRule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1")).toThrow("BYSETPOS isn't supported");
    expect(() => parseRule("FREQ=DAILY;BYMINUTE=5")).toThrow("BYMINUTE isn't supported");
    // A second line would be read as another rule.
    expect(() => parseRule("FREQ=DAILY;BYDAY=MO\nRRULE:FREQ=SECONDLY")).toThrow("isn't a rule part");
    const job = { starts_on: "2026-01-01", recurrence_rule: "FREQ=DAILY;INTERVAL=-1" };
    expect(() => occurrenceDates(job, "2026-01-01", "2026-03-01")).toThrow(RangeError);
    expect(parseRule("rrule:freq=monthly;interval=52;byday=1mo")).toBe("FREQ=MONTHLY;INTERVAL=52;BYDAY=1MO");
  });

  it("returns quickly for a rule that never happens", () => {
    const started = Date.now();
    expect(occurrenceDates({ starts_on: "2026-01-01", recurrence_rule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30" }, "2026-01-01", "2027-02-01")).toEqual([]);
    expect(occurrenceDates({ starts_on: "2026-01-05", recurrence_rule: "FREQ=DAILY;INTERVAL=7;BYDAY=TU" }, "2026-01-01", "2027-02-01")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500); // was 6-9 seconds
  });

  it("caps how many dates one call returns", () => {
    const dates = occurrenceDates({ starts_on: "2020-01-01", recurrence_rule: "FREQ=DAILY" }, "2020-01-01", "2029-12-31");
    expect(dates).toHaveLength(1000);
    expect(new Set(dates).size).toBe(1000);
    expect(dates[0]).toBe("2020-01-01");
  });

  it("counts COUNT from the job's start, before the window", () => {
    const job = { starts_on: "2026-01-06", recurrence_rule: "FREQ=WEEKLY;COUNT=4;BYDAY=TU" };
    expect(occurrenceDates(job, "2026-01-20", "2026-12-31")).toEqual(["2026-01-20", "2026-01-27"]);
  });

  it("lists the same dates as rrule", () => {
    const rules = [
      "FREQ=DAILY", "FREQ=DAILY;INTERVAL=3", "FREQ=DAILY;BYDAY=MO,WE,FR", "FREQ=DAILY;INTERVAL=2;BYMONTH=3,4",
      "FREQ=WEEKLY", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", "FREQ=WEEKLY;INTERVAL=3;BYDAY=SU;WKST=SU", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=WE",
      "FREQ=WEEKLY;INTERVAL=4;BYDAY=1MO", "FREQ=MONTHLY", "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=MONTHLY;BYMONTHDAY=31",
      "FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;INTERVAL=3;BYDAY=2TU,4TU", "FREQ=MONTHLY;BYDAY=MO,TU;BYMONTHDAY=1,2,3",
      "FREQ=MONTHLY;BYDAY=5SA", "FREQ=YEARLY", "FREQ=YEARLY;BYMONTH=3,9;BYDAY=1SA", "FREQ=YEARLY;BYDAY=20MO", "FREQ=YEARLY;BYDAY=-1SU",
      "FREQ=YEARLY;INTERVAL=2;BYMONTH=6;BYMONTHDAY=1,15", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "FREQ=YEARLY;BYMONTH=4", "FREQ=WEEKLY;COUNT=10;BYDAY=TU,FR",
      "FREQ=MONTHLY;COUNT=5;BYMONTHDAY=31", "FREQ=DAILY;INTERVAL=5;UNTIL=20261115T000000Z",
    ];
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    for (const starts_on of ["2024-02-29", "2025-12-31", "2026-01-31", "2026-03-08"]) {
      for (const recurrence_rule of rules) {
        const expected = new RRule({ ...RRule.parseString(recurrence_rule), dtstart: new Date(`${starts_on}T00:00:00Z`) })
          .between(new Date("2026-01-01T00:00:00Z"), new Date("2027-12-31T00:00:00Z"), true)
          .map(iso);
        expect(occurrenceDates({ starts_on, recurrence_rule }, "2026-01-01", "2027-12-31"), `${recurrence_rule} from ${starts_on}`).toEqual(expected);
      }
    }
  });
});

describe("time zones", () => {
  it("converts local wall time to UTC across daylight saving", () => {
    expect(zonedTimeToUtc("2026-07-01", "07:30", "America/New_York").toISOString()).toBe("2026-07-01T11:30:00.000Z");
    expect(zonedTimeToUtc("2026-12-01", "07:30", "America/New_York").toISOString()).toBe("2026-12-01T12:30:00.000Z");
    expect(localDate(new Date("2026-07-02T02:00:00Z"), "America/New_York")).toBe("2026-07-01");
  });

  it("only takes real calendar dates", () => {
    for (const date of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-05", "20260105"]) expect(isIsoDate(date), date).toBe(false);
    for (const date of ["2024-02-29", "2026-02-28", "2026-12-31", "2026-01-01"]) expect(isIsoDate(date), date).toBe(true);
  });

  it("moves times the clocks skip forward, and takes the first of times they repeat", () => {
    expect(zonedTimeToUtc("2026-03-08", "02:30", "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(zonedTimeToUtc("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 03:30 CEST
    // Where the change is at midnight, the day still starts on that day.
    expect(zonedTimeToUtc("2026-09-06", "00:00", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z"); // 01:00
    expect(zonedTimeToUtc("2026-03-08", "00:00", "America/Havana").toISOString()).toBe("2026-03-08T05:00:00.000Z"); // 01:00
    expect(zonedTimeToUtc("2026-11-01", "01:30", "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z"); // EDT
    expect(zonedTimeToUtc("2026-10-25", "01:30", "Europe/London").toISOString()).toBe("2026-10-25T00:30:00.000Z"); // BST
  });

  // Every half hour of 2026, checked against what the clock on the wall shows at each instant.
  it.each(["America/New_York", "America/Los_Angeles", "America/Santiago", "America/Havana", "Europe/London", "Australia/Sydney"])(
    "resolves every wall time of the year in %s",
    (tz) => {
      const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      const shows = (t: number) => `${localDate(new Date(t), tz)} ${localTime(new Date(t), tz)}`;
      // The first instant that shows each wall time.
      const first = new Map<string, number>();
      for (let t = Date.UTC(2025, 11, 31); t < Date.UTC(2027, 0, 2); t += 30 * 60_000) {
        if (!first.has(shows(t))) first.set(shows(t), t);
      }
      const wrong: string[] = [];
      let skipped = 0;
      for (let day = "2026-01-01"; day <= "2026-12-31"; day = addDays(day, 1)) {
        for (let min = 0; min < 1440; min += 30) {
          const result = zonedTimeToUtc(day, hhmm(min), tz).getTime();
          const expected = first.get(`${day} ${hhmm(min)}`);
          if (expected === undefined) skipped++; // skipped by the clocks: an hour later, the same day
          if (expected === undefined ? shows(result) !== `${day} ${hhmm(min + 60)}` : result !== expected) wrong.push(`${day} ${hhmm(min)} -> ${shows(result)}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(skipped).toBe(2);
    },
  );

  it("accepts zone names, not offsets", () => {
    for (const zone of ["America/New_York", "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "Etc/GMT+5", "UTC"]) expect(isTimeZoneName(zone)).toBe(true);
    for (const zone of ["+05:00", "-0500", "Not/AZone", "", "America/New York"]) expect(isTimeZoneName(zone)).toBe(false);
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

  it("counts rain on the visit day itself as part of the dry time", () => {
    const outlook = [
      { date: "2026-10-20", temp_min_f: 55, temp_max_f: 70, rain_chance_pct: 90 },
      { date: "2026-10-21", temp_min_f: 55, temp_max_f: 70, rain_chance_pct: 10 },
    ];
    expect(weatherRisks([{ applies_to: "Sealcoat", requires_dry_hours: 24 }], "2026-10-20", outlook)).toEqual([
      "Sealcoat: rain likely on 2026-10-20 during the 24-hour dry time",
    ]);
  });

  it("checks a job against its own rules, or else the company's for the services on it", () => {
    const company = [{ applies_to: "Sealcoat", requires_dry_hours: 24 }, { applies_to: "Hot-mix asphalt surface", min_temp_f: 50 }, { max_rain_pct: 80 }];
    expect(jobWeatherRules([], company, ["Front lot", "sealcoat "])).toEqual([company[0], company[2]]);
    expect(jobWeatherRules([], company, ["Crack fill"])).toEqual([company[2]]);
    expect(jobWeatherRules([{ max_rain_pct: 40 }], company, ["Sealcoat"])).toEqual([{ max_rain_pct: 40 }]);
    // Hand-edited settings that aren't a list of rules are ignored.
    expect(jobWeatherRules(null, { applies_to: "Sealcoat" }, ["Sealcoat"])).toEqual([]);
    expect(jobWeatherRules([], [null, "rain", { applies_to: "Sealcoat", min_temp_f: 50 }], ["Sealcoat"])).toEqual([{ applies_to: "Sealcoat", min_temp_f: 50 }]);
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
