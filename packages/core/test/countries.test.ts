import { describe, expect, it } from "vitest";
import { businessCountry, countryChoices, countryCode, countryFor, countryName, currencyForCountry, FIRST_COUNTRIES, isCountryCode } from "../src/countries";
import { CURRENCIES } from "../src/money";

describe("a business's country", () => {
  it("is guessed from the time zone, as the database guesses it (private.country_for_zone)", () => {
    expect(countryFor("America/New_York")).toBe("US");
    expect(countryFor("America/Phoenix")).toBe("US");
    expect(countryFor("Pacific/Honolulu")).toBe("US");
    expect(countryFor("America/Toronto")).toBe("CA");
    expect(countryFor("America/St_Johns")).toBe("CA");
    expect(countryFor("Europe/London")).toBe("GB");
    expect(countryFor("Europe/Dublin")).toBe("IE");
    expect(countryFor("Australia/Perth")).toBe("AU");
    expect(countryFor("Pacific/Auckland")).toBe("NZ");
    expect(countryFor("Africa/Johannesburg")).toBe("ZA");
    expect(countryFor("Europe/Berlin")).toBe("DE");
    expect(countryFor("Atlantic/Canary")).toBe("ES");
    expect(countryFor("Europe/Sofia")).toBe("BG");
    expect(countryFor("Asia/Tokyo")).toBe("US");
    expect(countryFor(null)).toBe("US");
  });

  it("brings the currency it most likely charges in, always one a business can pick", () => {
    expect(currencyForCountry("US")).toBe("USD");
    expect(currencyForCountry("CA")).toBe("CAD");
    expect(currencyForCountry("GB")).toBe("GBP");
    expect(currencyForCountry("IE")).toBe("EUR");
    expect(currencyForCountry("BG")).toBe("EUR");
    expect(currencyForCountry("MC")).toBe("EUR");
    expect(currencyForCountry("JP")).toBe("USD");
    for (const c of countryChoices()) expect(CURRENCIES.some((x) => x.code === currencyForCountry(c.code))).toBe(true);
  });

  it("is a known two-letter code, in either case", () => {
    expect(isCountryCode("gb")).toBe(true);
    expect(countryCode(" ca ")).toBe("CA");
    expect(countryCode("UK")).toBeNull();
    expect(countryCode("USA")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });

  it("is listed with the usual ones first, then by name", () => {
    const list = countryChoices();
    expect(list.slice(0, FIRST_COUNTRIES.length).map((c) => c.code)).toEqual([...FIRST_COUNTRIES]);
    expect(new Set(list.map((c) => c.code)).size).toBe(list.length);
    const rest = list.slice(FIRST_COUNTRIES.length).map((c) => c.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
    expect(countryName("GB")).toBe("United Kingdom");
  });

  it("is the one chosen, or the guess from the time zone where it isn't known (a sub's basics)", () => {
    expect(businessCountry({ country: "GB", timezone: "America/New_York" })).toBe("GB");
    expect(businessCountry({ timezone: "America/Vancouver" })).toBe("CA");
    expect(businessCountry({ country: "xx", timezone: "Europe/London" })).toBe("GB");
    expect(businessCountry(null)).toBe("US");
  });
});
