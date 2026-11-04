import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ supabase: () => ({}) }));
const { uploadBody } = await import("../src/lib/files");
const { dateIn, formatDateTime, formatMoney, formatMoneyCents, formatMoneyCompact, formatTime, moneyCurrency, setCurrency, timeZoneChoices } = await import("../src/lib/format");

describe("dates and times in the company's zone", () => {
  it("gives the date where the company is, not the UTC date", () => {
    // 8:30 PM on Oct 16 in New York is 00:30 on Oct 17 in UTC.
    expect(dateIn("2026-10-17T00:30:00Z", "America/New_York")).toBe("2026-10-16");
    expect(dateIn("2026-10-17T00:30:00Z", "UTC")).toBe("2026-10-17");
  });

  it("formats times in the zone it's given", () => {
    expect(formatTime("2026-10-16T13:00:00Z", "America/New_York")).toBe("9:00 AM");
    expect(formatTime("2026-10-16T13:00:00Z", "America/Los_Angeles")).toBe("6:00 AM");
    expect(formatDateTime("2026-10-17T00:30:00Z", "America/New_York")).toBe("Fri, Oct 16, 8:30 PM");
  });
});

describe("money in the business's currency", () => {
  afterEach(() => setCurrency("USD"));

  it("keeps US number style and changes only the symbol", () => {
    expect(formatMoneyCents(1234.5)).toBe("$1,234.50");
    setCurrency("GBP");
    expect(formatMoney(1234.5)).toBe("£1,235");
    expect(formatMoneyCents(1234.5)).toBe("£1,234.50");
    expect(formatMoneyCompact(12_345)).toBe("£12.3K");
    expect(formatMoneyCompact(711)).toBe("£711");
    setCurrency("cad");
    expect(moneyCurrency()).toBe("CAD");
    expect(formatMoneyCents(20)).toBe("CA$20.00");
  });

  it("keeps the last currency for a code that isn't one", () => {
    setCurrency("EUR");
    setCurrency("dollars");
    expect(formatMoneyCents(5)).toBe("€5.00");
    setCurrency(null);
    expect(formatMoneyCents(5)).toBe("$5.00");
  });
});

describe("time zones to pick from", () => {
  it("lists the business's own first, then the US ones, then every other once", () => {
    const zones = timeZoneChoices("Europe/Berlin");
    expect(zones.slice(0, 3)).toEqual(["Europe/Berlin", "America/New_York", "America/Chicago"]);
    expect(zones).toContain("Asia/Tokyo");
    expect(new Set(zones).size).toBe(zones.length);
    expect(timeZoneChoices("America/Chicago")[0]).toBe("America/Chicago");
  });
});

describe("uploads", () => {
  const MB = 1024 * 1024;
  const file = (size: number, type: string) => new File([new Uint8Array(size)], "upload", { type });

  it("checks a photo's size after it's shrunk", async () => {
    const shrunk = new Blob([new Uint8Array(3 * MB)], { type: "image/jpeg" });
    await expect(uploadBody(file(20 * MB, "image/jpeg"), async () => shrunk)).resolves.toBe(shrunk);
    await expect(uploadBody(file(20 * MB, "image/heic"), async (f) => f)).rejects.toThrow("larger than 15 MB");
  });

  it("keeps the limit for other files", async () => {
    const shrink = vi.fn(async (f: File) => f);
    await expect(uploadBody(file(20 * MB, "application/pdf"), shrink)).rejects.toThrow("larger than 15 MB");
    expect(shrink).not.toHaveBeenCalled();
    await expect(uploadBody(file(MB, "application/pdf"), shrink)).resolves.toBeInstanceOf(File);
  });
});
