/**
 * The Client Hub's look: the business's own color, never Crewtavo's green, and buttons that can't be
 * pressed yet looking it (the shared .btn:disabled rule must still win inside the Hub).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../src/features/hub/HubPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/features.css", import.meta.url), "utf8");
const hub = css.slice(css.indexOf("Customer portal (Client Hub)"), css.indexOf("/* ---------- Jobs and equipment"));

describe("the Client Hub's colors", () => {
  it("falls back to the navy the paper prints in, not Crewtavo's green, for a business with no brand color", () => {
    expect(page).toContain("const brand = documentColor({ color: null }, { branding: d?.company.branding ?? null });");
    expect(page).not.toContain('"#3b7d23"');
  });

  it("keeps its button colors no more specific than .btn:disabled, so a disabled Approve or Send looks disabled", () => {
    expect(hub).toContain(".hub .btn-primary { background: var(--brand);");
    expect(hub).not.toMatch(/\.hub :is\([^)]*\.btn-primary/);
    expect(hub).toContain(".hub .btn:not(:where(.btn-primary, .btn-ghost, .btn-danger, .btn-danger-solid)) {");
  });

  it("colors links in its words with the business's color", () => {
    expect(hub).toMatch(/\.hub :is\(\.hub-visit-text, \.callout, \.hub-review, \.hub-terms-read\) a:not\(\.btn\) \{ color: var\(--brand-text\);/);
  });
});
