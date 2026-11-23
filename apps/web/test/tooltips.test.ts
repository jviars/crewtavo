/** The tooltip layer lifts a title and puts back exactly what it found (components/ui/titles.ts). */
import { describe, expect, it } from "vitest";
import { liftTitle, restoreTitle, tipAdds, titleText, type TitleHost } from "@/components/ui/titles";

/** Just enough of an element: its attributes and its words. */
function element(attrs: Record<string, string>, text = ""): TitleHost & { attrs: Map<string, string> } {
  const map = new Map(Object.entries(attrs));
  return {
    attrs: map,
    textContent: text,
    getAttribute: (name) => map.get(name) ?? null,
    setAttribute: (name, value) => void map.set(name, value),
    removeAttribute: (name) => void map.delete(name),
    hasAttribute: (name) => map.has(name),
  };
}
const TIP = "app-tooltip";

describe("lifting a title", () => {
  it("names an icon button by its title meanwhile, and puts everything back after", () => {
    const button = element({ title: "Delete", class: "btn" });
    const lifted = liftTitle(button, TIP)!;
    expect(Object.fromEntries(button.attrs)).toEqual({ title: "", "data-title": "Delete", "aria-label": "Delete", class: "btn" });
    expect(titleText(button)).toBe("Delete");
    restoreTitle(button, lifted, TIP);
    expect(Object.fromEntries(button.attrs)).toEqual({ title: "Delete", class: "btn" });
  });

  it("describes an element with a name of its own by the tooltip meanwhile, keeping what described it before", () => {
    const button = element({ title: "Why it's off", "aria-describedby": "hint" }, "Refund");
    const lifted = liftTitle(button, TIP)!;
    expect(button.getAttribute("aria-describedby")).toBe(`hint ${TIP}`);
    expect(button.hasAttribute("aria-label")).toBe(false);
    restoreTitle(button, lifted, TIP);
    expect(Object.fromEntries(button.attrs)).toEqual({ title: "Why it's off", "aria-describedby": "hint" });

    const labelled = element({ title: "More actions", "aria-label": "More actions" });
    const again = liftTitle(labelled, TIP)!;
    expect(labelled.getAttribute("aria-describedby")).toBe(TIP);
    restoreTitle(labelled, again, TIP);
    expect(Object.fromEntries(labelled.attrs)).toEqual({ title: "More actions", "aria-label": "More actions" });
  });

  it("leaves what the page changed meanwhile: a new title, or none", () => {
    const renamed = element({ title: "Old" });
    const one = liftTitle(renamed, TIP)!;
    renamed.setAttribute("title", "New");
    restoreTitle(renamed, one, TIP);
    expect(renamed.getAttribute("title")).toBe("New");
    expect(renamed.hasAttribute("data-title")).toBe(false);

    const cleared = element({ title: "Turned off because…" }, "Send");
    const two = liftTitle(cleared, TIP)!;
    cleared.removeAttribute("title");
    restoreTitle(cleared, two, TIP);
    expect(cleared.hasAttribute("title")).toBe(false);
    expect(cleared.hasAttribute("aria-describedby")).toBe(false);
  });

  it("has nothing to lift from an empty title", () => {
    const blank = element({ title: "" });
    expect(liftTitle(blank, TIP)).toBeNull();
    expect(Object.fromEntries(blank.attrs)).toEqual({ title: "" });
  });
});

describe("whether a tooltip adds anything", () => {
  it("not when the title only repeats the words shown, unless they're cut off", () => {
    const name = element({ title: "Jane  Doe" }, " Jane Doe ");
    expect(tipAdds(name, "Jane  Doe")).toBe(false);
    expect(tipAdds(name, "Jane  Doe", true)).toBe(true);
    expect(tipAdds(element({}, "Today"), "Nov 19, 2026")).toBe(true);
    expect(tipAdds(element({}), "   ")).toBe(false);
  });
});
