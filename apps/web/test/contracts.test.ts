/**
 * Contract terms in the staff app: the library's order and moving a section (Settings → Contract
 * terms), the checklists that keep it (the estimate template, a quote's Contract card), the
 * template editor's preview with the sections filled in, what a quote prints and was signed with,
 * the contract editor's smaller set of tools, and where Settings lists it all.
 */
import { contractStarters, STARTER_NOTE } from "@crewtavo/core/contracts";
import { DEFAULT_TEMPLATE, templateSettings } from "@crewtavo/core/documents";
import { getExtensionField, getSchema, type InputRule } from "@tiptap/core";
import { orderedListInputRegex } from "@tiptap/extension-list";
import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { contractExtensions } from "../src/components/ui/editorExtensions";
import { SAMPLE_DOCUMENT } from "../src/features/documents/build";
import type { DocumentData } from "../src/features/documents/types";
import { quoteSections, signedWith } from "../src/features/quotes/QuoteSections";
import {
  applySorts,
  contractPreview,
  contractSummary,
  exampleIds,
  inLibraryOrder,
  moveSection,
  nextSort,
  packagesInOrder,
  pickSection,
  placeLabel,
  sectionSnippet,
  starterRows,
  templatesInOrder,
} from "../src/features/settings/ContractSettings";
import { settingsGroups } from "../src/features/settings/sections";

const PAY = "11111111-1111-4111-8111-111111111111";
const CANCEL = "22222222-2222-4222-8222-222222222222";
const WARRANTY = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

const library = [
  { id: PAY, title: "Payment", body: "<p>Pay {Business name} {Total} by {Date}.</p>", place: "terms", initials: false, sort: 0 },
  { id: CANCEL, title: "Your right to cancel", body: "<p>You can cancel within three business days, {customer name}.</p>", place: "signatures", initials: true, sort: 1 },
  { id: WARRANTY, title: "Warranty", body: "<p>{Warranty}</p><p>{Option}</p>", place: "terms", initials: false, sort: 2 },
];

