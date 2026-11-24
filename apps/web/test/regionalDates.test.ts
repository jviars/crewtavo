/** Dates and times on screens follow the business's country (core regional.ts); numbers and money don't. */
import { afterEach, describe, expect, it } from "vitest";
import { dateLocale, formatDate, formatDateTime, formatDay, formatMoneyCents, formatNumber, formatTime, setCountry, setCurrency } from "../src/lib/format";
import { longDate, shortDate } from "../src/features/documents/words";
import { dayWords, shortDate as chartDay } from "../src/features/finance/range";
import { whenText } from "../src/features/roofing/estimate/rows";

afterEach(() => {
  setCountry({ country: "US" });
  setCurrency("USD");
});

describe("dates on screens", () => {
  it("are as a US business has always seen them", () => {
    setCountry({ country: "US" });
    expect(dateLocale()).toBe("en-US");
    expect(formatDate("2026-10-16")).toBe("Oct 16, 2026");
    expect(formatTime("2026-10-16T14:05:00Z", "UTC")).toBe("2:05 PM");
  });

  it("are day first, on a 24-hour clock, for a business in the UK", () => {
    setCountry({ country: "GB" });
    expect(formatDate("2026-10-16")).toBe("16 Oct 2026");
    expect(formatDay("2026-10-16T12:00:00")).toBe("Fri 16 Oct");
    expect(formatTime("2026-10-16T14:05:00Z", "UTC")).toBe("14:05");
    expect(formatDateTime("2026-10-16T14:05:00Z", "UTC")).toBe("Fri 16 Oct, 14:05");
  });

  it("are month first with a.m. and p.m. in Canada, day first with am and pm in Australia", () => {
    setCountry({ country: "CA" });
    expect([formatDate("2026-10-16"), formatTime("2026-10-16T14:05:00Z", "UTC")]).toEqual(["Oct 16, 2026", "2:05 p.m."]);
    setCountry({ country: "AU" });
    expect([formatDate("2026-10-16"), formatTime("2026-10-16T14:05:00Z", "UTC")]).toEqual(["16 Oct 2026", "2:05 pm"]);
  });

  it("leave numbers and money as they were, whatever the country", () => {
    setCountry({ country: "DE" });
    setCurrency("EUR");
    expect(formatNumber(1234.5, 1)).toBe("1,234.5");
    expect(formatMoneyCents(1234.5)).toBe("€1,234.50");
  });
});

describe("the screens' own date words", () => {
  it("are as before in the US", () => {
    expect(chartDay("2026-10-16")).toBe("Oct 16");
    expect(dayWords("2026-10-14", "2026-10-16")).toBe("Wed, Oct 14");
    expect(whenText("2026-10-02T14:05:00Z", "UTC", new Date("2026-10-16T12:00:00Z"))).toBe(`Oct 2 at ${formatTime("2026-10-02T14:05:00Z", "UTC")}`);
  });

  it("put the day first, and keep the clock, where the business does", () => {
    setCountry({ country: "GB" });
    expect(chartDay("2026-10-16")).toBe("16 Oct");
    expect(dayWords("2026-10-14", "2026-10-16")).toBe("Wed 14 Oct");
    expect(whenText("2026-10-02T14:05:00Z", "UTC", new Date("2026-10-16T12:00:00Z"))).toBe("2 Oct at 14:05");
  });

  it("on a quote or invoice follow the country they're given, and the US without one (the server's PDF)", () => {
    expect(longDate("2026-10-16")).toBe("October 16, 2026");
    expect(shortDate("2026-10-16")).toBe("Oct 16, 2026");
    expect(longDate("2026-10-16", "GB")).toBe("16 October 2026");
    expect(shortDate("2026-10-24T18:14:00Z", "UTC", "AU")).toBe("24 Oct 2026");
  });
});
