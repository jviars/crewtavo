import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answersTone, clearText, progressOf, standingOf, todayGroup, triggersText } from "../src/features/snow/storm";

// Plows at 2 in and again every 2, salts from half an inch.
const site = { paused: false, located: true, rules: { trigger_in: 2, salt_trigger_in: 0.5, repeat_in: 2 }, told: false };
const stand = (snow: number | null, visits = 0, over: Partial<typeof site> = {}) => {
  const { group, label, tone, note } = standingOf({ ...site, ...over }, snow, visits);
  return [group, label, tone, note];
};

describe("Snow → Storm: where a customer stands for the storm coming", () => {
  it("is to schedule until it has every visit the forecast calls for, and says whether its people know", () => {
    expect(stand(4.5)).toEqual(["schedule", "To schedule", "warning", "Crew hears within the hour, 10am to 10pm"]);
    // With storms scheduling themselves, it says that's coming too.
    expect(standingOf(site, 4.5, 0, true).note).toBe("Crew hears and it's scheduled within the hour, 10am to 10pm");
    expect(stand(4.5, 0, { told: true })).toEqual(["schedule", "To schedule", "warning", "Crew told"]);
    // Two pushes called for and one visit: the forecast grew after it was scheduled.
    expect(stand(4.5, 1, { told: true })).toEqual(["schedule", "1 of 2 scheduled", "warning", "The forecast grew"]);
    expect(stand(4.5, 2)).toEqual(["scheduled", "Scheduled", "good", "2 visits"]);
    expect(stand(1, 1)).toEqual(["scheduled", "Scheduled", "good", undefined]);
  });
  it("is not this storm under its triggers, paused or with no forecast, in plain words", () => {
    expect(stand(0.2)).toEqual(["off", "Below trigger", null, "0.3 in short"]);
    expect(stand(1.5, 0, { rules: { trigger_in: 2 } })).toEqual(["off", "Below trigger", null, "0.5 in short"]);
    expect(stand(9, 0, { paused: true })).toEqual(["off", "Paused", null, "Not checked while the job is paused"]);
    expect(stand(null)).toEqual(["off", "No forecast", null, undefined]);
  });
  it("needs a look when it can't be checked, or its people were told and the forecast has dropped", () => {
    expect(stand(9, 0, { located: false })).toEqual(["check", "No map location", "danger", "Not checked until its address is found"]);
    expect(stand(0.2, 0, { told: true })).toEqual(["check", "Forecast dropped", "warning", "They were told. Let them know if it's off."]);
    expect(stand(0.2, 1, { told: true })[3]).toBe("Told and scheduled. Cancel the visit if it's off.");
  });
});

describe("Snow → Storm: a storm that's here today", () => {
  const v = (...statuses: string[]) => statuses.map((status) => ({ status }));
  it("goes by its least far along visit, and counts the pushes", () => {
    expect(progressOf(v("scheduled"), null, "09:00")).toEqual({ status: "scheduled", late: false, note: undefined });
    expect(progressOf(v("completed", "en_route"), null, "09:00")).toEqual({ status: "en_route", late: false, note: "1 of 2 pushes done" });
    expect(progressOf(v("completed", "in_progress", "en_route"), null, "09:00").status).toBe("in_progress");
    expect(progressOf(v("completed", "completed"), "07:00:00", "09:00")).toEqual({ status: "completed", late: false, note: "2 of 2 pushes done" });
    expect(progressOf([], "07:00:00", "09:00")).toEqual({ status: "unscheduled", late: false });
  });
  it("is late once the time it was to be clear by passes with work left", () => {
    expect(progressOf(v("scheduled"), "07:00:00", "06:59").late).toBe(false);
    expect(progressOf(v("scheduled"), "07:00:00", "07:00")).toEqual({ status: "scheduled", late: true, note: "Due by 7 AM" });
    expect(progressOf(v("completed", "scheduled"), "07:00:00", "11:30").note).toBe("Due by 7 AM · 1 of 2 pushes done");
  });
});

describe("Snow → Storm: how a row words a customer", () => {
  it("says its triggers in one line, and that it isn't salted where that's asked", () => {
    expect(triggersText({ trigger_in: 2, salt_trigger_in: 1, repeat_in: 4 })).toBe("Plow at 2 in, salt at 1 in, again every 4 in");
    expect(triggersText({ trigger_in: 1.5, salt_trigger_in: null, repeat_in: null })).toBe("Plow at 1.5 in");
    expect(triggersText({ trigger_in: 2, salt_trigger_in: null, repeat_in: 4 }, true)).toBe("Plow at 2 in, no salting, again every 4 in");
  });
  it("puts how soon it's cleared short, with its rank when it isn't the usual", () => {
    expect(clearText("06:00:00", 1)).toBe("Clear by 6 AM · first");
    expect(clearText("07:30:00", 2)).toBe("Clear by 7:30 AM");
    expect(clearText("08:00:00", 3)).toBe("Clear by 8 AM · after the others");
    expect(clearText(null, 1)).toBe("First priority");
    expect(clearText(null, 3)).toBe("After the others");
    expect(clearText(null, 2)).toBeNull();
  });
  it("colors the crew line by what the subs asked said: red for a no, amber while waiting, green when all can go", () => {
    expect(answersTone([])).toBeUndefined();
    expect(answersTone([true, true])).toBe("good");
    expect(answersTone([true, null])).toBe("warning");
    expect(answersTone([null, false])).toBe("danger");
  });
});

describe("Snow → Storm: today's storm in piles", () => {
  const at = (visits: number, more: number, status: string, late = false) => todayGroup({ visits, more, progress: { status, late } });
  it("puts what's waiting on the office first, the storm that grew with it, then late, under way and done", () => {
    expect(at(0, 1, "unscheduled")).toBe("schedule");
    expect(at(1, 1, "in_progress")).toBe("schedule");
    expect(at(1, 0, "scheduled", true)).toBe("late");
    expect(at(2, 0, "en_route")).toBe("going");
    expect(at(1, 0, "completed")).toBe("done");
  });
});

describe("Snow on a phone: rows as Mobile-Apps.dc.html draws them", () => {
  const css = readFileSync(new URL("../src/features/snow/snow.module.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 900px)"));
  it("swaps the parts said only on a desktop or only on a phone, dot and all", () => {
    expect(css).toMatch(/@media not all and \(max-width: 900px\) \{\s*:global\(\.il\) \.phoneOnly, [^{]*:has\(\+ \.phoneOnly\)/);
    expect(phone).toMatch(/:global\(\.il\) \.wideOnly, [^{]*:has\(\+ \.wideOnly\) \{ display: none; \}/);
  });
  it("gives who works it two lines rather than an ellipsis, and a tap on it opens the row", () => {
    expect(phone).toMatch(/:global\(\.il-aside\) > \.crew \{ position: static;[^}]*-webkit-line-clamp: 2;/);
  });
});

describe("Snow: a row that opens its popup on this page", () => {
  it("takes the page's place in the history through the shared row's replace, with no click handler of its own", () => {
    const page = readFileSync(new URL("../src/features/snow/SnowPage.tsx", import.meta.url), "utf8");
    const board = readFileSync(new URL("../src/features/snow/StormBoard.tsx", import.meta.url), "utf8");
    expect(page).not.toContain("onClickCapture");
    expect(page).toMatch(/to=\{`\/snow\?tab=customers&open=\$\{s\.job_id\}`\}\s+replace\n/);
    expect(board).toMatch(/to=\{`\/snow\?open=\$\{s\.job_id\}`\}\s+replace\n/);
    expect(board).toContain("replace={Boolean(site)}");
  });
});