describe("the order of the contract sections", () => {
  const rows = [
    { id: "a", sort: 0 },
    { id: "b", sort: 1 },
    { id: "c", sort: 2 },
  ];

  it("writes only the two sections that trade places", () => {
    expect(moveSection(rows, "b", -1)).toEqual([
      { id: "b", sort: 0 },
      { id: "a", sort: 1 },
    ]);
    expect(moveSection(rows, "b", 1)).toEqual([
      { id: "c", sort: 1 },
      { id: "b", sort: 2 },
    ]);
  });

  it("numbers every section by its place when the numbers had gaps or repeats", () => {
    const gappy = [
      { id: "a", sort: 0 },
      { id: "b", sort: 0 },
      { id: "c", sort: 7 },
    ];
    expect(moveSection(gappy, "c", -1)).toEqual([
      { id: "c", sort: 1 },
      { id: "b", sort: 2 },
    ]);
  });

  it("does nothing past either end, or for a section that isn't there", () => {
    expect(moveSection(rows, "a", -1)).toEqual([]);
    expect(moveSection(rows, "c", 1)).toEqual([]);
    expect(moveSection(rows, "zzz", 1)).toEqual([]);
  });

  it("shows the list in its new order straight away", () => {
    const moved = applySorts(rows, moveSection(rows, "c", -1));
    expect(moved.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(moved.map((r) => r.sort)).toEqual([0, 1, 2]);
  });

  it("puts a new section at the end", () => {
    expect(nextSort([])).toBe(0);
    expect(nextSort([{ sort: 3 }, { sort: 9 }, { sort: 4 }])).toBe(10);
  });
});

describe("picking sections for a template or a quote", () => {
  it("keeps the library's order, whatever order they were ticked in", () => {
    let ids: string[] = [];
    ids = pickSection(ids, WARRANTY, true, library);
    ids = pickSection(ids, PAY, true, library);
    expect(ids).toEqual([PAY, WARRANTY]);
    expect(pickSection(ids, PAY, false, library)).toEqual([WARRANTY]);
  });

  it("matches ids in any case, keeps each once and leaves out deleted sections", () => {
    expect(inLibraryOrder([WARRANTY.toUpperCase(), GONE, PAY, PAY], library)).toEqual([PAY, WARRANTY]);
    expect(pickSection([GONE, CANCEL], CANCEL.toUpperCase(), false, library)).toEqual([]);
  });

  it("puts every template's sections back in the library's order after a move, and leaves the rest alone", () => {
    const templates = [
      { id: "standard", settings: { ...DEFAULT_TEMPLATE, tagline: "Roofing", sections: [WARRANTY, PAY], invoice_sections: [PAY] } },
      { id: "storm", settings: { ...DEFAULT_TEMPLATE, sections: [PAY, WARRANTY], invoice_sections: [] } },
      { id: "plain", settings: {} },
    ];
    const changed = templatesInOrder(templates, library);
    expect(changed.map((t) => t.id)).toEqual(["standard"]);
    expect(changed[0]!.settings.sections).toEqual([PAY, WARRANTY]);
    expect(changed[0]!.settings.invoice_sections).toEqual([PAY]);
    expect(changed[0]!.settings.tagline).toBe("Roofing");
    // A deleted section comes off too.
    expect(templatesInOrder([{ id: "old", settings: { sections: [PAY, GONE] } }], library)[0]!.settings.sections).toEqual([PAY]);
  });

  it("puts every package's sections back in the library's order after a move, so the options offered from it follow", () => {
    // "Your right to cancel" moved above "Payment".
    const moved = applySorts(library, moveSection(library, CANCEL, -1));
    const packages = [
      { id: "metal", section_ids: [PAY, CANCEL] },
      { id: "shingle", section_ids: [CANCEL, WARRANTY] },
      { id: "plain", section_ids: null },
    ];
    expect(packagesInOrder(packages, moved)).toEqual([{ id: "metal", section_ids: [CANCEL, PAY] }]);
    expect(packagesInOrder([{ id: "old", section_ids: [WARRANTY, GONE] }], library)).toEqual([{ id: "old", section_ids: [WARRANTY] }]);
    expect(packagesInOrder([{ id: "same", section_ids: [PAY.toUpperCase(), WARRANTY] }], library)).toEqual([]);
  });
});

describe("the example sections", () => {
  it("adds the trade's examples after the sections already there, numbered in order", () => {
    const rows = starterRows("roofing_exteriors", "co-1", 4);
    expect(rows.map((r) => r.title)).toEqual(contractStarters("roofing_exteriors").map((s) => s.title));
    expect(rows.map((r) => r.sort)).toEqual(rows.map((_, i) => 4 + i));
    expect(rows.every((r) => r.company_id === "co-1")).toBe(true);
    expect(rows.map((r) => r.title)).toContain("Hidden decking damage");
    expect(starterRows("paving", "co-1", 0).map((r) => r.title)).not.toContain("Hidden decking damage");
  });

  it("puts the right to cancel above the signatures, for the customer to initial", () => {
    const cancel = starterRows(null, "co-1", 0).find((r) => r.title === "Your right to cancel");
    expect(cancel).toMatchObject({ place: "signatures", initials: true });
    expect(STARTER_NOTE).toMatch(/attorney/);
  });

  it("marks the sections still worded as an example, until their words change", () => {
    const rows = starterRows("roofing_exteriors", "co-1", 0).map((r, i) => ({ ...r, id: `s${i}` }));
    rows[1] = { ...rows[1]!, title: "Renamed, same words" };
    rows[2] = { ...rows[2]!, body: `${rows[2]!.body}<p>Our own line.</p>` };
    const examples = exampleIds([...rows, { id: "own", body: "<p>Ours.</p>" }], "roofing_exteriors");
    expect(examples.has("s0")).toBe(true);
    expect(examples.has("s1")).toBe(true);
    expect(examples.has("s2")).toBe(false);
    expect(examples.has("own")).toBe(false);
    expect(examples.size).toBe(rows.length - 1);
  });
});

describe("a section in the list", () => {
  it("shows how its words start, as plain text", () => {
    expect(sectionSnippet("<h3>Payment</h3><p>Half <strong>up front</strong>,&nbsp;half when it&#39;s done.</p><ul><li>Checks</li><li>Cards</li></ul>")).toBe("Payment Half up front, half when it's done. Checks Cards");
    expect(sectionSnippet("<p>R&amp;R &lt;b&gt; and &amp;lt; stays</p>")).toBe("R&R <b> and &lt; stays");
    expect(sectionSnippet("")).toBe("");
  });

  it("cuts long words short", () => {
    const snippet = sectionSnippet(`<p>${"word ".repeat(100)}</p>`, 40);
    expect(snippet.length).toBeLessThanOrEqual(40);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("says where it prints", () => {
    expect(placeLabel("signatures")).toBe("Above the signatures");
    expect(placeLabel("terms")).toBe("On the terms pages");
  });
});

describe("the template editor's preview", () => {
  const sample: DocumentData = { ...SAMPLE_DOCUMENT, number: 1042, date: "2026-10-25", validUntil: "2026-11-24", total: 18500.5, deposit: null, client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] } };
  const template = templateSettings({ ...DEFAULT_TEMPLATE, terms: "Thanks, {Customer name}, from {Business name}.", sections: [WARRANTY, CANCEL, GONE], invoice_sections: [PAY, WARRANTY] });
  const company = { name: "R&R Roofing", phone: "555-0100", timezone: "America/Chicago" };

  it("prints the template's sections on the sample estimate, filled in like a real one", () => {
    const { data, template: printed } = contractPreview({ kind: "estimate", sample, template, library, company });
    expect(data.kind).toBe("estimate");
    expect(data.contract?.sections.map((s) => s.title)).toEqual(["Warranty", "Your right to cancel"]);
    const [warranty, cancel] = data.contract!.sections;
    // The sample offers no options, so {Warranty} and {Option} are blank, as on any estimate without them.
    expect(warranty!.html).toBe("<p></p><p></p>");
    expect(cancel).toMatchObject({ place: "signatures", initials: true, html: "<p>You can cancel within three business days, Alex Morgan.</p>" });
    // The terms print as text, so the business's name isn't escaped there.
    expect(printed.terms).toBe("Thanks, Alex Morgan, from R&R Roofing.");
    expect(printed.sections).toEqual(template.sections);
  });

  it("prints the invoice sections on the sample invoice, with no option or warranty", () => {
    const { data } = contractPreview({ kind: "invoice", sample, template, library, company });
    expect(data).toMatchObject({ kind: "invoice", validUntil: null, dueOn: "2026-11-24", balanceDue: 18500.5, payments: [] });
    expect(data.contract?.sections.map((s) => s.title)).toEqual(["Payment", "Warranty"]);
    expect(data.contract!.sections[0]!.html).toBe("<p>Pay R&amp;R Roofing $18,500.50 by October 25, 2026.</p>");
    expect(data.contract!.sections[1]!.html).toBe("<p></p><p></p>");
  });

  it("asks for no initials on the sample invoice, as no real invoice does, even for a section that asks on estimates", () => {
    const withCancel = templateSettings({ ...DEFAULT_TEMPLATE, terms: template.terms, sections: template.sections, invoice_sections: [PAY, CANCEL] });
    const invoice = contractPreview({ kind: "invoice", sample, template: withCancel, library, company }).data;
    expect(invoice.contract!.sections.find((s) => s.title === "Your right to cancel")).toMatchObject({ initials: false });
    expect(invoice.contract!.sections.every((s) => !s.initials)).toBe(true);
    const estimate = contractPreview({ kind: "estimate", sample, template: withCancel, library, company }).data;
    expect(estimate.contract!.sections.find((s) => s.title === "Your right to cancel")).toMatchObject({ initials: true });
  });

  it("counts the sections in the Contract summary, then shows the terms' first line", () => {
    expect(contractSummary("Payment: half up front.\nChanges: only with your OK.", 3, 1)).toBe("3 sections on estimates, 1 on invoices · Payment: half up front.");
    expect(contractSummary("Payment: half up front.", 1, 0)).toBe("1 section on estimates · Payment: half up front.");
    expect(contractSummary("", 0, 2)).toBe("2 sections on invoices");
    expect(contractSummary("Payment: half up front.", 0, 0)).toBe("Payment: half up front.");
    expect(contractSummary("  ", 0, 0)).toBe("Nothing printed above the signatures");
  });
});

describe("what a quote prints", () => {
  const template = templateSettings({ sections: [PAY] });

  it("lists the template's and the option's sections, and offers the rest for this job", () => {
    const { printing, others } = quoteSections({ library, template, optionSectionIds: [WARRANTY], quoteSectionIds: [CANCEL] });
    expect(printing.map((s) => [s.title, s.from])).toEqual([
      ["Payment", "template"],
      ["Warranty", "option"],
    ]);
    expect(others).toEqual([expect.objectContaining({ id: CANCEL, added: true })]);
  });

  it("counts a section the template and the option both name as the template's, once", () => {
    const { printing, others } = quoteSections({ library, template, optionSectionIds: [PAY.toUpperCase()], quoteSectionIds: [] });
    expect(printing.map((s) => [s.title, s.from])).toEqual([["Payment", "template"]]);
    expect(others.map((s) => [s.title, s.added])).toEqual([
      ["Your right to cancel", false],
      ["Warranty", false],
    ]);
  });

  it("reads the terms and sections a signed quote was signed with", () => {
    const initials = { image: "data:image/png;base64,AAAA", signed_at: "2026-10-25T15:00:00Z" };
    const contract = {
      terms: "  Thanks, Alex.  ",
      sections: [{ id: CANCEL, title: "Your right to cancel", body: "<p>…</p>", place: "signatures", initials: true, initialed: true }, { title: 42 }, null, { id: PAY, title: "Payment", place: "nowhere" }],
    };
    const kept = signedWith({ name: "Alex Morgan", contract, initials });
    expect(kept?.terms).toBe("Thanks, Alex.");
    expect(kept?.sections.map((s) => [s.title, s.place, s.initials, s.initialed])).toEqual([
      ["Your right to cancel", "signatures", true, true],
      ["Payment", "terms", false, false],
    ]);
    // Initialed only when the initials were kept too (an office "Mark approved" has none).
    expect(signedWith({ name: "Office", contract })?.sections[0]!.initialed).toBe(false);
  });

  it("reads the template's terms from an approval from before contracts, and nothing from one that kept neither", () => {
    expect(signedWith({ name: "Alex", template: { ...DEFAULT_TEMPLATE, terms: "Half up front." } })).toEqual({ terms: "Half up front.", sections: [] });
    expect(signedWith({ name: "Alex", contract: null })).toBeNull();
    expect(signedWith(null)).toBeNull();
    expect(signedWith({ name: "Alex", contract: { terms: "", sections: [] } })).toEqual({ terms: "", sections: [] });
  });
});

describe("the contract editor", () => {
  it("has headings, lists, quotes, dividers and tables, but no links, pictures, video, callouts or checklists", () => {
    const extensions = contractExtensions("Write it…");
    expect(extensions.map((e) => e.name)).toEqual(["starterKit", "orderedList", "heading", "tableKit", "placeholder"]);
    const [kit, , heading] = extensions as Array<{ options: Record<string, unknown> }>;
    expect(kit!.options).toMatchObject({ link: false, heading: false, code: false, codeBlock: false, orderedList: false });
    expect(heading!.options.levels).toEqual([3, 4]);
  });

  describe("numbered lists, which print numbered from 1", () => {
    const extensions = contractExtensions("Write it…");
    const schema = getSchema(extensions);
    const { doc, orderedList, listItem, paragraph } = schema.nodes as Record<string, NonNullable<(typeof schema.nodes)[string]>>;
    const p = (text: string) => paragraph.create(null, schema.text(text));
    const list = (...items: string[]) => orderedList.create(null, items.map((text) => listItem.create(null, p(text))));
    const printed = (node: PmNode) => orderedList.spec.toDOM!(node);

    /** The document after typing "`number`. " at the start of a paragraph under `before` (the editor's own input rule). */
    function typed(number: number, ...before: PmNode[]) {
      const text = `${number}. `;
      const start = doc.create(null, [...before, p(text)]);
      const ext = extensions.find((e) => e.name === "orderedList")!;
      const [rule] = getExtensionField<() => InputRule[]>(ext, "addInputRules", { name: ext.name, options: ext.options, storage: ext.storage, editor: undefined as never, type: orderedList })();
      const tr = EditorState.create({ doc: start }).tr;
      const from = start.content.size - (text.length + 2) + 1;
      rule!.handler({ state: { tr } as never, range: { from, to: from + text.length }, match: text.match(orderedListInputRegex) as never, commands: {} as never, chain: (() => null) as never, can: (() => null) as never });
      return tr.doc;
    }

    it("keeps no number to start from, or letters, from a paste: the list shows as it prints", () => {
      expect(Object.keys(orderedList.spec.attrs ?? {})).toEqual([]);
      // What a list pasted from Word that starts at 3, lettered, would bring.
      const pasted = orderedList.create({ start: 3, type: "a" }, listItem.create(null, p("Payment")));
      expect(Object.keys(pasted.attrs)).toEqual([]);
      expect(printed(pasted)).toEqual(["ol", {}, 0]);
    });

    it("starts a list typed as \"2. \" under a paragraph at 1, as the paper numbers it", () => {
      const after = typed(2, list("Payment"), p("Paid by check or card."));
      expect(after.childCount).toBe(3);
      expect(after.lastChild!.type.name).toBe("orderedList");
      expect(after.lastChild!.childCount).toBe(1);
      expect(printed(after.lastChild!)).toEqual(["ol", {}, 0]);
    });

    it("carries a list on when the next number is typed under it, and starts another for any other number", () => {
      const next = typed(2, list("Payment"));
      expect(next.childCount).toBe(1);
      expect(next.firstChild!.childCount).toBe(2);
      const again = typed(1, list("Payment"));
      expect(again.childCount).toBe(2);
      expect(again.lastChild!.childCount).toBe(1);
    });
  });

  it("reads pasted headings as its own: big ones as h3, small ones as h4", () => {
    const rules = getSchema(contractExtensions("Write it…")).nodes.heading!.spec.parseDOM!;
    expect(rules.map((r) => ["tag" in r ? r.tag : null, r.attrs?.level])).toEqual([
      ["h1", 3],
      ["h2", 3],
      ["h3", 3],
      ["h4", 4],
      ["h5", 4],
      ["h6", 4],
    ]);
  });
});

describe("where Settings lists contract terms and packages", () => {
  const session = (role: string, permissions: string[]) => ({ role, permissions, config: { singleCompany: false, platform: "docker" } }) as never;
  const items = (role: string, permissions: string[]) => settingsGroups(session(role, permissions)).flatMap((g) => g.items);
  const has = (list: ReturnType<typeof items>, match: (i: (typeof list)[number]) => boolean) => list.some(match);

  it("shows Contract terms to the people who manage Settings, beside the estimate template", () => {
    const office = items("office", ["sales", "settings"]);
    expect(has(office, (i) => "tab" in i && i.tab === "contracts")).toBe(true);
    const business = settingsGroups(session("owner", [])).find((g) => g.title === "Business")!.items.map((i) => i.label);
    expect(business.indexOf("Contract terms")).toBe(business.indexOf("Estimate template") + 1);
    expect(has(items("office", ["sales"]), (i) => "tab" in i && i.tab === "contracts")).toBe(false);
    expect(has(items("estimator", ["sales", "settings"]), (i) => "tab" in i && i.tab === "contracts")).toBe(false);
  });

  it("links to Packages for everyone who sells, in every trade", () => {
    const link = (list: ReturnType<typeof items>) => list.find((i) => "to" in i && i.to === "/packages");
    expect(link(items("estimator", ["sales"]))).toMatchObject({ label: "Packages", icon: "package" });
    expect(link(items("office", ["settings"]))).toBeUndefined();
    expect(link(items("field_crew", ["sales"]))).toBeUndefined();
  });
});
