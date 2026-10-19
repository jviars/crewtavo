import { describe, expect, it } from "vitest";
import {
  areasForRole,
  describeAssistantAccess,
  markdownToGuide,
  mayChange,
  memberPermissions,
  normalizeChecklist,
  normalizeIntakeForm,
  toAssistantAccess,
} from "../src";

describe("assistant access", () => {
  it("only reads unless it's been given more", () => {
    expect(toAssistantAccess(null)).toEqual({ level: "read", areas: [] });
    expect(toAssistantAccess({ level: "nonsense", areas: ["prices"] })).toEqual({ level: "read", areas: [] });
    expect(mayChange(toAssistantAccess(null), "records")).toBe(false);
  });

  it("changes chosen areas, but doesn't delete", () => {
    const access = toAssistantAccess({ level: "areas", areas: ["prices", "crews", "unknown"] });
    expect(access.areas).toEqual(["prices", "crews"]);
    expect(mayChange(access, "prices")).toBe(true);
    expect(mayChange(access, "automations")).toBe(false);
    expect(mayChange(access, "prices", true)).toBe(false);
    expect(describeAssistantAccess(access)).toBe("Can change: Price list, Crews");
  });

  it("full access changes and deletes everything", () => {
    const access = toAssistantAccess({ level: "full", areas: [] });
    expect(mayChange(access, "guides", true)).toBe(true);
    expect(describeAssistantAccess(access)).toBe("Full access");
    expect(describeAssistantAccess({ level: "areas", areas: [] })).toBe("Read only");
  });

  it("offers only what the person's role can change", () => {
    expect(areasForRole("owner", memberPermissions("owner"))).toHaveLength(8);
    expect(areasForRole("office", memberPermissions("office"))).not.toContain("company");
    expect(areasForRole("estimator", memberPermissions("estimator"))).toEqual(["records"]);
    expect(areasForRole("field_crew", memberPermissions("field_crew"))).toEqual([]);
    // A custom office role without guides.
    expect(areasForRole("office", memberPermissions("office", ["settings", "automations"]))).toEqual(["records", "prices", "crews", "checklists", "booking", "automations"]);
  });
});

describe("booking forms", () => {
  it("makes the link, keys and ZIP codes", () => {
    const form = normalizeIntakeForm({
      name: " Spring cleanup ",
      zips: ["24141", " 24141", "24073"],
      questions: [
        { type: "address", label: "Address", required: true },
        { label: " Yard size ", type: "choice", required: true, options: [" Small", "", "Large "] },
        { label: "Yard size", type: "text" },
      ],
    });
    expect(form).toEqual({
      name: "Spring cleanup",
      slug: "spring-cleanup",
      service_area_zips: ["24141", "24073"],
      questions: [
        { key: "yard_size", label: "Yard size", type: "choice", required: true, options: ["Small", "Large"] },
        { key: "yard_size_2", label: "Yard size", type: "text", required: false, options: undefined },
      ],
    });
  });

  it("says what's wrong", () => {
    const base = { name: "Quote", zips: [], questions: [] };
    expect(() => normalizeIntakeForm({ ...base, name: " " })).toThrow("Name the form.");
    expect(() => normalizeIntakeForm(base, ["quote"])).toThrow("Another form already uses that link.");
    expect(() => normalizeIntakeForm({ ...base, zips: ["2414"] })).toThrow("ZIP codes should be 5 digits: 2414");
    expect(() => normalizeIntakeForm({ ...base, questions: [{ label: "Pick", type: "choice" }] })).toThrow("Choice questions need options.");
    expect(() => normalizeIntakeForm({ ...base, questions: [{ label: "Pick", type: "dropdown" }] })).toThrow("Question types are");
  });
});

describe("checklists", () => {
  it("keeps keys unique and tidies items", () => {
    const list = normalizeChecklist({
      name: " Mower check ",
      job_type: " ",
      items: [
        { label: "Blades sharp", type: "check", required: true },
        { key: "blades_sharp", label: "Blades sharp (deck 2)", type: "check" },
        { label: "Oil level", type: "choice", options: ["Full ", " "] },
      ],
    });
    expect(list.name).toBe("Mower check");
    expect(list.job_type).toBeNull();
    expect(list.items.map((i) => i.key)).toEqual(["blades_sharp", "blades_sharp_deck_2", "oil_level"]);
    expect(list.items[2].options).toEqual(["Full"]);
  });

  it("says what's wrong", () => {
    expect(() => normalizeChecklist({ name: "A", items: [] })).toThrow("Add at least one item.");
    expect(() => normalizeChecklist({ name: "A", items: [{ label: " ", type: "check" }] })).toThrow("Every item needs a label.");
    expect(() => normalizeChecklist({ name: "A", items: Array.from({ length: 61 }, (_, i) => ({ label: `Item ${i}`, type: "check" })) })).toThrow("at most 60 items");
  });
});

describe("guides from Markdown", () => {
  it("makes the editor's HTML and plain text", () => {
    const { html, text } = markdownToGuide("# Fueling\n\nUse **non-ethanol** gas, see [the log](https://example.com/log?a=1&b=2).\n\n- Mower\n- Trimmer\n\n1. Shut off\n2. Fill\n\n> Never fuel a hot engine.\n\n---\n\n```\nfuel = 2 gal\n```");
    expect(html).toBe(
      '<h2>Fueling</h2><p>Use <strong>non-ethanol</strong> gas, see <a href="https://example.com/log?a=1&amp;b=2">the log</a>.</p>' +
        "<ul><li><p>Mower</p></li><li><p>Trimmer</p></li></ul><ol><li><p>Shut off</p></li><li><p>Fill</p></li></ol>" +
        "<blockquote><p>Never fuel a hot engine.</p></blockquote><hr><pre><code>fuel = 2 gal</code></pre>",
    );
    expect(text).toBe("Fueling\nUse non-ethanol gas, see the log.\nMower\nTrimmer\nShut off\nFill\nNever fuel a hot engine.\nfuel = 2 gal");
  });

  it("lets no markup through", () => {
    const { html } = markdownToGuide('<script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1)) `<b>` *a* _b_');
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; click) <code>&lt;b&gt;</code> <em>a</em> <em>b</em></p>");
  });
});
