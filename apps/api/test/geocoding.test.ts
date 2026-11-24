/**
 * Finding an address on the map: only the free geocoders are asked (the US Census, then
 * OpenStreetMap for places abroad), and an answer of "no such address" is told apart from no answer.
 * And the pins task, which looks up again the spots saved before each one's source was kept, and the
 * properties with no spot that moved to their business's country. fetch is stubbed; what the database
 * does with a spot's source and a property's country is tested in supabase/tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cronMatches } from "../src/lib/cron";
import { adminClient } from "../src/lib/supabase";
import { geocodeAddress, lookUpAddress } from "../src/services/external";
import { relocatePins, resetRelocatePins, saveLocation } from "../src/services/properties";
import { CRON_TASKS, runTask, TASKS } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
};

/** Stub fetch: `answer` returns a Response, or a body to send back as JSON. Says which hosts were asked. */
function serve(answer: (url: URL) => Response | unknown) {
  const asked: URL[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const out = answer(url);
    return out instanceof Response ? out : Response.json(out);
  });
  return asked;
}
const census = (matches: unknown[]) => ({ result: { addressMatches: matches } });
const PELL = { matchedAddress: "418 PELL AVE, ROCKY MOUNT, VA, 24151", coordinates: { x: -79.88, y: 36.99 } };

afterEach(() => vi.unstubAllGlobals());

describe("looking an address up", () => {
  it("asks the Census geocoder, and nobody else for a US address", async () => {
    const asked = serve(() => census([PELL]));
    expect(await lookUpAddress("  418 Pell   Ave, Rocky Mount, VA ")).toEqual({ lat: 36.99, lng: -79.88, formatted: PELL.matchedAddress, country: "US", source: "census" });
    expect(asked.map((u) => u.host)).toEqual(["geocoding.geo.census.gov"]);
    expect(asked[0]!.searchParams.get("address")).toBe("418 Pell Ave, Rocky Mount, VA");
  });

  it("asks only the free geocoders, whatever keys the server has", async () => {
    const asked = serve((url) => (url.host === "photon.komoot.io" ? { features: [] } : census([])));
    await lookUpAddress("418 Pell Ave, Rocky Mount, VA");
    await lookUpAddress("10 Downing Street, London", { world: true });
    expect(new Set(asked.map((u) => u.host))).toEqual(new Set(["geocoding.geo.census.gov", "photon.komoot.io"]));
  });

  it("says an address the Census doesn't know apart from a Census that didn't answer", async () => {
    serve(() => census([]));
    expect(await lookUpAddress("1 Nowhere Lane, Rocky Mount, VA")).toBe("none");
    expect(await geocodeAddress("1 Nowhere Lane, Rocky Mount, VA")).toBeNull();

    serve(() => new Response("busy", { status: 503 }));
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    serve(() => new Response("<html>maintenance</html>", { status: 200 }));
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    expect(await geocodeAddress("418 Pell Ave, Rocky Mount, VA")).toBeNull();
  });

  it("looks abroad in OpenStreetMap only when asked to", async () => {
    const london = { features: [{ geometry: { coordinates: [-0.1276, 51.5034] }, properties: { housenumber: "10", street: "Downing Street", city: "London", country: "United Kingdom", countrycode: "gb" } }] };
    const asked = serve((url) => (url.host === "photon.komoot.io" ? london : census([])));
    expect(await lookUpAddress("10 Downing Street, London")).toBe("none");
    expect(asked).toHaveLength(1);
    expect(await lookUpAddress("10 Downing Street, London", { world: true })).toEqual({ lat: 51.5034, lng: -0.1276, formatted: "10 Downing Street, London, United Kingdom", country: "GB", source: "openstreetmap" });

    serve((url) => (url.host === "photon.komoot.io" ? { features: [] } : census([])));
    expect(await lookUpAddress("1 Nowhere, Atlantis", { world: true })).toBe("none");
    serve((url) => (url.host === "photon.komoot.io" ? new Response("busy", { status: 503 }) : census([])));
    expect(await lookUpAddress("10 Downing Street, London", { world: true })).toBe("failed");
  });

  it("doesn't ask about a few letters", async () => {
    const asked = serve(() => census([PELL]));
    expect(await lookUpAddress(" 418 ")).toBe("none");
    expect(asked).toHaveLength(0);
  });
});

