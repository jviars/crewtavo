/**
 * The daily "plans" task (services/planFiles.ts), with PostgREST and Storage stubbed through fetch:
 * files on nothing go, and uploads never recorded go once they're a day old.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { adminClient } from "../src/lib/supabase";
import { tidyPlanFiles } from "../src/services/planFiles";

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
