/** "Opened 2h ago" on a quote's or an invoice's page, and the first time on hover (features/quotes/OpenedWhen.tsx). */
import { describe, expect, it } from "vitest";
import { firstOpenedWords } from "../src/features/quotes/OpenedWhen";

describe("when a client first opened a quote", () => {
  // 9:30 in the evening on October 16 in New York, which is already the 17th in UTC and in London.
  const firstAt = "2026-10-17T01:30:00Z";

  it("is the day it was where the business is, wherever the browser is", () => {
    expect(firstOpenedWords(firstAt, "America/New_York")).toBe("First opened Oct 16, 2026");
    expect(firstOpenedWords(firstAt, "Europe/London")).toBe("First opened Oct 17, 2026");
    expect(firstOpenedWords("2026-10-16T12:00:00Z", "America/Los_Angeles")).toBe("First opened Oct 16, 2026");
  });
});
