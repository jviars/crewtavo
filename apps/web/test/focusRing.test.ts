/**
 * Keyboard focus is clearly visible on every button, in both themes (WCAG 2.1 SC 1.4.11 and 2.4.7):
 * a 2px outline at least 3:1 against what's around it, which no screen's own stylesheet can turn
 * off. The colours are read from the stylesheets themselves (styles/tokens.css, and the Radix
 * scales the dark theme is made of), so a change of palette that breaks it fails here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const tokens = read("styles/tokens.css");
const base = read("styles/base.css");
const components = read("styles/components.css");

// --- colours ---------------------------------------------------------------------------------
type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const h = value.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** A colour at `alpha` over a background, as a glow drawn with rgba() ends up. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((c, i) => Math.round(c * alpha + under[i]! * (1 - alpha))) as Rgb;

/** The Radix dark scales the dark theme points at. */
const require = createRequire(import.meta.url);
const radix = ["sand", "grass"].map((scale) => readFileSync(require.resolve(`@radix-ui/colors/${scale}-dark.css`), "utf8")).join("\n");
const radixValue = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(radix)![1]!;

const light = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root.dark {"));
const dark = tokens.slice(tokens.indexOf(":root.dark {"));
/** A token's colour in a theme: its hex, or the Radix step it names. */
function token(theme: "light" | "dark", name: string): Rgb {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(theme === "light" ? light : dark)?.[1]?.trim();
  if (!value) throw new Error(`No --${name} in the ${theme} theme`);
  const step = /^var\(--([a-z]+-\d+)\)$/.exec(value);
  return hex(step ? radixValue(step[1]!) : value);
}

/** Everything a button sits on: the page, cards, menus and the phone's sheets, the sidebar, and the fills behind rows and hovers. */
const SURFACES = ["page", "surface", "ground", "fill", "fill-2", "fill-3", "green-tint", "menu", "menu-hi", "m-sheet"];

describe("the keyboard focus outline", () => {
  it("is the app's green, 2px wide and set off from the control, unless a screen gives its own colour", () => {
    expect(base).toContain(":focus-visible { outline: 2px solid var(--focus-ring, var(--green)); outline-offset: 2px; }");
  });

  it("is at least 3:1 against every surface a button sits on, in the light theme and the dark", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const surface of SURFACES) {
        const ratio = contrast(token(theme, "green"), token(theme, surface));
        expect(ratio, `--green on --${surface} (${theme}): ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
    // The light theme's green on white (a shade darker than the audit's 5.07, for green words on the phone's ground).
    expect(contrast(token("light", "green"), hex("#ffffff"))).toBeCloseTo(5.2, 1);
  });

  it("replaces a glow that was far too faint to count", () => {
    // --ring in the light theme: rgba(59, 125, 35, 0.22) over a white page.
    expect(light).toContain("--ring: 0 0 0 3px rgba(59, 125, 35, 0.22);");
    expect(contrast(over([59, 125, 35], 0.22, [255, 255, 255]), [255, 255, 255])).toBeLessThan(1.5);
  });

  it("can't be turned off for anything that's pressed, by any screen's stylesheet", () => {
    const floor = /:is\(([^{]*)\):focus-visible \{\s*outline: 2px solid var\(--focus-ring, var\(--green\)\) !important;\s*\}/.exec(base);
    expect(floor).not.toBeNull();
    for (const pressed of ["button", "a", "summary", '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]', '[type="checkbox"]', '[type="radio"]', '[type="file"]']) {
      expect(floor![1], pressed).toContain(pressed);
    }
    // Text fields aren't in it: they show focus with a green border, and take it on a click too.
    expect(floor![1]).not.toMatch(/textarea|select|type="text"/);
    // The buttons themselves no longer ask for it to go.
    expect(components).toContain(".btn:focus-visible { box-shadow: var(--ring); }");
    expect(components).not.toMatch(/\.btn:focus-visible \{[^}]*outline: none/);
  });

  it("is still there on the screens whose own stylesheets take the outline off a button", () => {
    // What used to leave only the glow: each of these is a button, a link or a tab, so the rule above covers it.
    const sheets = [...["styles/components.css", "styles/features.css"], ...moduleSheets()].map((path) => [path, read(path)] as const);
    const hiding = sheets.flatMap(([path, css]) => [...css.matchAll(/([^{}]*):focus-visible[^{]*\{[^}]*outline: none[^}]*\}/g)].map(() => path));
    // There are many, in screens this didn't touch: the floor is what makes them visible.
    expect(hiding.length).toBeGreaterThan(20);
    expect(base).toContain("!important");
  });

  it("shows on a label that stands in for a file picker or a choice, whose own input is out of sight", () => {
    expect(base).toContain("label:is(.btn, .hub-choice):has(input:focus-visible) { outline: 2px solid var(--focus-ring, var(--green)); outline-offset: 2px; }");
  });

  it("is the panel's own text colour on the app's dark panels, and white in the photo editor", () => {
    expect(base).toContain(".toast, .restart-banner, .task-island-pill, .task-island-list { --focus-ring: var(--on-solid); }");
    expect(base).toContain(".photo-editor, .hub-refer { --focus-ring: #fff; }");
    for (const theme of ["light", "dark"] as const) expect(contrast(token(theme, "on-solid"), token(theme, "solid")), theme).toBeGreaterThanOrEqual(3);
    // The photo editor is #151515 around the photo and #202020 in its bars, whatever the theme.
    for (const panel of ["#151515", "#202020"]) expect(contrast(hex("#ffffff"), hex(panel))).toBeGreaterThanOrEqual(3);
    // The green would not have done on the dark panels of the light theme.
    expect(contrast(token("light", "green"), token("light", "solid"))).toBeLessThan(3);
  });

  it("is drawn inside a control that sits in something that clips its edges", () => {
    expect(base).toContain(".menu-item:focus-visible, .imagery-option:focus-visible, .thumb :focus-visible { outline-offset: -2px; }");
    expect(components).toContain(".menu-item:hover, .menu-item:focus-visible { background: var(--menu-hi); color: var(--ink); }");
  });
});

function moduleSheets(dir = "features"): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? moduleSheets(`${dir}/${e.name}`) : e.name.endsWith(".css") ? [`${dir}/${e.name}`] : []));
}
