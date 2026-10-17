import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ supabase: () => ({}) }));
const { uploadBody } = await import("../src/lib/files");
const { dateIn, formatDateTime, formatTime } = await import("../src/lib/format");

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
