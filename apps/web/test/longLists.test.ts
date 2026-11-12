/**
 * The lists of jobs, quotes, requests, invoices and clients with more in a tab than they first show,
 * and more than the database sends at once (fakeDb.ts): "Load more" reaches every row, in an order
 * that doesn't shuffle rows with the same date, and the invoices' and clients' spreadsheets and the
 * invoices' totals cover every row, not the ones loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, MAX_ROWS, type Row } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: {},
  supabase: () => state.db,
}));
const { loadJobs } = await import("../src/features/jobs/JobsPage");
const { loadQuotes } = await import("../src/features/quotes/QuotesPage");
const { loadRequests } = await import("../src/features/requests/RequestsPage");
const { everyInvoice, invoiceTotals, loadInvoices } = await import("../src/features/invoices/InvoicesPage");
const { everyClient, loadClients } = await import("../src/features/clients/ClientsPage");

const COMPANY = "c1";
const COUNT = 1300;
const id = (n: number) => `r${String(n).padStart(4, "0")}`;
/** One of twenty days, so hundreds of rows share each date and only the id tells them apart. */
const day = (n: number) => `2026-10-${String(1 + (n % 20)).padStart(2, "0")}`;
const rows = (make: (n: number) => Row): Row[] => [...Array.from({ length: COUNT }, (_, n) => ({ id: id(n), company_id: COMPANY, ...make(n) })), { id: "theirs", company_id: "c2", ...make(0) }];
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((r) => r.id);
/** Newest first by `column`, then by id: the order each list asks for. */
const newestFirst = (list: Row[], column: string) => [...list].filter((r) => r.company_id === COMPANY).sort((a, b) => String(b[column]).localeCompare(String(a[column])) || String(a.id).localeCompare(String(b.id)));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({
    jobs: rows((n) => ({ number: n + 1, job_state: n % 2 ? "upcoming" : "late", kind: "one_off", created_at: `${day(n)}T12:00:00Z` })),
    quotes: rows((n) => ({ number: n + 1, status: "sent", is_template: false, total: 100, updated_at: `${day(n)}T12:00:00Z`, options: [] })),
    requests: rows((n) => ({ number: n + 1, status: "new", website_form_id: null, created_at: `${day(n)}T12:00:00Z` })),
    invoices: rows((n) => ({ number: n + 1, status: n % 13 ? "sent" : "overdue", due_on: day(n), issued_on: day(n), total: 100, balance_due: 40, client: { display_name: `Client ${n}` } })),
    clients: rows((n) => ({ display_name: `Client ${String(n % 400).padStart(3, "0")}`, status: "active", tags: [], created_at: `${day(n)}T12:00:00Z`, properties: [] })),
  });
  state.db = db;
});

describe("a list with more than it first shows", () => {
  it("shows the first 200 jobs and says how many there are", async () => {
    const jobs = { companyId: COMPANY, states: ["late", "upcoming"], kind: "" as const, term: "" };
    const first = await loadJobs(jobs, 200);
    expect(first.total).toBe(COUNT);
    expect(ids(first.rows)).toEqual(ids(newestFirst(db.tables.jobs!, "created_at").slice(0, 200) as Array<{ id: string }>));
    // "Load more", past what one request brings.
    const more = await loadJobs(jobs, 1200);
    expect(ids(more.rows)).toEqual(ids(newestFirst(db.tables.jobs!, "created_at").slice(0, 1200) as Array<{ id: string }>));
    expect(db.requests.at(-1)).toMatchObject({ order: "created_at.desc,id.asc", from: 1000, to: 1199 });
    // One tab's jobs only.
    expect((await loadJobs({ ...jobs, states: ["late"] }, 200)).total).toBe(COUNT / 2);
  });

  it("does the same for quotes and requests", async () => {
    const quotes = await loadQuotes({ companyId: COMPANY, statuses: ["sent"], templates: false, term: "" }, 1200);
    expect(quotes.total).toBe(COUNT);
    expect(ids(quotes.rows)).toEqual(ids(newestFirst(db.tables.quotes!, "updated_at").slice(0, 1200) as Array<{ id: string }>));
    expect(quotes.rows[0]).toMatchObject({ lines: [] });
    const requests = await loadRequests({ companyId: COMPANY, statuses: ["new"], term: "", fromWebsite: false }, 1200);
    expect(requests.total).toBe(COUNT);
    expect(ids(requests.rows)).toEqual(ids(newestFirst(db.tables.requests!, "created_at").slice(0, 1200) as Array<{ id: string }>));
    expect((await loadRequests({ companyId: COMPANY, statuses: ["new"], term: "", fromWebsite: true }, 200)).total).toBe(0);
  });

  it("loads clients past the first 1,000, where Load more used to stall", async () => {
    // As it was: one request with a bigger limit, which the database cuts at 1,000 every time.
    expect((await db.from("clients").select("id").eq("company_id", COMPANY).order("display_name").limit(1050)).data).toHaveLength(MAX_ROWS);
    const clients = await loadClients({ companyId: COMPANY, filter: "all", term: "", tag: "", sort: "name" }, 1050);
    expect(clients.total).toBe(COUNT);
    expect(clients.rows).toHaveLength(1050);
    expect(new Set(ids(clients.rows)).size).toBe(1050);
    expect(clients.rows.map((c) => c.display_name)).toEqual(clients.rows.map((c) => c.display_name).sort());
    expect((await loadClients({ companyId: COMPANY, filter: "all", term: "", tag: "", sort: "newest" }, 1300)).rows).toHaveLength(COUNT);
    expect(db.requests.at(-1)!.order).toBe("created_at.desc,id.asc");
  });
});

describe("invoices, with 1,300 still owed", () => {
  const open = { companyId: COMPANY, statuses: ["sent", "partially_paid", "overdue"], term: "", settled: false };

  it("lists the first 300 by when they're due, and can load the rest", async () => {
    const first = await loadInvoices(open, 300);
    expect(first.total).toBe(COUNT);
    expect(first.rows).toHaveLength(300);
    expect(db.requests.at(-1)).toMatchObject({ order: "due_on.asc,id.asc", from: 0, to: 299 });
    const all = await loadInvoices(open, 1500);
    expect(new Set(ids(all.rows)).size).toBe(COUNT);
    // Settled ones are newest first.
    await loadInvoices({ ...open, statuses: ["paid"], settled: true }, 300);
    expect(db.requests.at(-1)!.order).toBe("issued_on.desc,id.asc");
  });

  it("adds up every invoice in the tab, not the ones the list has loaded", async () => {
    expect(await invoiceTotals(open)).toEqual({ billed: COUNT * 100, owed: COUNT * 40 });
    expect(await invoiceTotals({ ...open, statuses: ["overdue"] })).toEqual({ billed: 100 * 100, owed: 100 * 40 });
  });

  it("puts every invoice in the spreadsheet, in the list's order", async () => {
    const all = await everyInvoice(open);
    expect(all).toHaveLength(COUNT);
    expect(new Set(ids(all)).size).toBe(COUNT);
    expect(all.map((i) => i.due_on)).toEqual(all.map((i) => i.due_on).sort());
    expect(all[0]!.client?.display_name).toMatch(/^Client /);
  });
});

describe("the clients' spreadsheet", () => {
  it("has every client once, by name", async () => {
    const all = await everyClient(COMPANY);
    expect(all).toHaveLength(COUNT);
    expect(all.map((c) => c.display_name)).toEqual(all.map((c) => c.display_name).sort());
    expect(db.requests.every((r) => r.order === "display_name.asc,id.asc")).toBe(true);
  });
});
