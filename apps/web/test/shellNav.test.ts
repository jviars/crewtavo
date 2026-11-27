/**
 * The shell's navigation (components/shell): the phone's five tabs, the keys that go to a screen or
 * start something from anywhere (G S, N R), and how a notification reads at a glance (its tone and
 * its short time).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellSkeleton } from "../src/components/ui/Skeleton";
import { CHAT_OFF_TAB, createItems, foldedGroups, MOBILE_TABS, mobileTabs, NAV_GROUPS, saveFoldedGroups, shortcutTarget } from "../src/components/shell/nav";
import { noticeTone, shortWhen } from "../src/components/shell/Notifications";

const chatOn = { team_chat: { enabled: true } };
const person = (role: string, permissions: string[] = [], settings: Record<string, unknown> = chatOn) => ({ role, permissions, company: { settings } });

describe("the phone's tab bar", () => {
  it("is Home, My day, Schedule and Chat, with More after them: five in all", () => {
    expect(mobileTabs(person("owner")).map((t) => t.label)).toEqual(["Home", "My day", "Schedule", "Chat"]);
    expect(MOBILE_TABS.some((t) => t.to === "/clients")).toBe(false);
  });

  it("puts Clients in Chat's place while the business has team chat off, so it still has five", () => {
    expect(mobileTabs(person("office", [], {})).map((t) => t.to)).toEqual(["/", "/field", "/schedule", "/clients"]);
    expect(mobileTabs(person("office", [], {}))[3]).toBe(CHAT_OFF_TAB);
  });
});

describe("keyboard shortcuts", () => {
  it("go to a screen after G, by the key search shows beside it", () => {
    const owner = person("owner");
    expect(shortcutTarget(owner, "g", "s")).toBe("/schedule");
    expect(shortcutTarget(owner, "G", "I")).toBe("/invoices");
    expect(shortcutTarget(owner, "g", "t")).toBe("/chat");
    expect(shortcutTarget(owner, "g", "z")).toBeNull();
  });

  it("only go where the person can: no Invoices for a field crew, no Team chat while it's off", () => {
    expect(shortcutTarget(person("field_crew"), "g", "i")).toBeNull();
    expect(shortcutTarget(person("field_crew"), "g", "d")).toBe("/field");
    expect(shortcutTarget(person("owner", [], {}), "g", "t")).toBeNull();
  });

  it("start something after N, by the Create menu's own key", () => {
    const owner = person("owner");
    expect(shortcutTarget(owner, "n", "r")).toBe("/requests?new=1");
    expect(shortcutTarget(owner, "n", "c")).toBe("/clients?new=1");
    expect(shortcutTarget(owner, "n", "j")).toBe("/jobs?new=1");
    expect(shortcutTarget(person("estimator", []), "n", "j")).toBeNull();
    expect(shortcutTarget(person("field_crew"), "n", "q")).toBeNull();
    expect(shortcutTarget(owner, "x", "r")).toBeNull();
  });

  it("never give two screens or two Create items the same key", () => {
    const go = NAV_GROUPS.flat().flatMap((item) => (item.go ? [item.go] : []));
    expect(new Set(go).size).toBe(go.length);
    const keys = createItems({ role: "owner", permissions: [] }).map((item) => item.key);
    expect(keys).toEqual(["C", "R", "Q", "J", "I", "M", "V"]);
  });
});

describe("the Create menu", () => {
  it("lists the work in the order of its stages, then the tools", () => {
    const items = createItems({ role: "owner", permissions: [] });
    expect(items.map((item) => item.label)).toEqual(["Client", "Request", "Quote", "Job", "Invoice", "Measurement", "Visit or task"]);
    expect(items.filter((item) => item.tool).map((item) => item.label)).toEqual(["Measurement", "Visit or task"]);
  });
});

describe("folded sidebar groups", () => {
  afterEach(() => vi.unstubAllGlobals());
  const memory = () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
  };

  it("are none until someone folds one, and are remembered for that person only", () => {
    memory();
    expect(foldedGroups("ana")).toEqual([]);
    saveFoldedGroups("ana", ["Trades"]);
    expect(foldedGroups("ana")).toEqual(["Trades"]);
    expect(foldedGroups("ben")).toEqual([]);
  });

  it("fall back to all open when storage is off or holds something else", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(foldedGroups("ana")).toEqual([]);
    expect(() => saveFoldedGroups("ana", ["Work"])).not.toThrow();
    memory();
    localStorage.setItem("crewtavo.nav-folded.ana", "{oops");
    expect(foldedGroups("ana")).toEqual([]);
  });
});

describe("the sidebar closed to its icons", () => {
  const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  /** A selector's own declarations, from the rule that starts a line with it. */
  const rule = (selector: string) => new RegExp(`^${selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m").exec(base)?.[1] ?? "";

  it("doesn't scroll sideways: a faded count takes no room there, and the links only scroll up and down", () => {
    // A count is invisible but still as wide as its number, which made the 59px column 88px wide inside.
    expect(rule('.shell[data-sidebar="closed"] .sidebar :is(.nav-count, .nav-dot)')).toMatch(/position:\s*absolute/);
    expect(rule(".nav-scroll")).toMatch(/overflow-x:\s*hidden/);
  });

  describe("while the app loads", () => {
    afterEach(() => vi.unstubAllGlobals());
    const saved = (value: string | null) => vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "crewtavo.sidebar-closed" ? value : null) });
    const bars = (html: string) => html.split("<aside")[1]!.split("</aside>")[0]!.split('class="skeleton"').length - 1;

    it("outlines a closed sidebar closed, so it doesn't show wide and snap narrow", () => {
      saved("1");
      const html = renderToStaticMarkup(createElement(ShellSkeleton));
      expect(html).toContain('<div class="shell skeleton-wrap" data-sidebar="closed"');
      // The logo and an icon a link, with no bars for the words beside them.
      expect(bars(html)).toBe(12);
    });

    it("outlines it open otherwise, and when storage is off", () => {
      saved(null);
      const open = renderToStaticMarkup(createElement(ShellSkeleton));
      expect(open).not.toContain("data-sidebar");
      expect(bars(open)).toBe(24);
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
      expect(renderToStaticMarkup(createElement(ShellSkeleton))).not.toContain("data-sidebar");
    });
  });

  it("keeps a dot on the icon of a link that has a count", () => {
    expect(rule('.shell[data-sidebar="closed"] .sidebar .nav-link:has(.nav-count, .nav-dot)::after')).toContain("border-radius: 50%");
  });
});

describe("a notification at a glance", () => {
  it("is green for good news, red for what needs someone, and plain otherwise", () => {
    expect(noticeTone("quote", "Quote #88 approved")).toBe("good");
    expect(noticeTone("invoice", "Invoice #212 is past due")).toBe("bad");
    expect(noticeTone("equipment", "Check tires is overdue on Lowboy trailer")).toBe("bad");
    expect(noticeTone("security", "A new sign-in")).toBe("bad");
    expect(noticeTone("hosting", "Storage is nearly full")).toBe("warn");
    expect(noticeTone("request", "New request from Priya Shah")).toBeUndefined();
  });

  it("says when in a few characters: minutes, hours, then the weekday or the date", () => {
    const now = Date.parse("2026-11-21T18:00:00Z");
    expect(shortWhen("2026-11-21T17:59:30Z", now)).toBe("just now");
    expect(shortWhen("2026-11-21T17:55:00Z", now)).toBe("5m");
    expect(shortWhen("2026-11-21T16:00:00Z", now)).toBe("2h");
    expect(shortWhen("2026-11-05T12:00:00Z", now)).toBe("Nov 5");
  });
});
