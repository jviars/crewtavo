/**
 * The Jobs list as inbox rows (Page-Jobs.dc.html): grouped by what needs doing (late, today,
 * upcoming, unscheduled, then the other states), the dated groups soonest first, and each row's
 * quiet line saying where the job stands.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { groupJobs, jobProgress, type ListedJob } from "../src/features/jobs/JobsPage";

const TZ = "America/New_York";
const TODAY = "2026-11-21";
type Row = ListedJob & { id: string };
const job = (id: string, job_state: string, visits: ListedJob["visits"] = [], more: Partial<ListedJob> = {}): Row => ({ id, kind: "one_off", job_state, visits, ...more });
const visit = (scheduled_on: string | null, status = "scheduled", starts_at: string | null = null) => ({ scheduled_on, status, starts_at });
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the Jobs list's groups", () => {
  it("puts what needs doing first: late, today, upcoming, unscheduled, then the other states", () => {
    const groups = groupJobs([
      job("done", "completed"),
      job("soon", "upcoming", [visit("2026-11-24")]),
      job("none", "unscheduled"),
      job("now", "today", [visit(TODAY, "scheduled", "2026-11-21T15:30:00Z")]),
      job("late", "late", [visit("2026-11-04")]),
      job("bill", "requires_invoicing"),
    ], TODAY, TZ);
    expect(groups.map((g) => g.label)).toEqual(["Late", "Today", "Upcoming", "Unscheduled", "Requires invoicing", "Completed"]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([["late"], ["now"], ["soon"], ["none"], ["bill"], ["done"]]);
    // Only waiting too long (amber) and gone wrong (red) color a heading's icon.
    expect(groups.find((g) => g.key === "late")).toMatchObject({ tone: "danger", icon: "clock" });
    expect(groups.find((g) => g.key === "unscheduled")).toMatchObject({ tone: "warning", icon: "calendar" });
    expect(groups.find((g) => g.key === "today")?.tone).toBeUndefined();
  });

  it("orders the dated groups by the visit that matters, soonest first", () => {
    const groups = groupJobs([
      job("later", "upcoming", [visit("2026-12-02")]),
      job("first", "upcoming", [visit("2026-11-23")]),
      job("afternoon", "today", [visit(TODAY, "scheduled", "2026-11-21T19:00:00Z")]),
      job("morning", "today", [visit(TODAY, "scheduled", "2026-11-21T13:00:00Z")]),
    ], TODAY, TZ);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([["morning", "afternoon"], ["first", "later"]]);
  });

  it("needs no heading for one tab of a single other state, as Completed", () => {
    const groups = groupJobs([job("a", "completed"), job("b", "completed")], TODAY, TZ);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeUndefined();
    // Active's own groups keep theirs, even alone.
    expect(groupJobs([job("c", "today", [visit(TODAY)])], TODAY, TZ)[0]!.label).toBe("Today");
  });
});

describe("a job row's quiet line", () => {
  it("says when a late job was due, and how many visits are overdue and done", () => {
    const p = jobProgress(job("x", "late", [visit("2026-11-04"), visit("2026-11-05"), visit("2026-11-02", "completed"), visit("2026-11-30")]), TODAY, TZ);
    expect(p).toMatchObject({ when: "Was due Wed, Nov 4", overdue: 2, done: 1, total: 4 });
  });

  it("gives today's time, the next day, or says it isn't on the calendar", () => {
    expect(jobProgress(job("t", "today", [visit(TODAY, "scheduled", "2026-11-21T15:30:00Z")]), TODAY, TZ).when).toBe("Today, 10:30 AM");
    expect(jobProgress(job("t", "today", [visit(TODAY)]), TODAY, TZ).when).toBe("Today");
    expect(jobProgress(job("u", "upcoming", [visit("2026-11-25"), visit("2026-11-24")]), TODAY, TZ).when).toBe("Tue, Nov 24");
    expect(jobProgress(job("n", "unscheduled"), TODAY, TZ).when).toBe("Not on the calendar");
  });

  it("says a multi-day visit's day, and when a paused job comes back", () => {
    expect(jobProgress(job("s", "upcoming", [{ scheduled_on: "2026-11-24", status: "scheduled", series_day: 1, series_total: 2 }]), TODAY, TZ).part).toBe("day 1 of 2");
    expect(jobProgress(job("p", "paused", [], { resume_on: "2027-03-01" }), TODAY, TZ).when).toBe("Resumes Mon, Mar 1");
    expect(jobProgress(job("p", "paused", [], { paused_at: "2026-11-10T14:00:00Z" }), TODAY, TZ).when).toBe("Paused since Tue, Nov 10");
  });
});

describe("the Jobs page", () => {
  it("lists jobs as inbox rows with the shared toolbar, never a table", () => {
    const page = source("../src/features/jobs/JobsPage.tsx");
    expect(page).toContain("<InboxList");
    expect(page).toContain("<FilterTabs<FilterKey | \"below\">");
    expect(page).not.toMatch(/<table\b/);
    // Late, Today, Upcoming and Unscheduled are Active's groups: a tab only while a link opens one.
    expect(page).toContain("hidden: IN_ACTIVE.has(f.key) && (filter !== f.key || showBelow)");
    // A phone shows the boxes only after Select: the selection bar's own mode, not a second toggle of the page's.
    expect(page).toContain("selection={canSell ? selection : undefined}");
    expect(page).not.toMatch(/\bpicking\b|usePhone/);
  });

  it("puts a late job's overdue visits last on a desktop and first on a phone, as the boards do", () => {
    const page = source("../src/features/jobs/JobsPage.tsx");
    const css = source("../src/features/jobs/jobs.module.css");
    const first = page.indexOf("cx(styles.overdue, styles.phoneOnly)");
    const done = page.indexOf("`${p.done} of ${p.total} done`");
    const last = page.indexOf("cx(styles.overdue, styles.wideOnly)");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(done);
    expect(last).toBeGreaterThan(done);
    // Each copy hides on the other screen with the dot beside it, so no line starts or ends with "·".
    expect(css).toContain(".phoneOnly, .phoneOnly + :global(.meta-dot) { display: none !important; }");
    expect(css).toContain(":global(.meta-dot):has(+ .wideOnly:last-child)");
  });

  it("lays a job out as a record page, with its visits as rows that open the visit", () => {
    const page = source("../src/features/jobs/JobPage.tsx");
    expect(page).toContain("<DetailHeader");
    expect(page).toContain("<DetailColumns");
    expect(page).toContain('<button type="button" className="rel-link" onClick={() => openVisit(v)}>');
    // Danger last, after a separator.
    expect(page.indexOf('label: "Delete job"')).toBeGreaterThan(page.lastIndexOf("{ separator: true }"));
  });
});
