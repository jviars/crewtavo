/** A category's look where it has no photo (features/kb/GuideCover.tsx): a flat color and a subject icon. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { categoryLook } from "../src/features/kb/GuideCover";

describe("categoryLook", () => {
  it("picks a subject icon from the category's name, a book when nothing fits", () => {
    expect(categoryLook("Safety", 0)?.icon).toBe("alert");
    expect(categoryLook("Equipment and trucks", 1)?.icon).toBe("truck");
    expect(categoryLook("Snow and ice", 2)?.icon).toBe("snow");
    expect(categoryLook("Paving", 3)?.icon).toBe("paving");
    expect(categoryLook("Holidays", 4)?.icon).toBe("book");
  });

  it("gives neighbours different colors, and nothing to a guide with no category", () => {
    const colors = [0, 1, 2, 3].map((i) => categoryLook("Office", i)!.color);
    expect(new Set(colors).size).toBe(4);
    expect(categoryLook(null, 0)).toBeNull();
    expect(categoryLook("Office", -1)).toBeNull();
  });
});

describe("a guide shared by link", () => {
  const page = readFileSync(new URL("../src/features/public/SharedGuidePage.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/features/kb/kb.module.css", import.meta.url), "utf8");

  it("wears the business's color from the client kit (its navy when it has none), never Crewtavo's green", () => {
    expect(page).toContain("style={brandStyle(d?.company.color)}");
    expect(page).toContain("<ClientHeader");
    expect(page).not.toMatch(/#3b7d23/i);
  });

  it("draws its links and focus in the color's readable shade", () => {
    expect(css).toMatch(/\.shared \.article :global\(a:not\(\.heading-anchor\)\) \{ color: var\(--brand-words/);
    expect(css).toMatch(/\.shared \{ --focus-ring: var\(--brand-words/);
  });
});

describe("reading a guide", () => {
  const css = readFileSync(new URL("../src/features/kb/kb.module.css", import.meta.url), "utf8");
  const editor = readFileSync(new URL("../src/styles/features.css", import.meta.url), "utf8");

  it("reads and is written at KB-Guide's larger 18px", () => {
    expect(css).toMatch(/\.article \{[^}]*font-size: var\(--fs-18, 18px\)/);
    expect(editor).toMatch(/\.rte\[data-layout="page"\] \.rte-body \{[^}]*font-size: var\(--fs-18, 18px\)/);
  });
});
