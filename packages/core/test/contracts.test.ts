import { describe, expect, it } from "vitest";
import {
  CONTRACT_LIMITS,
  contractInput,
  contractStarters,
  contractValues,
  FILL_INS,
  fillIn,
  resolveSections,
  sectionsHash,
  type ContractSection,
  type LibrarySection,
} from "../src/contracts";
import { templateSettings } from "../src/documents";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const section = (n: number, extra: Partial<LibrarySection> = {}): LibrarySection => ({
  id: id(n), title: `Section ${n}`, body: `<p>Words ${n}</p>`, place: "terms", initials: false, ...extra,
});
const library = [section(1), section(2, { place: "signatures", initials: true }), section(3), section(4), section(5, { place: "anywhere", initials: null })];

describe("resolveSections", () => {
  it("prints the template's sections, then the option's, then the quote's, each once", () => {
    const template = templateSettings({ sections: [id(3), id(1)], invoice_sections: [id(4)] });
    const sections = resolveSections({ kind: "estimate", template, optionSectionIds: [id(2), id(1)], quoteSectionIds: [id(4), id(2)], library });
    expect(sections.map((s) => s.id)).toEqual([id(3), id(1), id(2), id(4)]);
    expect(sections[2]).toEqual({ id: id(2), title: "Section 2", body: "<p>Words 2</p>", place: "signatures", initials: true });
  });

  it("prints an option's and a quote's sections in the library's order, so a section moved in Settings moves there too", () => {
    const template = templateSettings({ sections: [id(4)] });
    // Kept in the order they were picked; the library is in its own order (sort, then created_at, then id).
    const moved = [section(3), section(1), section(2), section(4), section(5)];
    const sections = resolveSections({ kind: "estimate", template, optionSectionIds: [id(1), id(3)], quoteSectionIds: [id(5), id(2)], library: moved });
    expect(sections.map((s) => s.id)).toEqual([id(4), id(3), id(1), id(2), id(5)]);
    // The template keeps its own list's order (Settings keeps it in the library's).
    expect(resolveSections({ kind: "estimate", template: templateSettings({ sections: [id(1), id(3)] }), library: moved }).map((s) => s.id)).toEqual([id(1), id(3)]);
  });

  it("prints only the template's invoice sections on an invoice", () => {
    const template = templateSettings({ sections: [id(3)], invoice_sections: [id(4), id(1)] });
    expect(resolveSections({ kind: "invoice", template, optionSectionIds: [id(2)], quoteSectionIds: [id(5)], library }).map((s) => s.id)).toEqual([id(4), id(1)]);
  });

  it("leaves out sections that aren't in the library, and reads odd rows safely", () => {
    const template = templateSettings({ sections: [id(9), id(5)] });
    const sections = resolveSections({ kind: "estimate", template, optionSectionIds: null, quoteSectionIds: [id(8), id(5).toUpperCase()], library });
    expect(sections).toEqual([{ id: id(5), title: "Section 5", body: "<p>Words 5</p>", place: "terms", initials: false }]);
    expect(resolveSections({ kind: "estimate", template, library: [] })).toEqual([]);
  });
});

