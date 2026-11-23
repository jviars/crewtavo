/**
 * Menus (components/ui/Menu.tsx, with its decisions in menuModel.ts): which entries show, a phone's
 * sheet stepping into a sub menu and back, where a desktop flyout goes, the keys, and letting go of a
 * dragged sheet. The look is checked against components.css: 13px rows on a desktop, a sheet on a phone.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Menu } from "../src/components/ui/Menu";
import { flyoutPlacement, hasActions, itemRole, nextIndex, sheetDismissed, sheetLevel, SHEET_QUERY, shortcutIndex, visibleEntries, type MenuEntry } from "../src/components/ui/menuModel";

const noop = () => undefined;
const labels = (entries: MenuEntry[]) => entries.map((e) => ("separator" in e ? "—" : "heading" in e ? `#${e.heading}` : e.label));

const REQUEST: MenuEntry[] = [
  { label: "Open request", kbd: "↵", onSelect: noop },
  {
    label: "Assign to",
    kbd: "A",
    end: "Nobody yet",
    items: [
      { label: "Nobody yet", checked: true, onSelect: noop },
      { separator: true },
      { label: "Luis Ortega", end: "Estimator", checked: false, onSelect: noop },
      { label: "Dana Kim", end: "Office", checked: false, onSelect: noop, hidden: true },
    ],
  },
  { label: "Book assessment", kbd: "B", onSelect: noop },
  { separator: true },
  { label: "Copy link", onSelect: noop, hidden: true },
  { separator: true },
  { label: "Archive", kbd: "E", danger: true, onSelect: noop },
];

describe("the entries a menu shows", () => {
  it("leaves out hidden ones, and a separator that would sit at an end or next to another", () => {
    expect(labels(visibleEntries(REQUEST))).toEqual(["Open request", "Assign to", "Book assessment", "—", "Archive"]);
    expect(labels(visibleEntries([{ separator: true }, { label: "A", onSelect: noop }, { separator: true }]))).toEqual(["A"]);
  });

  it("drops a heading with nothing under it, and a sub menu with nothing in it to pick", () => {
    const entries: MenuEntry[] = [
      { heading: "Create" },
      { label: "Hidden", onSelect: noop, hidden: true },
      { separator: true },
      { label: "Empty", items: [{ label: "Gone", onSelect: noop, hidden: true }] },
      { label: "Kept", onSelect: noop },
    ];
    expect(labels(visibleEntries(entries))).toEqual(["Kept"]);
    expect(hasActions([{ heading: "Only a heading" }])).toBe(false);
    expect(hasActions([{ label: "Sub", items: [{ label: "One", onSelect: noop }] }])).toBe(true);
  });

  it("tidies a sub menu's own entries the same way", () => {
    const assign = visibleEntries(REQUEST)[1]!;
    expect("items" in assign && labels(assign.items)).toEqual(["Nobody yet", "—", "Luis Ortega"]);
  });
});

describe("an item's role", () => {
  it("is a plain item, a radio (a check on the right, closes the menu) or a check box (stays open)", () => {
    expect(itemRole({ label: "Open", onSelect: noop })).toBe("menuitem");
    expect(itemRole({ label: "Dana", checked: false, onSelect: noop })).toBe("menuitemradio");
    expect(itemRole({ label: "HOA", checked: true, checkbox: true, onSelect: noop })).toBe("menuitemcheckbox");
  });
});

describe("the phone's sheet", () => {
  it("shows the top level, then a sub menu's entries under its name, and back again", () => {
    expect(sheetLevel(REQUEST, [])).toMatchObject({ title: undefined, path: [] });
    const sub = sheetLevel(REQUEST, [1]);
    expect(sub.title).toBe("Assign to");
    expect(sub.path).toEqual([1]);
    expect(labels(sub.entries)).toEqual(["Nobody yet", "—", "Luis Ortega"]);
  });

  it("goes back as far as it can when the entries changed under it", () => {
    // Index 0 is an action, not a sub menu, and 9 isn't there at all.
    expect(sheetLevel(REQUEST, [0]).path).toEqual([]);
    expect(sheetLevel(REQUEST, [1, 9])).toMatchObject({ title: "Assign to", path: [1] });
  });

  it("is let go of when pulled down far, or flicked down past a short way", () => {
    expect(sheetDismissed(120, 0)).toBe(true);
    expect(sheetDismissed(40, 1)).toBe(true);
    expect(sheetDismissed(40, 0.2)).toBe(false);
    expect(sheetDismissed(10, 2)).toBe(false);
  });

  it("is what a menu is on a phone's width, where the rest of the shell is the phone's too (not on a wide touch screen)", () => {
    expect(SHEET_QUERY).toBe("(max-width: 900px)");
    // Help and Notifications ask the same question, so the shell never mixes a desktop popover with a phone's sheet.
    expect(readFileSync(new URL("../src/components/shell/Help.tsx", import.meta.url), "utf8")).toContain("window.matchMedia(SHEET_QUERY).matches");
  });
});

describe("keys", () => {
  it("wrap at the ends, and Home and End go to them", () => {
    expect(nextIndex(4, 3, "ArrowDown")).toBe(0);
    expect(nextIndex(4, 0, "ArrowUp")).toBe(3);
    expect(nextIndex(4, -1, "ArrowDown")).toBe(0);
    expect(nextIndex(4, -1, "ArrowUp")).toBe(3);
    expect(nextIndex(4, 2, "Home")).toBe(0);
    expect(nextIndex(4, 0, "End")).toBe(3);
    expect(nextIndex(0, 0, "ArrowDown")).toBe(-1);
  });

  it("pick the item or open the sub menu whose key hint they are, in either case", () => {
    const shown = visibleEntries(REQUEST);
    expect(shortcutIndex(shown, "b")).toBe(2);
    expect(shortcutIndex(shown, "A")).toBe(1);
    expect(shortcutIndex(shown, "z")).toBe(-1);
    // A hint longer than one key is only a hint, and Space is the item's own key.
    expect(shortcutIndex(shown, "Enter")).toBe(-1);
    expect(shortcutIndex([{ label: "Space", kbd: " ", onSelect: noop }], " ")).toBe(-1);
    expect(shortcutIndex([{ label: "Off", kbd: "E", disabled: true, onSelect: noop }], "e")).toBe(-1);
  });
});

describe("a flyout", () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const viewport = { width: 1280, height: 800 };
  const size = { width: 236, height: 200 };

  it("opens to the right of its menu, its first item level with the item that opened it", () => {
    const spot = flyoutPlacement(box(600, 150, 250, 220), box(605, 186, 240, 32), size, viewport);
    expect(spot).toEqual({ left: 854, top: 181, side: "right" });
  });

  it("opens to the left when there's no room on the right", () => {
    const spot = flyoutPlacement(box(1000, 150, 250, 220), box(1005, 186, 240, 32), size, viewport);
    expect(spot.side).toBe("left");
    expect(spot.left).toBe(1000 - 4 - 236);
  });

  it("stays inside the window at the bottom", () => {
    const spot = flyoutPlacement(box(600, 500, 250, 290), box(605, 740, 240, 32), size, viewport);
    expect(spot.top).toBe(800 - 8 - 200);
  });
});

describe("the look", () => {
  const css = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

  it("is 13px items on 32px rows, sentence-case labels and inset separators on a desktop", () => {
    expect(css).toMatch(/\.menu-item \{[^}]*height: 32px;[^}]*font-size: var\(--fs-13\);/);
    expect(rule(".menu-label")).not.toContain("uppercase");
    expect(rule(".menu-sep")).toContain("margin: 4px 8px");
  });

  it("is a bottom sheet on a phone, with 52px rows, 16px words and room for the home indicator", () => {
    expect(rule(".menu[data-sheet] .menu-item")).toContain("min-height: 52px");
    expect(rule(".menu[data-sheet] .menu-item")).toContain("font-size: var(--fs-16)");
    expect(css).toMatch(/\.menu\[data-sheet\] \{[^}]*env\(safe-area-inset-bottom\)/);
    expect(css).toContain(".menu[data-sheet]::backdrop {");
  });
});

describe("a filter's popover (a menu with a search field and a foot)", () => {
  const css = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";
  const tags = (value: string, items: MenuEntry[]) =>
    renderToStaticMarkup(createElement(Menu, { items, label: "Any tag", search: { value, onChange: noop, placeholder: "Find a tag" }, footer: { text: "2 tags", action: { label: "Clear", onSelect: noop } } }));

  it("has a named field over the items, and its foot's action is a menu item the arrows reach", () => {
    const html = tags("", [{ label: "Residential", end: "6", checkbox: true, checked: true, onSelect: noop }]);
    expect(html).toMatch(/<input class="menu-search-input" type="search" aria-label="Find a tag" placeholder="Find a tag"/);
    expect(html).toContain('role="menuitemcheckbox" aria-checked="true"');
    expect(html).toMatch(/<div class="menu-foot" role="none"><span class="menu-foot-text">2 tags<\/span><button type="button" role="menuitem" class="menu-foot-action">Clear<\/button><\/div>/);
  });

  it("stays open, saying so, while what's typed matches nothing", () => {
    const html = tags("zzz", []);
    expect(html).toContain("menu-search-input");
    expect(html).toContain('<div class="menu-empty" role="none">No results for “zzz”</div>');
    // Without a search field, a menu with nothing in it isn't drawn at all.
    expect(renderToStaticMarkup(createElement(Menu, { items: [] }))).toBe("");
  });

  it("is 268px wide, with a 40px field on a hairline and an 11px quiet foot, as polish.css's .pop", () => {
    expect(rule(".menu:has(> .menu-search)")).toContain("width: 268px");
    expect(rule(".menu-search")).toMatch(/height: 40px;.*border-bottom: 1px solid var\(--divider\)/);
    expect(rule(".menu-foot")).toMatch(/border-top: 1px solid var\(--divider\).*color: var\(--quiet\); font-size: var\(--fs-11\)/);
  });
});
