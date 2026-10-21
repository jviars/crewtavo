import { describe, expect, it } from "vitest";
import { dayRoute } from "../src/features/schedule/dayRoute";
import { routeLegs, shopPlace, type Place } from "../src/lib/maps";
import type { Company } from "../src/lib/session";

const shop: Place = { line1: "1 Shop Rd", city: "Dayton", region: "OH", postal_code: "45402", lat: 39.76, lng: -84.19 };
const stop = (n: number): Place => ({ line1: `${n} Oak St`, city: "Dayton", region: "OH", lat: 39.7 + n / 1000, lng: -84.2 });
const stops = (count: number) => Array.from({ length: count }, (_, i) => stop(i + 1));
const query = (url: string) => new URL(url).searchParams;

describe("a day's route in Google Maps", () => {
  it("starts at the shop, visits each stop in order and ends back there", () => {
    const [leg, ...more] = routeLegs("google", { start: shop, stops: stops(3), end: shop });
    expect(more).toEqual([]);
    expect(leg).toMatchObject({ first: 1, last: 3, back: true });
    const q = query(leg!.url);
    expect(leg!.url.startsWith("https://www.google.com/maps/dir/?api=1&")).toBe(true);
    expect(q.get("origin")).toBe("1 Shop Rd, Dayton, OH 45402");
    expect(q.get("waypoints")).toBe("1 Oak St, Dayton, OH|2 Oak St, Dayton, OH|3 Oak St, Dayton, OH");
    expect(q.get("destination")).toBe("1 Shop Rd, Dayton, OH 45402");
    expect(q.get("travelmode")).toBe("driving");
  });

  it("splits a long day into even parts of up to ten, each starting where the last one ended", () => {
    const legs = routeLegs("google", { start: shop, stops: stops(23), end: shop });
    expect(legs.map(({ first, last, back }) => [first, last, back])).toEqual([[1, 8, false], [9, 16, false], [17, 23, true]]);
    expect(query(legs[0]!.url).get("waypoints")!.split("|")).toHaveLength(7);
    expect(query(legs[0]!.url).get("destination")).toBe("8 Oak St, Dayton, OH");
    expect(query(legs[1]!.url).get("origin")).toBe("8 Oak St, Dayton, OH");
    expect(query(legs[2]!.url).get("destination")).toBe("1 Shop Rd, Dayton, OH 45402");
    // Never more than nine waypoints and a destination.
    for (const count of [10, 11, 19, 20, 21, 40]) {
      for (const leg of routeLegs("google", { start: shop, stops: stops(count), end: shop })) expect(query(leg.url).get("waypoints")!.split("|").length).toBeLessThanOrEqual(9);
    }
  });

  it("doesn't add a part just to drive back to the shop", () => {
    const legs = routeLegs("google", { start: shop, stops: stops(10), end: shop });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ last: 10, back: false });
    expect(query(legs[0]!.url).get("destination")).toBe("10 Oak St, Dayton, OH");
  });

  it("starts from where the phone is when there's no start, and uses a map point when there's no address", () => {
    const [leg] = routeLegs("google", { start: null, stops: [{ lat: 39.5, lng: -84.1 }, stop(2)], end: null });
    const q = query(leg!.url);
    expect(q.has("origin")).toBe(false);
    expect(q.get("waypoints")).toBe("39.5,-84.1");
    expect(q.get("destination")).toBe("2 Oak St, Dayton, OH");
  });
});

describe("a day's route in Apple Maps", () => {
  it("uses Apple's directions link with a waypoint for each stop between", () => {
    const [leg] = routeLegs("apple", { start: shop, stops: stops(3), end: null });
    expect(leg!.url.startsWith("https://maps.apple.com/directions?")).toBe(true);
    expect(leg!.url).not.toContain("+");
    const q = query(leg!.url);
    expect(q.get("source")).toBe("1 Shop Rd, Dayton, OH 45402");
    expect(q.getAll("waypoint")).toEqual(["1 Oak St, Dayton, OH", "2 Oak St, Dayton, OH"]);
    expect(q.get("destination")).toBe("3 Oak St, Dayton, OH");
    expect(q.get("mode")).toBe("driving");
  });

  it("takes up to twelve stops a part", () => {
    expect(routeLegs("apple", { start: shop, stops: stops(12), end: null }).map((l) => [l.first, l.last])).toEqual([[1, 12]]);
    expect(routeLegs("apple", { start: shop, stops: stops(13), end: shop }).map((l) => [l.first, l.last, l.back])).toEqual([[1, 7, false], [8, 13, true]]);
    expect(routeLegs("apple", { start: shop, stops: stops(23), end: shop }).map((l) => [l.first, l.last, l.back])).toEqual([[1, 12, false], [13, 23, true]]);
  });
});

describe("a crew's day as a route", () => {
  const company = (settings: Record<string, unknown> = {}, address: Company["address"] = { line1: "1 Shop Rd", city: "Dayton", region: "OH", postal_code: "45402" }): Company => ({
    id: "c", name: "Mowers", slug: "mowers", trade_preset: "lawn", timezone: "America/New_York", currency: "USD", address, settings: { depot: { lat: 39.76, lng: -84.19 }, ...settings },
  });
  const visit = (status: string, n: number | null) => ({ status, property: n === null ? null : stop(n) });

  it("starts at the shop and comes back, as Settings → Schedule says", () => {
    const route = dayRoute([visit("scheduled", 1), visit("scheduled", 2), visit("cancelled", 3), visit("scheduled", null)], company());
    expect(route.start).toEqual(shopPlace(company()));
    expect(route.stops).toEqual([stop(1), stop(2)]);
    expect(route.end).toEqual(route.start);
    expect(dayRoute([visit("scheduled", 1)], company({ schedule: { return_to_shop: false } })).end).toBeNull();
  });

  it("once the day is under way, goes from where the phone is to the stops still to do", () => {
    const route = dayRoute([visit("completed", 1), visit("in_progress", 2), visit("en_route", 3), visit("scheduled", 4)], company());
    expect(route.start).toBeNull();
    expect(route.stops).toEqual([stop(3), stop(4)]);
  });

  it("has no shop when Settings → Company has no address", () => {
    expect(shopPlace({ address: {}, settings: {} })).toBeNull();
    expect(shopPlace({ address: null, settings: { depot: { lat: 1, lng: 2 } } })).toEqual({ line1: undefined, city: undefined, region: undefined, postal_code: undefined, lat: 1, lng: 2 });
  });
});