describe("fill-ins", () => {
  it("offers exactly the fill-ins a section can use", () => {
    expect(FILL_INS.map((f) => f.token)).toEqual([
      "{Customer name}", "{Customer address}", "{Job address}", "{Business name}", "{Business phone}", "{License number}",
      "{Estimate number}", "{Date}", "{Total}", "{Deposit}", "{Option}", "{Warranty}",
    ]);
    for (const f of FILL_INS) {
      expect(f.token).toBe(`{${f.label}}`);
      expect(f.hint.length).toBeGreaterThan(0);
    }
  });

  it("fills them in whatever the case, and escapes what goes in", () => {
    const values = { "Customer name": "Dana <Whitfield> & Sons", Total: "$18,304.00" };
    expect(fillIn("<p>{Customer name} agrees to pay {TOTAL} ({ total }).</p>", values)).toBe("<p>Dana &lt;Whitfield&gt; &amp; Sons agrees to pay $18,304.00 ($18,304.00).</p>");
    expect(fillIn("<p>{Customer&nbsp;name}</p>", values)).toBe("<p>Dana &lt;Whitfield&gt; &amp; Sons</p>");
  });

  it("leaves braces that aren't a fill-in alone, and empties a fill-in with no value", () => {
    expect(fillIn("<p>{Roof color} for {Option}: {Warranty}</p>", { Option: "Better" })).toBe("<p>{Roof color} for Better: </p>");
    expect(fillIn("{}{ }{{Date}}", { Date: "October 25, 2026" })).toBe("{}{ }{October 25, 2026}");
  });

  it("escapes plain text first, for the template's terms shown as HTML", () => {
    expect(fillIn("Pay {Business name} <b>on time</b> & smile.\nThanks!", { "Business name": "R&R Roofing" }, { plain: true })).toBe(
      "Pay R&amp;R Roofing &lt;b&gt;on time&lt;/b&gt; &amp; smile.\nThanks!",
    );
  });

  it("keeps plain text plain for a React text node, which escapes it itself", () => {
    const values = { "Business name": "R&R Roofing", "Customer name": "Dana O'Neil <3" };
    expect(fillIn("Pay {Business name} <b>on time</b>, {customer name}.\n{Roof color}", values, { text: true })).toBe(
      "Pay R&R Roofing <b>on time</b>, Dana O'Neil <3.\n{Roof color}",
    );
    expect(fillIn("{Business name}", values, { text: true, plain: true })).toBe("R&R Roofing");
  });
});

describe("contractValues", () => {
  const input = {
    customerName: "  Dana   Whitfield ",
    customerAddress: ["12 Oak St", "", "Radford, VA 24141"],
    jobAddress: "400 Hill Rd\nBlacksburg, VA 24060",
    businessName: "Ridgeline Roofing Co.",
    businessPhone: "(540) 555-0134",
    license: "RC-104882",
    estimateNumber: 1042,
    date: "2026-10-25",
    total: "18304.5",
    deposit: 1000,
    optionName: "Designer shingle",
    warranty: "50-year manufacturer warranty on the shingles, 15 years on our workmanship.",
  };

  it("says each fill-in in words", () => {
    expect(contractValues(input)).toEqual({
      "Customer name": "Dana Whitfield",
      "Customer address": "12 Oak St, Radford, VA 24141",
      "Job address": "400 Hill Rd, Blacksburg, VA 24060",
      "Business name": "Ridgeline Roofing Co.",
      "Business phone": "(540) 555-0134",
      "License number": "RC-104882",
      "Estimate number": "1042",
      Date: "October 25, 2026",
      Total: "$18,304.50",
      Deposit: "$1,000.00",
      Option: "Designer shingle",
      Warranty: "50-year manufacturer warranty on the shingles, 15 years on our workmanship.",
    });
  });

  it("reads a timestamp on the business's calendar, and the same everywhere without one", () => {
    // 1 AM UTC on the 26th is still the 25th in New York.
    expect(contractValues({ date: "2026-10-26T01:00:00Z", timeZone: "America/New_York" }).Date).toBe("October 25, 2026");
    expect(contractValues({ date: "2026-10-26T01:00:00Z" }).Date).toBe("October 26, 2026");
    expect(contractValues({ date: "2026-10-26T01:00:00Z", timeZone: "Mars/Olympus" }).Date).toBe("October 26, 2026");
    expect(contractValues({ date: "someday" }).Date).toBe("");
  });

  it("writes money to the cent and leaves out what isn't there", () => {
    expect(contractValues({ total: 1234567.891, deposit: 0 })).toMatchObject({ Total: "$1,234,567.89", Deposit: "$0.00" });
    // The deposit asked for is never more than the total being signed.
    expect(contractValues({ total: 4200, deposit: "5000.00" })).toMatchObject({ Total: "$4,200.00", Deposit: "$4,200.00" });
    expect(contractValues({ total: 14290.5, deposit: 1000 }).Deposit).toBe("$1,000.00");
    expect(contractValues({ deposit: 5000 }).Deposit).toBe("$5,000.00");
    expect(contractValues({ total: 0.5 }).Total).toBe("$0.50");
    expect(contractValues({ total: -45 }).Total).toBe("-$45.00");
    const empty = contractValues({});
    expect(Object.keys(empty)).toEqual(FILL_INS.map((f) => f.label));
    expect(Object.values(empty).every((v) => v === "")).toBe(true);
  });

  it("fills a section the same way from the same facts", () => {
    const body = "<p>{Customer name} picked {Option} for {Total}, estimate {Estimate number} of {Date}.</p>";
    expect(fillIn(body, contractValues(input))).toBe("<p>Dana Whitfield picked Designer shingle for $18,304.50, estimate 1042 of October 25, 2026.</p>");
  });
});

