/**
 * Lists that feed a count, a warning or a picker, with more rows than the database sends at once
 * (fakeDb.ts): subs and their paperwork, equipment schedules and paperwork, handbook pages, what
 * people said about them and searches that found nothing. Each asked once with a limit over 1,000
 * and so stopped at 1,000 without saying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, MAX_ROWS, type Row } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: {},
  supabase: () => state.db,
}));
const { loadSubPaperwork, loadSubs } = await import("../src/features/subs/subsData");
const { loadEquipmentDue, loadPaperwork } = await import("../src/features/equipment/equipmentData");
const { loadSearchMisses, loadSopFeedback, loadSopPages } = await import("../src/features/kb/kbData");

const COMPANY = "c1";
const n4 = (n: number) => String(n).padStart(4, "0");
const many = (count: number, make: (n: number) => Row): Row[] => [...Array.from({ length: count }, (_, n) => ({ company_id: COMPANY, ...make(n) })), { ...make(0), company_id: "c2" }];

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({
    subcontractors: many(1200, (n) => ({ id: `s${n4(n)}`, name: `Sub ${n4(n % 300)}` })),
    // Three rows a sub, and no id.
    sub_paperwork: many(1500, (n) => ({ subcontractor_id: `s${n4(Math.floor(n / 3))}`, requirement: ["w9", "liability", "workers_comp"][n % 3], state: "ok" })),
    equipment_due: many(1100, (n) => ({ plan_id: `p${n4(n)}`, equipment_id: `e${n4(n % 550)}`, name: `Service ${n}`, state: n % 2 ? "ok" : "overdue", days_left: n })),
    equipment_paperwork: many(1100, (n) => ({ id: `d${n4(n)}`, equipment_id: `e${n4(n % 550)}`, expires_on: n % 5 ? `2027-01-${String(1 + (n % 20)).padStart(2, "0")}` : null })),
    sop_pages: many(1100, (n) => ({ id: `g${n4(n)}`, title: `Page ${n4(n % 200)}` })),
    sop_feedback: many(1300, (n) => ({ id: `f${n4(n)}`, helpful: n % 2 === 0, created_at: `2026-10-${String(1 + (n % 20)).padStart(2, "0")}T12:00:00Z` })),
    sop_search_misses: many(1300, (n) => ({ id: `m${n4(n)}`, query: "ladders", created_at: n < 1250 ? "2026-11-01T12:00:00Z" : "2026-07-01T12:00:00Z" })),
  });
  state.db = db;
});

describe("lists that are read whole", () => {
  it("were cut at 1,000 when asked for in one request", async () => {
    expect((await db.from("subcontractors").select("*").eq("company_id", COMPANY).order("name").limit(2000)).data).toHaveLength(MAX_ROWS);
  });

  it("have every sub, by name, and every sub's paperwork", async () => {
    const subs = await loadSubs(COMPANY);
    expect(new Set(subs.map((s) => s.id)).size).toBe(1200);
    expect(subs.map((s) => s.name)).toEqual(subs.map((s) => s.name).sort());
    const paperwork = await loadSubPaperwork(COMPANY);
    expect(new Set(paperwork.map((r) => `${r.subcontractor_id} ${r.requirement}`)).size).toBe(1500);
    expect(db.requests.at(-1)!.order).toBe("subcontractor_id.asc,requirement.asc");
    // One sub's is its three rows.
    expect((await loadSubPaperwork(COMPANY, "s0499")).map((r) => r.requirement).sort()).toEqual(["liability", "w9", "workers_comp"]);
  });

  it("have every equipment schedule, most urgent first, and all the paperwork by when it runs out", async () => {
    const due = await loadEquipmentDue(COMPANY);
    expect(new Set(due.map((d) => d.plan_id)).size).toBe(1100);
    expect(due[0]!.state).toBe("overdue");
    expect(await loadEquipmentDue(COMPANY, "e0007")).toHaveLength(2);
    const papers = await loadPaperwork(COMPANY);
    expect(new Set(papers.map((p) => p.id)).size).toBe(1100);
    // Ones with no date to run out come last, as before.
    expect(papers.at(-1)!.expires_on).toBeNull();
    expect(papers.slice(0, 880).map((p) => p.expires_on)).toEqual(papers.slice(0, 880).map((p) => p.expires_on).sort());
    expect(await loadPaperwork(COMPANY, "e0007")).toHaveLength(2);
  });

  it("have every handbook page by title, all that was said about them, and the searches since a date", async () => {
    const pages = await loadSopPages(COMPANY);
    expect(new Set(pages.map((p) => p.id)).size).toBe(1100);
    expect(pages.map((p) => p.title)).toEqual(pages.map((p) => p.title).sort());
    const feedback = await loadSopFeedback(COMPANY);
    expect(new Set(feedback.map((f) => f.id)).size).toBe(1300);
    expect(feedback.filter((f) => f.helpful)).toHaveLength(650);
    expect(feedback.map((f) => f.created_at)).toEqual(feedback.map((f) => f.created_at).sort().reverse());
    expect(await loadSearchMisses(COMPANY, "2026-08-14T00:00:00Z")).toHaveLength(1250);
  });
});
