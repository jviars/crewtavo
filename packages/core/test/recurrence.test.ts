import { describe, expect, it } from "vitest";
import { buildSimpleRule, lastDate, occurrenceDates, parseSimpleRule, repeatText, scheduleText } from "../src/recurrence";

// The repeat editor's rules, as the job screen builds them and reads them back.
describe("the job screen's repeats", () => {
  it("builds every N days, a weekday in the month, and an end after a number of visits", () => {
    expect(buildSimpleRule({ freq: "DAILY", interval: 3, days: [], monthDay: 1 })).toBe("FREQ=DAILY;INTERVAL=3");
    expect(buildSimpleRule({ freq: "MONTHLY", interval: 1, days: [], monthDay: 1, weekday: { week: 1, day: "MO" } })).toBe("FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO");
    expect(buildSimpleRule({ freq: "MONTHLY", interval: 2, days: [], monthDay: 1, weekday: { week: -1, day: "FR" } })).toBe("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR");
    expect(buildSimpleRule({ freq: "WEEKLY", interval: 2, days: ["TU"], monthDay: 1, count: 12 })).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=12");
  });

  it("reads them back as they were built", () => {
    for (const rule of ["FREQ=DAILY;INTERVAL=3", "FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO", "FREQ=MONTHLY;INTERVAL=12;BYDAY=-1FR;COUNT=4", "FREQ=WEEKLY;INTERVAL=8;BYDAY=TU,TH;COUNT=12", "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15"]) {
      expect(buildSimpleRule(parseSimpleRule(rule))).toBe(rule);
    }
    // A daily rule on some days is a weekly one on those days, as before.
    expect(parseSimpleRule("FREQ=DAILY;BYDAY=MO,WE").freq).toBe("WEEKLY");
  });

  it("finds the first Monday and the last Friday", () => {
    expect(occurrenceDates({ starts_on: "2026-11-01", recurrence_rule: "FREQ=MONTHLY;BYDAY=1MO" }, "2026-11-01", "2027-01-31")).toEqual(["2026-11-02", "2026-12-07", "2027-01-04"]);
    expect(occurrenceDates({ starts_on: "2026-11-01", recurrence_rule: "FREQ=MONTHLY;BYDAY=-1FR" }, "2026-11-01", "2027-01-31")).toEqual(["2026-11-27", "2026-12-25", "2027-01-29"]);
    expect(occurrenceDates({ starts_on: "2026-11-01", recurrence_rule: "FREQ=DAILY;INTERVAL=10" }, "2026-11-01", "2026-11-30")).toEqual(["2026-11-01", "2026-11-11", "2026-11-21"]);
  });
});

// "Ends after 12 visits" counts visits from the job's first date, done ones too.
describe("ending after a number of visits", () => {
  it("counts from the first date, whatever the window", () => {
    const job = { starts_on: "2026-11-03", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3" };
    expect(occurrenceDates(job, "2026-11-10", "2027-12-31")).toEqual(["2026-11-10", "2026-11-17"]);
    expect(lastDate(job)).toBe("2026-11-17");
  });

  it("doesn't count dates out of season", () => {
    const job = { starts_on: "2026-10-05", recurrence_rule: "FREQ=MONTHLY;BYMONTHDAY=5;COUNT=3", active_months: [10, 11, 4] };
    expect(occurrenceDates(job, "2026-10-01", "2027-12-31")).toEqual(["2026-10-05", "2026-11-05", "2027-04-05"]);
    expect(lastDate(job)).toBe("2027-04-05");
  });

  it("doesn't count the days it was paused, up to the day it resumed", () => {
    // Paused Nov 9 to 24 (and before it began): Nov 10 and 17 aren't visits; Nov 24 is.
    const job = { starts_on: "2026-11-03", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3", paused: [{ from: "2026-10-01", until: "2026-11-01" }, { from: "2026-11-09", until: "2026-11-24" }] };
    expect(occurrenceDates(job, "2026-11-01", "2027-12-31")).toEqual(["2026-11-03", "2026-11-24", "2026-12-01"]);
    expect(lastDate(job)).toBe("2026-12-01");
  });

  it("has no last date without one, and ignores an end date the count keeps", () => {
    expect(lastDate({ starts_on: "2026-11-03", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU" })).toBeNull();
    expect(lastDate({ starts_on: "2026-11-03", ends_on: "2026-11-04", recurrence_rule: "FREQ=WEEKLY;BYDAY=TU;COUNT=2" })).toBe("2026-11-10");
  });
});

// The one line the job page and the repeat editor say a rule in.
describe("a rule in a line", () => {
  it("says every N days, weekdays in the month and how many visits", () => {
    expect(repeatText("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=12")).toBe("Every 2 weeks, Tuesday, 12 visits");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=1")).toBe("Weekly, Monday, 1 visit");
    expect(repeatText("FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR")).toBe("Monthly, last Friday");
    expect(repeatText("FREQ=MONTHLY;INTERVAL=6;BYDAY=2TU")).toBe("Every 6 months, second Tuesday");
    expect(repeatText("FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=1;COUNT=5")).toBe("Every 12 months, the 1st, 5 visits");
    expect(scheduleText("FREQ=WEEKLY;INTERVAL=8;BYDAY=FR", [4, 5, 6, 7, 8, 9, 10])).toBe("Every 8 weeks, Friday, April to October");
  });
});