/** FNV-1a (64-bit) over UTF-8, the slow and obvious way. */
function fnv1a64(text: string): string {
  const bytes = [...encodeURIComponent(text).matchAll(/%([0-9A-F]{2})|[^%]/g)].map((m) => (m[1] ? parseInt(m[1], 16) : m[0].charCodeAt(0)));
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

describe("sectionsHash", () => {
  const sections: ContractSection[] = [
    { id: id(1), title: "Payment", body: "<p>{Total} when it's done.</p>", place: "terms", initials: false },
    { id: id(2), title: "Your right to cancel", body: "<p>Three business days — café ✓ 🏠</p>", place: "signatures", initials: true },
  ];
  const none = contractValues({});
  const values = contractValues({ total: 18304, deposit: 500, customerName: "Dana Whitfield", optionName: "Better", warranty: "50-year manufacturer, 10-year workmanship" });
  const better = { name: "Better", tier: "Better", warranty: "50-year manufacturer, 10-year workmanship", highlights: ["Architectural shingles", "Ice and water shield"] };
  const hash = (s: readonly ContractSection[], input: Partial<Parameters<typeof sectionsHash>[1]> = {}) => sectionsHash(s, { terms: null, values: none, option: null, ...input });
  const field = (v: string) => `${v.length}:${v}`;
  const sectionText = (s: ContractSection, body = s.body) => field(s.id) + field(s.title) + field(body) + field(s.place) + (s.initials ? "1" : "0");

  it("is a short fingerprint that stays the same for the same contract", () => {
    expect(hash(sections)).toMatch(/^[0-9a-f]{16}$/);
    expect(hash(sections, { values })).toBe(hash(sections.map((s) => ({ ...s })), { values: { ...values } }));
    expect(hash([])).toBe("cbf29ce484222325");
  });

  it("is FNV-1a over the terms, the option's card and each section, filled in as they print", () => {
    const terms = "Payment to {Business name}.";
    const filled = { ...values, "Business name": "R&R Roofing" };
    // The terms are plain text, so the values go in as they are; a section's words are HTML, so they go in escaped.
    const text = [
      `T${field("Payment to R&R Roofing.")}`,
      `O${field("Better")}${field("Better")}${field(better.warranty)}${field(better.highlights.map(field).join(""))}`,
      sectionText({ ...sections[0]!, body: "<p>{Total} for {Business name}.</p>" }, "<p>$18,304.00 for R&amp;R Roofing.</p>"),
      sectionText(sections[1]!),
    ].join("|");
    expect(hash([{ ...sections[0]!, body: "<p>{Total} for {Business name}.</p>" }, sections[1]!], { terms, values: filled, option: better })).toBe(fnv1a64(text));
    expect(hash(sections)).toBe(fnv1a64(sections.map((s) => sectionText(s, s.body.replace("{Total}", ""))).join("|")));
    expect(fnv1a64("foobar")).toBe("85944171f73967e8"); // the reference's own check
  });

  it("covers the template's terms too, as they print", () => {
    const terms = "Payment: half up front.\nWarranty: {Warranty}";
    const base = hash(sections, { terms, values });
    expect(base).not.toBe(hash(sections, { values }));
    expect(hash(sections, { terms: "Payment: all up front.\nWarranty: {Warranty}", values })).not.toBe(base);
    expect(hash(sections, { terms: `  ${terms}\n`, values })).toBe(base); // they print trimmed
    expect(hash(sections, { terms: " \n ", values })).toBe(hash(sections, { values })); // and not at all when blank
    expect(hash(sections, { terms: " {Deposit} ", values: none })).toBe(hash(sections)); // or blank once they're filled in
    expect(hash([], { terms, values })).toBe(fnv1a64(`T${field("Payment: half up front.\nWarranty: 50-year manufacturer, 10-year workmanship")}`));
  });

  it("changes with the order, a title, the words or the initials", () => {
    const base = hash(sections);
    const changed = [
      [sections[1]!, sections[0]!],
      [{ ...sections[0]!, title: "Payments" }, sections[1]!],
      [{ ...sections[0]!, body: "<p>{Total} when it's done!</p>" }, sections[1]!],
      [sections[0]!, { ...sections[1]!, initials: false }],
      [sections[0]!],
    ].map((s) => hash(s));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });

  it("changes when a fill-in it prints says something else, though the words as written are the same", () => {
    // The office edits the option's warranty and the deposit while the homeowner is on the Sign step.
    const signed: ContractSection[] = [
      { id: id(3), title: "Warranty", body: "<p>{Warranty}</p>", place: "terms", initials: false },
      { id: id(4), title: "Payment", body: "<p>Deposit {Deposit}, {Customer name}, on {Date}.</p>", place: "terms", initials: false },
    ];
    const facts = { customerName: "Dana Whitfield", deposit: 500, warranty: "50-year manufacturer, 10-year workmanship", date: "2026-10-25" };
    const base = hash(signed, { values: contractValues(facts) });
    const changed = [
      { ...facts, warranty: "Manufacturer only" },
      { ...facts, deposit: 5000 },
      { ...facts, customerName: "Dana Whitfield-Moore" },
      { ...facts, date: "2026-10-26" },
    ].map((f) => hash(signed, { values: contractValues(f) }));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    // The same words and values, however the amount comes (a numeric column, or a number), are the same contract.
    expect(hash(signed, { values: contractValues({ ...facts, deposit: "500.00" }) })).toBe(base);
  });

  it("doesn't change for a fact nothing prints", () => {
    const facts = { customerName: "Dana Whitfield", total: 18304, businessPhone: "(540) 555-0134", license: "RC-104882" };
    const base = hash(sections, { terms: "Thanks, {Customer name}!", values: contractValues(facts) });
    expect(hash(sections, { terms: "Thanks, {Customer name}!", values: contractValues({ ...facts, businessPhone: "(540) 555-0199", license: "RC-2" }) })).toBe(base);
    expect(hash(sections, { terms: "Thanks, {Customer name}!", values: contractValues({ ...facts, total: 18305 }) })).not.toBe(base); // Payment prints {Total}
  });

  it("covers the option chosen, as its card says it, whether or not a section prints it", () => {
    const base = hash(sections, { values, option: better });
    expect(base).not.toBe(hash(sections, { values }));
    const changed = [
      { ...better, name: "Better roof" },
      { ...better, tier: "Best" },
      { ...better, warranty: "Manufacturer only" },
      { ...better, highlights: ["Architectural shingles"] },
      { ...better, highlights: ["Ice and water shield", "Architectural shingles"] },
      { ...better, highlights: ["Architectural shingles, Ice and water shield"] },
    ].map((option) => hash(sections, { values, option }));
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    // Spacing, and a tier or highlights that are missing or blank, say nothing different on the card.
    expect(hash(sections, { values, option: { ...better, name: " Better ", highlights: [...better.highlights, "  "] } })).toBe(base);
    const plain = hash(sections, { values, option: { name: "Metal", tier: null, warranty: null, highlights: null } });
    expect(hash(sections, { values, option: { name: "Metal", tier: "  ", warranty: "", highlights: [] } })).toBe(plain);
  });

  it("is the same from the server's rows and the Client Hub's facts", () => {
    // The server's: the rows as they are (numeric columns as strings), through contractInput.
    const server = contractInput(
      { number: 1042, sent_at: "2026-10-26T01:00:00Z", created_at: "2026-10-20T15:00:00Z", total: 18304, deposit_amount: "500.00" },
      { display_name: "Dana Whitfield", billing_address: { line1: "12 Oak St", city: "Radford", region: "VA", postal_code: "24141" } },
      { line1: "400 Hill Rd", city: "Blacksburg", region: "VA", postal_code: "24060" },
      { name: "Ridgeline Roofing Co.", phone: "(540) 555-0134", timezone: "America/New_York" },
      { license: "RC-104882" },
      { name: "Better", warranty: better.warranty },
    );
    // The Hub's: the facts the server sent (services/contracts.ts contractFacts), with the option picked and the total they'd sign for.
    const hub = {
      customerName: "Dana Whitfield", customerAddress: ["12 Oak St", "Radford, VA 24141"], jobAddress: ["400 Hill Rd", "Blacksburg, VA 24060"],
      businessName: "Ridgeline Roofing Co.", businessPhone: "(540) 555-0134", license: "RC-104882", estimateNumber: 1042,
      date: "2026-10-26T01:00:00Z", timeZone: "America/New_York", deposit: 500, total: 18304, optionName: "Better", warranty: better.warranty,
    };
    const all = [{ id: id(5), title: "Everything", body: `<p>${FILL_INS.map((f) => f.token).join(" ")}</p>`, place: "terms" as const, initials: false }];
    const terms = FILL_INS.map((f) => f.token).join("\n");
    expect(hash(all, { terms, values: contractValues(hub), option: better })).toBe(hash(all, { terms, values: contractValues(server), option: better }));
  });
});

describe("contractStarters", () => {
  const known = new Set(FILL_INS.map((f) => f.token.toLowerCase()));
  const common = ["Payment", "Changes to the work", "Warranty", "Permits and inspections", "Cleanup", "Delays beyond our control", "Liens", "Your right to cancel"];

  it("gives every business the common sections", () => {
    expect(contractStarters("general").map((s) => s.title)).toEqual(common);
    expect(contractStarters(null).map((s) => s.title)).toEqual(common);
    expect(contractStarters("something_new").map((s) => s.title)).toEqual(common);
  });

  it("adds a few for the trade", () => {
    const titles = (trade: string) => contractStarters(trade).map((s) => s.title).filter((t) => !common.includes(t));
    expect(titles("roofing_exteriors")).toEqual(["Hidden decking damage", "Insurance claims", "Weather"]);
    expect(titles("paving")).toEqual(["Cure time", "Cracks coming back"]);
    expect(titles("lawn_exterior")).toEqual(["Access and pets", "Weather"]);
  });

  it("asks for initials on the right to cancel, above the signatures", () => {
    for (const trade of ["general", "roofing_exteriors", "paving", "lawn_exterior"]) {
      const starters = contractStarters(trade);
      expect(starters.filter((s) => s.initials || s.place === "signatures").map((s) => s.title)).toEqual(["Your right to cancel"]);
      expect(starters.find((s) => s.title === "Warranty")?.body).toContain("{Warranty}");
    }
  });

  it("fits the library, uses only real fill-ins and plain markup, and makes no legal promises", () => {
    for (const trade of ["general", "roofing_exteriors", "paving", "lawn_exterior"]) {
      for (const s of contractStarters(trade)) {
        expect(s.title.length, s.title).toBeLessThanOrEqual(CONTRACT_LIMITS.title);
        expect(s.body.length, s.title).toBeLessThanOrEqual(CONTRACT_LIMITS.body);
        for (const token of s.body.match(/\{[^{}]*\}/g) ?? []) expect(known.has(token.toLowerCase()), token).toBe(true);
        for (const tag of s.body.match(/<\/?([a-z0-9]+)[^>]*>/g) ?? []) expect(tag, s.title).toMatch(/^<\/?(p|ul|li|strong)>$/);
        expect(s.body, s.title).not.toMatch(/legal|enforceable|compl(y|ies|iant|iance)|binding/i);
      }
    }
  });
});
