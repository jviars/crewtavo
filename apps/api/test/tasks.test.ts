/**
 * Background tasks against a stand-in for PostgREST and the forecast: fetch is stubbed, and each
 * test answers the requests it expects. (What the database functions do is tested in supabase/tests.)
 */
import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { runTask } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
};

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
}

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("weather holds", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const days = [0, 1, 2, 3].map((i) => addDays(today, i));
  // Tomorrow is cold and wet.
  const forecast = { daily: { time: days, temperature_2m_min: [55, 35, 55, 55], temperature_2m_max: [70, 50, 70, 70], precipitation_probability_max: [10, 90, 10, 10] } };
  // What the Lawn & Exterior preset saves in settings.weather_rules at signup.
  const company = { weather_rules: [{ applies_to: "Weekly mow", max_rain_pct: 70 }, { applies_to: "House power wash", min_temp_f: 40 }] };
  const visit = (id: string, job: unknown) => ({ id, scheduled_on: tomorrow, hold_reason: null, job, company, property: { lat: 37.13, lng: -80.41 } });

  it("uses the company's rules for the services on a job that has none of its own", async () => {
    const visits = [
      visit("mow", { weather_rules: [], lines: [{ name: "Mowing, front and back", service: { name: "Weekly mow" } }] }),
      visit("wash", { weather_rules: [], lines: [{ name: "House power wash", service: null }] }),
      visit("gutters", { weather_rules: [], lines: [{ name: "Gutter cleaning", service: null }] }),
      // The job's own rules come first: it's fine with rain up to 95%.
      visit("own", { weather_rules: [{ max_rain_pct: 95 }], lines: [{ name: "Weekly mow", service: null }] }),
      visit("task", null),
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 5, flagged: 2, unknown: 0 });
    const holds = calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => ({ id: c.url.searchParams.get("id"), hold: c.body.hold_reason }));
    expect(holds).toEqual([
      { id: "eq.mow", hold: "Weekly mow: 90% chance of rain" },
      { id: "eq.wash", hold: "House power wash: low of 35°F is below 40°F" },
    ]);
  });

  it("reads every visit a page at a time, in a fixed order", async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => visit(`v${start + i}`, { weather_rules: [], lines: [] }));
    const calls = serve((call) => {
      if (call.method !== "GET" || call.path !== "visits") return [];
      return Number(call.url.searchParams.get("offset")) === 0 ? page(0, 1000) : page(1000, 1);
    });
    expect(await runTask("weather", env)).toMatchObject({ checked: 1001 });
    const reads = calls.filter((c) => c.path === "visits").map((c) => [c.url.searchParams.get("order"), c.url.searchParams.get("offset"), c.url.searchParams.get("limit")]);
    expect(reads).toEqual([
      ["id.asc", "0", "1000"],
      ["id.asc", "1000", "1000"],
    ]);
  });
});

describe("hourly upkeep", () => {
  it("runs every step even when one fails, and reports the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => {
      if (call.path === "rpc/mark_overdue_invoices") return Response.json({ code: "22023", message: 'time zone "Not/AZone" not recognized', details: null, hint: null }, { status: 400 });
      if (call.path === "rpc/emit_visit_reminders") return 2;
      if (call.path === "rpc/emit_equipment_alerts") return 1;
      if (call.path === "rpc/clock_upkeep") return { reminded: 1, stopped: 0 };
      throw new Error(`unexpected ${call.path}`);
    });
    expect(await runTask("followups", env)).toEqual({
      overdue: 0,
      reminders: 2,
      equipment: 1,
      clocks: { reminded: 1, stopped: 0 },
      problems: ['mark_overdue_invoices: time zone "Not/AZone" not recognized'],
    });
    expect(calls.map((c) => c.path)).toEqual(["rpc/mark_overdue_invoices", "rpc/emit_visit_reminders", "rpc/emit_equipment_alerts", "rpc/clock_upkeep"]);
    expect(error).toHaveBeenCalled();
  });
});
