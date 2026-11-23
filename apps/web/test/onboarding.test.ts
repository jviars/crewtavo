import { presetSummaries } from "@crewtavo/core/presets";
import { describe, expect, it } from "vitest";
import { currencyFor, searchTrades, zoneLabel } from "@/features/auth/OnboardingPage";

describe("searching trades at sign-up", () => {
  const trades = presetSummaries();
  const ids = (query: string) => searchTrades(trades, query).map((t) => t.id);

  it("finds a trade by what people call themselves", () => {
    expect(ids("plumber")).toEqual(["plumbing"]);
    expect(ids("Electrician")).toEqual(["electrical"]);
    expect(ids("hvac")).toEqual(["hvac"]);
    expect(ids("pest")).toEqual(["pest_control"]);
    expect(ids("landscaper")).toEqual(["landscaping"]);
  });

  it("keeps the trades that match the most words", () => {
    expect(ids("pool cleaning")).toEqual(["pool_service"]);
    expect(ids("maid service")).toEqual(["cleaning"]);
    expect(ids("lawn care")).toContain("lawn_exterior");
  });

  it("keeps them all with nothing typed, and none when nothing matches", () => {
    expect(ids("  ")).toEqual(trades.map((t) => t.id));
    expect(ids("xylophone tuning")).toEqual([]);
  });
});

describe("the time zone and currency a new business starts with", () => {
  it("picks the currency from the time zone, US dollars when it can't tell", () => {
    expect(currencyFor("America/New_York")).toBe("USD");
    expect(currencyFor("America/Toronto")).toBe("CAD");
    expect(currencyFor("America/Vancouver")).toBe("CAD");
    expect(currencyFor("Australia/Sydney")).toBe("AUD");
    expect(currencyFor("Pacific/Auckland")).toBe("NZD");
    expect(currencyFor("Europe/London")).toBe("GBP");
    expect(currencyFor("Europe/Dublin")).toBe("EUR");
    expect(currencyFor("Africa/Johannesburg")).toBe("ZAR");
    expect(currencyFor("Asia/Tokyo")).toBe("USD");
  });

  it("names the zone the way people say it, with its city", () => {
    expect(zoneLabel("America/New_York")).toBe("Eastern time (New York)");
    expect(zoneLabel("America/Los_Angeles")).toBe("Pacific time (Los Angeles)");
    expect(zoneLabel("Not/A_Zone")).toBe("A Zone");
  });
});
