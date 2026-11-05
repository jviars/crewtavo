/**
 * Help beside the bell (components/shell/Help.tsx): each screen opens its own docs page, and Ask
 * Claude or ChatGPT sends the same prompt as the Ask buttons on crewtavo.com/docs.
 */
import { describe, expect, it } from "vitest";
import { askUrl, docsPage } from "../src/components/shell/Help";

describe("docsPage", () => {
  it("finds the page for a screen, a record on it, and a Settings tab", () => {
    expect(docsPage("/", "")).toBe("getting-started/home-screen");
    expect(docsPage("/invoices/8c1d", "")).toBe("billing/invoices");
    expect(docsPage("/settings", "?tab=roles")).toBe("team/roles-and-permissions");
  });
  it("sends a sub to their own guide, and has none for a screen without a page", () => {
    expect(docsPage("/field/paperwork", "", true)).toBe("field/subcontractor-guide");
    expect(docsPage("/field", "")).toBe("field/your-day-in-the-field");
    expect(docsPage("/settings", "")).toBeNull();
    expect(docsPage("/license", "")).toBeNull();
  });
});

describe("askUrl", () => {
  it("attaches the page's Markdown, or the docs index when there's no page", () => {
    expect(decodeURIComponent(askUrl("claude", "billing/invoices", "late fees?"))).toBe(
      "https://claude.ai/new?q=Read https://crewtavo.com/docs/billing/invoices.md and help me with this question about Crewtavo: late fees?",
    );
    expect(askUrl("chatgpt", null, "a & b")).toBe(
      `https://chatgpt.com/?q=${encodeURIComponent("Read https://crewtavo.com/llms.txt and help me with this question about Crewtavo: a & b")}`,
    );
  });
});