describe("the pins task", () => {
  const withKey: Env = { ...env, GOOGLE_MAPS_SERVER_KEY: "server-key" };
  const property = (id: string, line1: string, more: Record<string, unknown> = {}) => ({ id, line1, line2: null, city: "Rocky Mount", region: "VA", postal_code: "24151", country: "US", lat: 36.9, lng: -79.8, ...more });
  interface Call {
    method: string;
    url: URL;
    path: string;
    body: any;
  }
  /**
   * PostgREST and the geocoders: `rows` are the properties with no source, `lost` the ones with no
   * spot waiting to be found, `geocode` answers for an address.
   */
  function world(options: { rows?: Array<ReturnType<typeof property>>; lost?: Array<ReturnType<typeof property>>; shops?: unknown[]; geocode?: (address: string, host: string) => unknown; saved?: (call: Call) => unknown[] }) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const text = typeof init?.body === "string" ? init.body : "";
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      const answer = (): unknown => {
        if (url.host === "geocoding.geo.census.gov") return options.geocode?.(url.searchParams.get("address")!, url.host) ?? census([]);
        if (url.host === "photon.komoot.io") return options.geocode?.(url.searchParams.get("q")!, url.host) ?? { features: [] };
        if (call.path === "rpc/properties_to_find") return (options.lost ?? []).filter((r) => !call.body.p_after || r.id > call.body.p_after).slice(0, call.body.p_limit);
        if (call.path === "rpc/property_found") return call.body.p_lat !== undefined;
        if (call.path === "rpc/depots_to_relocate") return options.shops ?? [];
        if (call.path === "rpc/relocate_depot") return true;
        if (call.path === "properties" && call.method === "GET") {
          const after = url.searchParams.get("id")?.replace("gt.", "");
          return (options.rows ?? []).filter((r) => !after || r.id > after);
        }
        if (call.path === "properties" && call.method === "PATCH") return options.saved?.(call) ?? [{ id: url.searchParams.get("id")!.slice(3) }];
        throw new Error(`Unexpected ${call.method} ${url}`);
      };
      const out = answer();
      return out instanceof Response ? out : Response.json(out);
    });
    const lookups = () => calls.filter((c) => c.url.host !== "example.supabase.co");
    const saves = () => calls.filter((c) => c.path === "properties" && c.method === "PATCH").map((c) => ({ id: c.url.searchParams.get("id")!.slice(3), ...c.body }));
    return { calls, lookups, saves };
  }
  const run = (e: Env) => relocatePins(e, adminClient(e), { pauseMs: 0 });
  const NOTHING = { placed: 0, not_found: 0, shops: 0, looked_up: 0, moved: 0, same: 0, kept: 0, unanswered: 0 };

  beforeEach(() => resetRelocatePins());

  it("leaves the spots alone on a server with no Google server key", async () => {
    const { calls } = world({ rows: [property("p1", "418 Pell Ave")] });
    expect(await run(env)).toEqual(NOTHING);
    expect(await runTask("pins", env)).toEqual(NOTHING);
    // Only the properties with no spot are asked about, and there are none.
    expect(calls.map((c) => c.path)).toEqual(["rpc/properties_to_find", "rpc/properties_to_find"]);
  });

  it("finds the properties that never got a spot once they're in their business's country, on any server", async () => {
    const lost = [
      property("p1", "10 Downing Street", { city: "London", region: null, postal_code: "SW1A 2AA", country: "GB", lat: null, lng: null }),
      property("p2", "1 Nowhere Lane", { city: "Leeds", region: null, postal_code: null, country: "GB", lat: null, lng: null }),
    ];
    const { calls, lookups } = world({
      lost,
      geocode: (address, host) => (host === "photon.komoot.io" && /Downing/.test(address) ? { features: [{ geometry: { coordinates: [-0.1276, 51.5034] }, properties: { housenumber: "10", street: "Downing Street", countrycode: "gb" } }] } : host === "photon.komoot.io" ? { features: [] } : census([])),
    });
    expect(await run(env)).toEqual({ ...NOTHING, placed: 1, not_found: 1 });
    expect(calls.find((c) => c.path === "rpc/properties_to_find")!.body).toEqual({ p_limit: 12 });
    expect(lookups().filter((c) => c.url.host === "photon.komoot.io").map((c) => c.url.searchParams.get("q"))).toEqual(["10 Downing Street, London, SW1A 2AA, GB", "1 Nowhere Lane, Leeds, GB"]);
    // Each leaves the list: with its spot, or with none when the geocoder doesn't know it.
    expect(calls.filter((c) => c.path === "rpc/property_found").map((c) => c.body)).toEqual([
      { p_property: "p1", p_lat: 51.5034, p_lng: -0.1276, p_source: "openstreetmap" },
      { p_property: "p2" },
    ]);
  });

  it("carries on after a property whose lookup got no answer, and comes back to it", async () => {
    const lost = ["p1", "p2"].map((id) => property(id, `${id} Bank St`, { city: "Leeds", country: "GB", lat: null, lng: null }));
    const down = world({ lost: lost.slice(0, 1), geocode: () => new Response("busy", { status: 503 }) });
    expect(await run(env)).toEqual({ ...NOTHING, unanswered: 1 });
    expect(down.calls.some((c) => c.path === "rpc/property_found")).toBe(false);
    const up = world({ lost, geocode: (_address, host) => (host === "photon.komoot.io" ? { features: [{ geometry: { coordinates: [-1.54, 53.79] }, properties: { countrycode: "gb" } }] } : census([])) });
    expect(await run(env)).toMatchObject({ placed: 1 });
    expect(up.calls.find((c) => c.path === "rpc/properties_to_find")!.body).toEqual({ p_after: "p1", p_limit: 12 });
    expect(await run(env)).toMatchObject({ placed: 2 });
  });

  it("runs every few minutes, with the other tasks", () => {
    expect(TASKS).toContain("pins");
    expect(Object.entries(CRON_TASKS).filter(([, tasks]) => tasks.includes("pins")).map(([cron]) => cron)).toEqual(["3-59/5 * * * *"]);
    expect([3, 8, 58].every((minute) => cronMatches("3-59/5 * * * *", new Date(Date.UTC(2026, 10, 14, 9, minute))))).toBe(true);
    expect(cronMatches("3-59/5 * * * *", new Date(Date.UTC(2026, 10, 14, 9, 5)))).toBe(false);
  });

  it("looks up each spot with no source and saves what the free geocoders say", async () => {
    const rows = [
      property("p1", "418 Pell Ave"),
      property("p2", "9 Old Rd", { lat: 36.99, lng: -79.88 }),
      property("p3", "1 Nowhere Lane"),
      property("p4", "10 Downing Street", { city: "London", region: null, postal_code: null, country: "United Kingdom" }),
    ];
    const { calls, lookups, saves } = world({
      rows,
      geocode: (address, host) => {
        if (host === "photon.komoot.io") return { features: [{ geometry: { coordinates: [-0.1276, 51.5034] }, properties: { housenumber: "10", street: "Downing Street", countrycode: "gb" } }] };
        return /Pell|Old Rd/.test(address) ? census([PELL]) : census([]);
      },
    });
    expect(await run(withKey)).toEqual({ ...NOTHING, looked_up: 4, moved: 2, same: 1, kept: 1 });
    // Only spots with coordinates and no source are read, a few at a time, in a steady order.
    const read = calls.find((c) => c.path === "properties" && c.method === "GET")!.url.searchParams;
    expect([read.get("lat"), read.get("lng"), read.get("located_by"), read.get("order"), read.get("limit")]).toEqual(["not.is.null", "not.is.null", "is.null", "id.asc", "12"]);
    expect(lookups().map((c) => c.url.host)).toEqual(["geocoding.geo.census.gov", "geocoding.geo.census.gov", "geocoding.geo.census.gov", "geocoding.geo.census.gov", "photon.komoot.io"]);
    expect(lookups()[3]!.url.searchParams.get("address")).toBe("10 Downing Street, London, United Kingdom");
    expect(saves()).toEqual([
      { id: "p1", lat: 36.99, lng: -79.88, located_by: "census" },
      { id: "p2", lat: 36.99, lng: -79.88, located_by: "census" },
      // Neither geocoder knows it: the spot stays, marked so it isn't asked about again.
      { id: "p3", located_by: "unknown" },
      { id: "p4", lat: 51.5034, lng: -0.1276, located_by: "openstreetmap" },
    ]);
    // Each write is only for the spot as it was read, still with no source.
    const write = calls.find((c) => c.path === "properties" && c.method === "PATCH")!.url.searchParams;
    expect([write.get("id"), write.get("lat"), write.get("lng"), write.get("located_by")]).toEqual(["eq.p1", "eq.36.9", "eq.-79.8", "is.null"]);
  });

  it("leaves a spot alone when the geocoder doesn't answer, and stops asking after three in a row", async () => {
    const rows = ["p1", "p2", "p3", "p4", "p5"].map((id) => property(id, `${id} Pell Ave`));
    const down = world({ rows, geocode: () => new Response("busy", { status: 503 }) });
    expect(await run(withKey)).toEqual({ ...NOTHING, looked_up: 3, unanswered: 3 });
    expect(down.saves()).toEqual([]);
    // The next run carries on after them, so three that never answer don't hold up the rest.
    const up = world({ rows, geocode: () => census([PELL]) });
    expect(await run(withKey)).toMatchObject({ looked_up: 2, moved: 2 });
    expect(up.saves().map((s) => s.id)).toEqual(["p4", "p5"]);
    // And once it's past the last one, it starts again from the top for those.
    const again = world({ rows: rows.slice(0, 3), geocode: () => census([PELL]) });
    expect(await run(withKey)).toMatchObject({ looked_up: 3, moved: 3 });
    expect(again.saves().map((s) => s.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("doesn't count a spot the office changed while it was being looked up", async () => {
    const { saves } = world({ rows: [property("p1", "418 Pell Ave")], geocode: () => census([PELL]), saved: () => [] });
    expect(await run(withKey)).toEqual({ ...NOTHING, looked_up: 1 });
    expect(saves()).toHaveLength(1);
  });

  it("stops when its time is up, and picks up there next run", async () => {
    const rows = ["p1", "p2", "p3"].map((id) => property(id, `${id} Pell Ave`));
    const { saves } = world({ rows, geocode: () => census([PELL]) });
    let clock = 0;
    // Each look at the clock is 8 seconds on: the second property's lookup would start past the 15 a run gets.
    expect(await relocatePins(withKey, adminClient(withKey), { pauseMs: 0, now: () => (clock += 8000) })).toMatchObject({ looked_up: 1, moved: 1 });
    expect(saves().map((s) => s.id)).toEqual(["p1"]);
    expect(await run(withKey)).toMatchObject({ looked_up: 2 });
  });

  it("looks the shop up again too, and keeps a spot the geocoders don't know", async () => {
    const address = { line1: "1 Main St", city: "Rocky Mount", region: "VA", postal_code: "24151" };
    const shops = [
      { company_id: "co-1", address, depot: { lat: 36.9, lng: -79.8 } },
      { company_id: "co-2", address: { line1: "1 Nowhere Lane", city: "Rocky Mount" }, depot: { lat: 40, lng: -75 } },
      { company_id: "co-3", address: {}, depot: { lat: 41, lng: -76 } },
    ];
    const { calls, lookups } = world({ shops, geocode: (a) => (/Main/.test(a) ? census([PELL]) : census([])) });
    expect(await run(withKey)).toEqual({ ...NOTHING, shops: 3 });
    expect(lookups().map((c) => c.url.searchParams.get("address"))).toEqual(["1 Main St, Rocky Mount, VA, 24151", "1 Nowhere Lane, Rocky Mount"]);
    expect(calls.filter((c) => c.path === "rpc/relocate_depot").map((c) => c.body)).toEqual([
      { p_company: "co-1", p_address: address, p_was: { lat: 36.9, lng: -79.8 }, p_depot: { lat: 36.99, lng: -79.88, source: "census" } },
      { p_company: "co-2", p_address: shops[1]!.address, p_was: { lat: 40, lng: -75 }, p_depot: { lat: 40, lng: -75, source: "unknown" } },
      // No address to ask about.
      { p_company: "co-3", p_address: {}, p_was: { lat: 41, lng: -76 }, p_depot: { lat: 41, lng: -76, source: "unknown" } },
    ]);
  });
});

describe("saving where a property is", () => {
  it("says the source again when the same geocoder moved the spot", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      // The database forgot the source on the first write, as it does for a spot moved with the same source.
      return Response.json(writes.length === 1 ? [{ located_by: null }] : []);
    });
    await saveLocation(adminClient(env), "p1", { lat: 36.99, lng: -79.88, source: "census" });
    expect(writes).toEqual([{ lat: 36.99, lng: -79.88, located_by: "census" }, { located_by: "census" }]);
  });

  it("saves once when the source held", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json([{ located_by: "census" }]);
    });
    await saveLocation(adminClient(env), "p1", { lat: 36.99, lng: -79.88, source: "census" });
    expect(writes).toHaveLength(1);
  });
});
