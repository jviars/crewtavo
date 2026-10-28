/**
 * The daily "plans" task (services/planFiles.ts), with PostgREST and Storage stubbed through fetch:
 * files on nothing go, and uploads never recorded go once they're a day old (plans, subs'
 * paperwork and applicants' résumés).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { adminClient } from "../src/lib/supabase";
import { tidyApplicantFiles, tidyPlanFiles, tidySubFiles } from "../src/services/planFiles";

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
    if (call.path === "/rest/v1/plan_files" && call.method === "GET" && call.search.has("property_id")) return Response.json([{ id: "lost-1", path: "co-1/plans/lost.pdf" }]);
    if (call.path === "/rest/v1/plan_files" && call.method === "GET") return Response.json([{ path: "co-1/plans/kept.pdf" }]);
    if (call.path === "/rest/v1/companies") return Response.json([{ id: "co-1" }]);
    if (call.path === "/storage/v1/object/list/files") {
      return Response.json([
        { id: "o1", name: "kept.pdf", created_at: hoursAgo(72) },
        { id: "o2", name: "stray.pdf", created_at: hoursAgo(30) },
        { id: "o3", name: "uploading.pdf", created_at: hoursAgo(2) },
      ]);
    }
    if (call.path === "/storage/v1/object/files" && call.method === "DELETE") return Response.json([]);
    return Response.json([]);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("tidying plans and files", () => {
  it("removes files on nothing, and day-old uploads nobody recorded, and nothing else", async () => {
    const calls = serve();
    expect(await tidyPlanFiles(adminClient(env), NOW)).toEqual({ detached: 1, unrecorded: 1 });
    const removed = calls.filter((c) => c.path === "/storage/v1/object/files" && c.method === "DELETE").map((c) => c.body.prefixes);
    expect(removed).toEqual([["co-1/plans/lost.pdf"], ["co-1/plans/stray.pdf"]]);
    expect(calls.find((c) => c.path === "/rest/v1/plan_files" && c.method === "DELETE")?.search.get("id")).toBe("eq.lost-1");
    // Only files on nothing at all are taken.
    const lostQuery = calls.find((c) => c.path === "/rest/v1/plan_files" && c.search.has("property_id"))!.search;
    expect(["property_id", "request_id", "quote_id", "job_id"].map((k) => lostQuery.get(k))).toEqual(["is.null", "is.null", "is.null", "is.null"]);
    // Recent uploads may still be on their way.
    expect(calls.find((c) => c.path === "/rest/v1/plan_files" && c.search.has("path"))?.search.get("path")).toBe("in.(co-1/plans/kept.pdf,co-1/plans/stray.pdf)");
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
      if (call.path === "/storage/v1/object/list/files") {
        if (body.prefix === "co-1/subs") return Response.json([{ id: null, name: "s1" }, { id: null, name: "gone" }]);
        if (body.prefix === "co-1/subs/s1") {
          return Response.json([
            { id: "o1", name: "kept.pdf", created_at: hoursAgo(72) },
            { id: "o2", name: "stray.pdf", created_at: hoursAgo(30) },
            { id: "o3", name: "uploading.pdf", created_at: hoursAgo(2) },
          ]);
        }
        if (body.prefix === "co-1/subs/gone") return Response.json([{ id: "o4", name: "w9.pdf", created_at: hoursAgo(500) }]);
        return Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }

  it("removes day-old files sent by link that were never recorded, and those of deleted subs", async () => {
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
      if (call.path === "/storage/v1/object/list/files") {
        if (body.prefix === "co-1/applicants") return Response.json([{ id: null, name: KEPT }, { id: null, name: GONE }, { id: null, name: "not-an-applicant" }]);
        if (body.prefix === `co-1/applicants/${KEPT}`) {
          return Response.json([
            { id: "o1", name: "1.pdf", created_at: hoursAgo(72) },
            { id: "o2", name: "2.docx", created_at: hoursAgo(30) },
            { id: "o3", name: "3.pdf", created_at: hoursAgo(2) },
          ]);
        }
        if (body.prefix === `co-1/applicants/${GONE}`) return Response.json([{ id: "o4", name: "1.pdf", created_at: hoursAgo(500) }]);
        return Response.json([]);
      }
      return Response.json([]);
    });
    return calls;
  }

  it("removes day-old files no applicant lists, and those of deleted applicants", async () => {
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
