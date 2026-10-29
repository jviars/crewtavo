/**
 * The daily "plans" and "trash" tasks (services/planFiles.ts), with PostgREST and Storage stubbed
 * through fetch: uploads never recorded go once they're a day old (plans, subs' paperwork,
 * applicants' résumés, and guide covers and quote and visit photos), files in the Trash are never
 * swept early, and the Trash is emptied of what has been there 30 days: the database deletes the
 * rows, then hands over the files to remove.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { adminClient } from "../src/lib/supabase";
import { purgeTrash, tidyApplicantFiles, tidyPlanFiles, tidySubFiles, tidyUnrecordedFiles } from "../src/services/planFiles";

const env: Env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" };
const NOW = Date.parse("2026-10-20T04:20:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

interface Call { method: string; path: string; search: URLSearchParams; body: any }

function serve() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body };
    calls.push(call);
    // kept.pdf is a file people use; trashed.pdf is one in the Trash (its row is marked deleted, and still there).
    if (call.path === "/rest/v1/plan_files" && call.method === "GET") return Response.json([{ path: "co-1/plans/kept.pdf" }, { path: "co-1/plans/trashed.pdf" }]);
    if (call.path === "/rest/v1/trashed_files") return Response.json([]);
    if (call.path === "/rest/v1/companies") return Response.json([{ id: "co-1" }]);
    if (call.path === "/storage/v1/object/list/files") {
      return Response.json([
        { id: "o1", name: "kept.pdf", created_at: hoursAgo(72) },
        { id: "o2", name: "stray.pdf", created_at: hoursAgo(30) },
        { id: "o3", name: "uploading.pdf", created_at: hoursAgo(2) },
        { id: "o4", name: "trashed.pdf", created_at: hoursAgo(900) },
      ]);
    }
    if (call.path === "/storage/v1/object/files" && call.method === "DELETE") return Response.json([]);
    return Response.json([]);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("tidying plans and files", () => {
  it("removes day-old uploads nobody recorded, and nothing else", async () => {
    const calls = serve();
    expect(await tidyPlanFiles(adminClient(env), NOW)).toEqual({ unrecorded: 1 });
    const removed = calls.filter((c) => c.path === "/storage/v1/object/files" && c.method === "DELETE").map((c) => c.body.prefixes);
    expect(removed).toEqual([["co-1/plans/stray.pdf"]]);
    // Recent uploads may still be on their way.
    expect(calls.find((c) => c.path === "/rest/v1/plan_files" && c.search.has("path"))?.search.get("path")).toBe("in.(co-1/plans/kept.pdf,co-1/plans/stray.pdf,co-1/plans/trashed.pdf)");
    // A file whose client, property, request, quote and job are gone is in the Trash (the database
    // puts it there), never deleted here: no plan file's row is touched.
    expect(calls.some((c) => c.path === "/rest/v1/plan_files" && c.method !== "GET")).toBe(false);
  });

  it("removes nothing when it can't tell what's in the Trash", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body });
      if (url.pathname === "/rest/v1/plan_files") return Response.json([]);
      if (url.pathname === "/rest/v1/trashed_files") return Response.json({ code: "57014", message: "timeout", details: null, hint: null }, { status: 500 });
      if (url.pathname === "/rest/v1/companies") return Response.json([{ id: "co-1" }]);
      if (url.pathname === "/storage/v1/object/list/files") return Response.json([{ id: "o1", name: "old.pdf", created_at: hoursAgo(72) }]);
      return Response.json([]);
    });
    await expect(tidyPlanFiles(adminClient(env), NOW)).rejects.toThrow("timeout");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("tidying subs' paperwork", () => {
  // co-1/subs holds two subs' folders: one with a recorded file, a stray and an upload on its way;
  // the other left behind by a deleted sub.
  function serveSubs(lookupFails = false) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body };
      calls.push(call);
      if (call.path === "/rest/v1/companies") return Response.json([{ id: "co-1" }]);
      if (call.path === "/rest/v1/sub_documents") {
        return lookupFails ? Response.json({ code: "57014", message: "timeout", details: null, hint: null }, { status: 500 }) : Response.json([{ path: "co-1/subs/s1/kept.pdf" }]);
      }
      // Paperwork someone deleted waits in the Trash for its 30 days.
      if (call.path === "/rest/v1/trashed_files") return Response.json(call.search.get("path")?.includes("co-1/subs/gone/coi.pdf") ? [{ path: "co-1/subs/gone/coi.pdf" }] : []);
      if (call.path === "/storage/v1/object/list/files") {
        if (body.prefix === "co-1/subs") return Response.json([{ id: null, name: "s1" }, { id: null, name: "gone" }]);
        if (body.prefix === "co-1/subs/s1") {
          return Response.json([
            { id: "o1", name: "kept.pdf", created_at: hoursAgo(72) },
            { id: "o2", name: "stray.pdf", created_at: hoursAgo(30) },
            { id: "o3", name: "uploading.pdf", created_at: hoursAgo(2) },
          ]);
        }
        if (body.prefix === "co-1/subs/gone") return Response.json([{ id: "o4", name: "w9.pdf", created_at: hoursAgo(500) }, { id: "o5", name: "coi.pdf", created_at: hoursAgo(500) }]);
        return Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }

  it("removes day-old files sent by link that were never recorded, and keeps those in the Trash", async () => {
    const calls = serveSubs();
    expect(await tidySubFiles(adminClient(env), NOW)).toEqual({ unrecorded: 2 });
    const removed = calls.filter((c) => c.path === "/storage/v1/object/files" && c.method === "DELETE").map((c) => c.body.prefixes);
    expect(removed).toEqual([["co-1/subs/s1/stray.pdf"], ["co-1/subs/gone/w9.pdf"]]);
    // Recent uploads may still be on their way.
    expect(calls.find((c) => c.path === "/rest/v1/sub_documents")?.search.get("path")).toBe("in.(co-1/subs/s1/kept.pdf,co-1/subs/s1/stray.pdf)");
  });

  it("removes nothing when it can't tell what's recorded", async () => {
    const calls = serveSubs(true);
    await expect(tidySubFiles(adminClient(env), NOW)).rejects.toThrow("timeout");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("tidying applicants' files", () => {
  const KEPT = "a0000000-0000-4000-8000-000000000001";
  const GONE = "a0000000-0000-4000-8000-000000000002";
  // co-1/applicants holds a kept applicant's folder (their résumé, a stray, an upload on its way) and a deleted one's.
  function serveApplicants(lookupFails = false) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body };
      calls.push(call);
      if (call.path === "/rest/v1/companies") return Response.json([{ id: "co-1" }]);
      if (call.path === "/rest/v1/job_applicants") {
        if (lookupFails) return Response.json({ code: "57014", message: "timeout", details: null, hint: null }, { status: 500 });
        return Response.json(call.search.get("id") === `eq.${KEPT}` ? [{ files: [{ path: `co-1/applicants/${KEPT}/1.pdf` }] }] : []);
      }
      // A résumé whose applicant was deleted waits in the Trash for its 30 days.
      if (call.path === "/rest/v1/trashed_files") return Response.json(call.search.get("path")?.includes(`co-1/applicants/${GONE}/2.pdf`) ? [{ path: `co-1/applicants/${GONE}/2.pdf` }] : []);
      if (call.path === "/storage/v1/object/list/files") {
        if (body.prefix === "co-1/applicants") return Response.json([{ id: null, name: KEPT }, { id: null, name: GONE }, { id: null, name: "not-an-applicant" }]);
        if (body.prefix === `co-1/applicants/${KEPT}`) {
          return Response.json([
            { id: "o1", name: "1.pdf", created_at: hoursAgo(72) },
            { id: "o2", name: "2.docx", created_at: hoursAgo(30) },
            { id: "o3", name: "3.pdf", created_at: hoursAgo(2) },
          ]);
        }
        if (body.prefix === `co-1/applicants/${GONE}`) return Response.json([{ id: "o4", name: "1.pdf", created_at: hoursAgo(500) }, { id: "o5", name: "2.pdf", created_at: hoursAgo(500) }]);
        return Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }

  it("removes day-old files no applicant lists, and keeps those in the Trash", async () => {
    const calls = serveApplicants();
    expect(await tidyApplicantFiles(adminClient(env), NOW)).toEqual({ unrecorded: 2 });
    const removed = calls.filter((c) => c.path === "/storage/v1/object/files" && c.method === "DELETE").map((c) => c.body.prefixes);
    expect(removed).toEqual([[`co-1/applicants/${KEPT}/2.docx`], [`co-1/applicants/${GONE}/1.pdf`]]);
    expect(calls.some((c) => c.body?.prefix === "co-1/applicants/not-an-applicant")).toBe(false);
  });

  it("removes nothing when it can't tell what's recorded", async () => {
    const calls = serveApplicants(true);
    await expect(tidyApplicantFiles(adminClient(env), NOW)).rejects.toThrow("timeout");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("tidying covers and photos nobody recorded", () => {
  type Row = { company_id: string; paths: string[] };
  function serveUnrecorded(answer: (round: number) => Response | Row[], refuse = false) {
    const calls: Call[] = [];
    let round = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body };
      calls.push(call);
      if (call.path === "/rest/v1/rpc/unrecorded_files") {
        const out = answer(round++);
        return out instanceof Response ? out : Response.json(out);
      }
      if (call.path === "/storage/v1/object/files" && call.method === "DELETE") {
        return refuse ? Response.json({ statusCode: "500", error: "internal", message: "disk is busy" }, { status: 500 }) : Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }
  const removed = (calls: Call[]) => calls.filter((c) => c.path === "/storage/v1/object/files" && c.method === "DELETE").flatMap((c) => c.body.prefixes);

  it("removes the files the database says nothing recorded, only in their folders and their company", async () => {
    const calls = serveUnrecorded((round) =>
      round === 0
        ? [
            // A file outside those folders, or another company's, is never removed, whatever comes back.
            { company_id: "co-1", paths: ["co-1/kb/a.jpg", "co-1/quote/q1/b.jpg", "co-1/visit/v1/c.jpg", "co-1/plans/x.pdf", "co-2/kb/theirs.jpg", "co-1/kb/../plans/y.pdf", "co-1/kb/a.jpg"] },
            { company_id: "co-2", paths: ["co-2/visit/v2/d.jpg"] },
          ]
        : [],
    );
    expect(await tidyUnrecordedFiles(adminClient(env))).toEqual({ unrecorded: 4, kept: 0 });
    expect(removed(calls)).toEqual(["co-1/kb/a.jpg", "co-1/quote/q1/b.jpg", "co-1/visit/v1/c.jpg", "co-2/visit/v2/d.jpg"]);
    // Asked once: fewer than a page came back.
    expect(calls.filter((c) => c.path === "/rest/v1/rpc/unrecorded_files").map((c) => c.body)).toEqual([{ p_limit: 1000 }]);
    // The database decides what's unrecorded: nothing here lists the folders or reads rows.
    expect(calls.some((c) => c.path.startsWith("/storage/v1/object/list") || c.path.startsWith("/rest/v1/attachments"))).toBe(false);
  });

  it("asks again while a full page comes back", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => `co-1/visit/v1/${i}.jpg`);
    const calls = serveUnrecorded((round) => (round === 0 ? [{ company_id: "co-1", paths: page }] : round === 1 ? [{ company_id: "co-1", paths: ["co-1/kb/last.jpg"] }] : []));
    expect(await tidyUnrecordedFiles(adminClient(env))).toEqual({ unrecorded: 1001, kept: 0 });
    expect(calls.filter((c) => c.path === "/rest/v1/rpc/unrecorded_files")).toHaveLength(2);
  });

  it("stops when Storage won't remove them, rather than asking for the same ones all night", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => `co-1/kb/${i}.jpg`);
    const calls = serveUnrecorded(() => [{ company_id: "co-1", paths: page }], true);
    expect(await tidyUnrecordedFiles(adminClient(env))).toEqual({ unrecorded: 0, kept: 1000 });
    expect(calls.filter((c) => c.path === "/rest/v1/rpc/unrecorded_files")).toHaveLength(1);
  });

  it("removes nothing when the database can't say", async () => {
    const calls = serveUnrecorded(() => Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 }));
    await expect(tidyUnrecordedFiles(adminClient(env))).rejects.toThrow(/statement timeout/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("emptying the Trash", () => {
  const CUTOFF = "2026-09-20T04:20:00.000Z";
  type Row = { source: string; company_id: string; deleted: number; paths: string[] };
  // What the database deletes and hands over, a round at a time, a row for each kind and company:
  // two plan files and a folder, then three files from elsewhere: a receipt Storage won't remove,
  // one still in use (no file handed over), and one naming another company's file.
  const ROUNDS: Row[][] = [
    [
      { source: "plan_files", company_id: "co-1", deleted: 2, paths: ["co-1/plans/a.pdf", "co-1/plans/b.docx"] },
      { source: "drive_folders", company_id: "co-1", deleted: 1, paths: [] },
    ],
    [{ source: "trashed_files", company_id: "co-1", deleted: 3, paths: ["co-1/receipts/stuck.jpg", "co-2/receipts/theirs.jpg"] }],
  ];
  function serveTrash(answer: (round: number) => Response | Row[]) {
    const calls: Call[] = [];
    let round = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body };
      calls.push(call);
      if (call.path === "/rest/v1/rpc/trash_purge") {
        const out = answer(round++);
        return out instanceof Response ? out : Response.json(out);
      }
      if (call.path === "/storage/v1/object/files" && call.method === "DELETE") {
        if (call.body.prefixes.includes("co-1/receipts/stuck.jpg")) return Response.json({ statusCode: "500", error: "internal", message: "disk is busy" }, { status: 500 });
        return Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }
  const steps = (calls: Call[]) => calls.map((c) => (c.path === "/storage/v1/object/files" ? `storage ${c.body.prefixes.join(",")}` : `${c.method} ${c.path.slice(9)}`));

  it("asks the database to delete what's been there 30 days, then removes only the files it hands over", async () => {
    const calls = serveTrash((round) => ROUNDS[round] ?? []);
    // The receipt Storage refused is left behind (its row is gone; nothing points at it).
    expect(await purgeTrash(adminClient(env), NOW)).toEqual({ files: 2, folders: 1, other: 3, kept: 1 });
    expect(calls[0]!.body).toEqual({ p_cutoff: CUTOFF, p_limit: 1000 });
    // A file still in use isn't handed over, and another company's is never removed.
    expect(steps(calls)).toEqual([
      "POST rpc/trash_purge",
      "storage co-1/plans/a.pdf,co-1/plans/b.docx",
      "POST rpc/trash_purge",
      "storage co-1/receipts/stuck.jpg",
      "POST rpc/trash_purge",
    ]);
    // Rows are the database's to delete: nothing here deletes one.
    expect(calls.some((c) => c.path.startsWith("/rest/v1/") && c.method === "DELETE")).toBe(false);
  });

  it("removes every file a round hands over, however many", async () => {
    // A folder of 2,500 files deleted at once comes back as one row: none are left behind.
    const many = Array.from({ length: 2500 }, (_, i) => `co-1/plans/${i}.pdf`);
    const calls = serveTrash((round) => (round === 0 ? [{ source: "plan_files", company_id: "co-1", deleted: 2500, paths: many }] : []));
    expect(await purgeTrash(adminClient(env), NOW)).toEqual({ files: 2500, folders: 0, other: 0, kept: 0 });
    const removed = calls.filter((c) => c.path === "/storage/v1/object/files").flatMap((c) => c.body.prefixes);
    expect(removed).toEqual(many);
    // In requests Storage takes (100 at a time).
    expect(calls.filter((c) => c.path === "/storage/v1/object/files")).toHaveLength(25);
  });

  it("stops for the night after 10 rounds", async () => {
    const calls = serveTrash(() => [{ source: "plan_files", company_id: "co-1", deleted: 1, paths: ["co-1/plans/x.pdf"] }]);
    expect((await purgeTrash(adminClient(env), NOW)).files).toBe(10);
    expect(calls.filter((c) => c.path === "/rest/v1/rpc/trash_purge")).toHaveLength(10);
  });

  it("removes nothing when the database can't say what's due", async () => {
    const calls = serveTrash(() => Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 }));
    await expect(purgeTrash(adminClient(env), NOW)).rejects.toThrow(/statement timeout/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
