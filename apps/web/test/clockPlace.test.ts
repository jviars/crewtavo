/**
 * Where people clock in and out: finding the phone (fieldData.locate) never holds a clock up or
 * fails it, and Timesheets tells the office whether that was at the job (timesheets/clockPlace).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ api: {}, supabase: () => ({}), unwrap: (r: { data: unknown }) => r.data }));
const { locate, recordsPlaces } = await import("../src/features/field/fieldData");
const { describePlace, distanceLabel } = await import("../src/features/timesheets/clockPlace");

type Success = (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
type Failure = (e: { code: number; PERMISSION_DENIED: 1; TIMEOUT: 3 }) => void;
const phone = (answer: (ok: Success, fail: Failure) => void) =>
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (ok: Success, fail: Failure) => answer(ok, fail) } });
const error = (code: number) => ({ code, PERMISSION_DENIED: 1 as const, TIMEOUT: 3 as const });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("finding the phone for a clock", () => {
  it("keeps the point and how sure the phone is", async () => {
    phone((ok) => ok({ coords: { latitude: 40.123456789, longitude: -75.987654321, accuracy: 11.6 } }));
    expect(await locate()).toEqual({ lat: 40.123457, lng: -75.987654, accuracy: 12 });
  });

  it("keeps why there's no point instead of failing", async () => {
    phone((_ok, fail) => fail(error(1)));
    expect(await locate()).toEqual({ missing: "denied" });
    phone((_ok, fail) => fail(error(3)));
    expect(await locate()).toEqual({ missing: "timeout" });
    phone((_ok, fail) => fail(error(2)));
    expect(await locate()).toEqual({ missing: "unavailable" });
    vi.stubGlobal("navigator", {});
    expect(await locate()).toEqual({ missing: "unsupported" });
  });

  it("gives up while the phone's question is still unanswered", async () => {
    vi.useFakeTimers();
    phone(() => {});
    const found = locate();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await found).toEqual({ missing: "timeout" });
  });

  it("is on unless the company switched it off", () => {
    expect(recordsPlaces({ settings: {} })).toBe(true);
    expect(recordsPlaces({ settings: { clock: { remind_after_hours: 10 } } })).toBe(true);
    expect(recordsPlaces({ settings: { clock: { record_location: false } } })).toBe(false);
  });
});

describe("what the office sees", () => {
  const job = { kind: "job" as const, lat: 40, lng: -75 };

  it("says when someone was at the job", () => {
    // About 50 m off: across a big lot.
    expect(describePlace({ lat: 40.0004, lng: -75.0003, accuracy: 12 }, job)).toMatchObject({ text: "at the job", tone: "good", mapUrl: "https://www.google.com/maps/search/?api=1&query=40.0004,-75.0003" });
    // 300 m off with a 150 m margin still counts.
    expect(describePlace({ lat: 40.0027, lng: -75, accuracy: 150 }, job).text).toBe("at the job");
  });

  it("says how far off they were otherwise", () => {
    expect(describePlace({ lat: 40.03, lng: -75, accuracy: 8 }, job)).toMatchObject({ text: "2.1 mi from the job", tone: "warning" });
    expect(describePlace({ lat: 40.03, lng: -75, accuracy: 900 }, job).text).toBe("2.1 mi from the job (rough location)");
    expect(describePlace({ lat: 40.003, lng: -75, accuracy: 5 }, { ...job, kind: "shop" }).text).toBe("0.2 mi from the shop");
  });

  it("shows the point when there's nothing to compare with, and why there's none", () => {
    expect(describePlace({ lat: 40, lng: -75, accuracy: 30 }, null)).toMatchObject({ text: "see map", tone: "plain" });
    expect(describePlace({ missing: "denied" }, job)).toMatchObject({ text: "location turned off", tone: "warning", mapUrl: null });
    expect(describePlace({ missing: "timeout" }, job).text).toBe("no location found");
  });

  it("measures in feet up close and miles further off", () => {
    expect(distanceLabel(3)).toBe("10 ft");
    expect(distanceLabel(150)).toBe("490 ft");
    expect(distanceLabel(1609.344 * 1.26)).toBe("1.3 mi");
    expect(distanceLabel(1609.344 * 38.4)).toBe("38 mi");
  });
});
