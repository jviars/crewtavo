/**
 * Signing an estimate that offers options, online (the Client Hub) and on the iPad: both sign for the
 * total the database will store for the option chosen, and fill in the contract with exactly the
 * words the server keeps with the signature (core contractInput, contractValues and fillIn, from the
 * same facts), so a homeowner signs the words they read.
 */
import { contractInput, contractValues, fillIn, resolveSections, sectionsHash } from "@crewtavo/core/contracts";
import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { chosenTotals } from "@crewtavo/core/money";
import { describe, expect, it } from "vitest";
import { initialSection, liveContract, stillInitialed } from "../src/features/documents/build";
import { quoteContract } from "../src/features/documents/data";
import { hubContract, hubTotals, type QuoteView } from "../src/features/hub/document";
import { linesWithOptions, signContractInput, signingTotals } from "../src/features/roofing/visit/data";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const K1 = "bbbbbbbb-0000-4000-8000-000000000001";
const K2 = "bbbbbbbb-0000-4000-8000-000000000002";
const K3 = "bbbbbbbb-0000-4000-8000-000000000003";

// As the database keeps them with A shown: B's lines are left unselected.
const lines = [
  { id: "s1", option_id: null, name: "Tear-off and disposal", description: null, quantity: 22, unit: "square", unit_price: 85, taxable: true, optional: false, selected: true },
  { id: "s2", option_id: null, name: "Gutter guards", description: null, quantity: 100, unit: "ft", unit_price: 7, taxable: true, optional: true, selected: false },
  { id: "a1", option_id: A, name: "Architectural shingle roof", description: null, quantity: 22, unit: "square", unit_price: 400, taxable: true, optional: false, selected: true },
  { id: "a2", option_id: A, name: "Ridge vent upgrade", description: null, quantity: 1, unit: "ea", unit_price: 250, taxable: true, optional: true, selected: true },
  { id: "b1", option_id: B, name: "Designer shingle roof", description: null, quantity: 22, unit: "square", unit_price: 520, taxable: true, optional: false, selected: false },
  { id: "b2", option_id: B, name: "Skylight flashing", description: null, quantity: 1, unit: "ea", unit_price: 300, taxable: false, optional: true, selected: false },
];

const library = [
  { id: K1, title: "Your right to cancel", body: "<p>{Customer name} may cancel by writing to {Business name} ({Business phone}).</p>", place: "signatures", initials: true },
  { id: K2, title: "Warranty", body: "<p>{Option}: {Warranty}. The price is {Total}, with {Deposit} down.</p>", place: "terms", initials: false },
  { id: K3, title: "This job", body: "<p>Estimate {Estimate number} of {Date} for {Job address}, billed to {Customer address}. {License number}. {Unknown} stays.</p>", place: "terms", initials: false },
];
const template = { ...DEFAULT_TEMPLATE, terms: "Checks to {Business name} & co.", license: "License #RC-104882", sections: [K1] };
// The quote as the server loads it to freeze the contract (routes/public.ts, services/signing.ts): a numeric comes as Postgres writes it.
const quote = { number: 1042, sent_at: "2026-10-22T03:30:00Z", created_at: "2026-10-20T15:00:00Z", total: 11466, deposit_amount: "500.00" };
const client = { display_name: "Dana & Lee Whitfield", billing_address: { line1: "PO Box 9", city: "Springfield", region: "IL", postal_code: "62704" } };
const property = { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" };
const company = { name: "R&R Roofing", phone: "555-0100", timezone: "America/Chicago" };
const designer = { name: "Designer shingle", tier: null, highlights: [] as string[], warranty: "50-year shingles <and> 10-year workmanship", section_ids: [K2] };

/** The facts that don't depend on the option, as GET /api/hub/:token sends them for this quote (the API's hub.test.ts checks what it sends). */
const hubFacts = {
  customerName: "Dana & Lee Whitfield",
  customerAddress: ["PO Box 9", "Springfield, IL 62704"],
  jobAddress: ["1482 Ridgeview Dr", "Springfield, IL 62704"],
  businessName: "R&R Roofing",
  businessPhone: "555-0100",
  license: "License #RC-104882",
  estimateNumber: 1042,
  date: "2026-10-22T03:30:00Z",
  timeZone: "America/Chicago",
  deposit: 500,
};

/** The estimate on the iPad (useEstimateQuote) and the visit's details (useVisitDetails), with B chosen. */
const estimate = { status: "sent", number: 1042, approval: null, client: { id: "c1", display_name: client.display_name, email: null, phone: null }, property: { id: "p1", ...property } };
const details = {
  sent_at: quote.sent_at, created_at: quote.created_at, deposit_amount: 500, sectionIds: [K3], billingAddress: client.billing_address,
  options: [{ id: B, ...designer, sort: 1 }], packageName: "Architectural shingle", packageWarranty: "25 years",
};

function view(): QuoteView {
  return {
    kind: "quote", home: null, company: { name: company.name, phone: company.phone, email: null, website: null, timezone: company.timezone }, template,
    contract: { kind: "live", terms: template.terms, library, template_sections: template.sections, quote_sections: [K3], facts: hubFacts },
    quote: {
      id: "q1", number: 1042, status: "sent", title: "New roof", message: null, subtotal: 10920, discount_amount: 0, promo: null, tax_rate: 0.05, tax_amount: 546, total: 11466,
      deposit_amount: 500, valid_until: null, sent_at: quote.sent_at, approved_at: null, client: { display_name: client.display_name }, property, option_id: A, section_ids: [K3],
      options: [
        { id: A, name: "Architectural shingle", tier: "Good", picture: null, style: "shingle", highlights: [], warranty: "25 years", section_ids: [], sort: 0, total: 11203.5, range: null },
        { id: B, name: designer.name, tier: "Better", picture: null, style: "designer", highlights: [], warranty: designer.warranty, section_ids: designer.section_ids, sort: 1, total: 13975.5, range: null },
      ],
      lines,
    },
  };
}

describe("the total signed for", () => {
  it("is what the database stores once the homeowner picks another option and its add-on", () => {
    // B shown, with its skylight flashing (untaxed): 1,870 + 11,440 + 300, tax on 13,310.
    const picked = hubTotals(view(), B, ["b2"]);
    expect(picked).toEqual({ subtotal: 13610, discount: 0, tax: 665.5, total: 14275.5 });
    expect(picked).toEqual(chosenTotals(lines, B, A, ["b2"], { taxRate: 0.05, discountAmount: 0, promo: null }));
    // Another option's add-on, or one left ticked from before, doesn't count.
    expect(hubTotals(view(), B, ["b2", "a2"]).total).toBe(14275.5);
    // The option shown, as saved: the stored total.
    expect(hubTotals(view(), A, ["a2"]).total).toBe(11466);
  });

  it("is a percent code's share of the option picked, as the database works it", () => {
    const v = view();
    v.quote.promo = { code: "SPRING", kind: "percent", value: 10, description: null };
    // 10% of 13,310, then tax on what's left of the taxed lines.
    expect(hubTotals(v, B, [])).toEqual({ subtotal: 13310, discount: 1331, tax: 598.95, total: 12577.95 });
  });

  it("is the paper's total on the iPad: the shown option's, as the database works it, or the quote's own", () => {
    const amounts = { subtotal: 10920, discount_amount: 0, tax_amount: 546, total: 11466, tax_rate: 0.05 };
    expect(signingTotals(amounts, lines, A, null)).toEqual({ subtotal: 10920, discount: 0, tax: 546, total: 11466 });
    expect(signingTotals({ ...amounts, total: 999 }, lines, null, null)).toEqual({ subtotal: 10920, discount: 0, tax: 546, total: 999 });
    // A promo code's discount, from its kind and value.
    expect(signingTotals(amounts, lines, A, { kind: "amount", value: 100 }).total).toBe(11361);
  });

  it("knows each line's option on the iPad, from the line itself or the visit's details", () => {
    const merged = linesWithOptions([{ id: "s1" }, { id: "b1" }, { id: "new" }, { id: "x", option_id: B }], { s1: null, b1: B, x: A });
    expect(merged.map((l) => l.option_id)).toEqual([null, B, null, B]);
  });
});

describe("the contract signed", () => {
  // What the server keeps (services/contracts.ts freezeContract): the facts for the option chosen and the total signed.
  const serverValues = (total: number) => contractValues(contractInput({ ...quote, total }, client, property, company, template, designer));

  it("is filled in online with the words the server keeps", () => {
    const total = hubTotals(view(), B, ["b2"]).total;
    const online = hubContract(view(), B, total)!;
    const values = serverValues(total);
    expect(online.sections.map((s) => s.html)).toEqual([K1, K2, K3].map((id) => fillIn(library.find((s) => s.id === id)!.body, values)));
    expect(online.terms).toBe(fillIn(template.terms, values, { text: true }));
    // Spelled out, as the homeowner reads them.
    expect(online.sections[0]!.html).toBe("<p>Dana &amp; Lee Whitfield may cancel by writing to R&amp;R Roofing (555-0100).</p>");
    expect(online.sections[1]!.html).toBe("<p>Designer shingle: 50-year shingles &lt;and&gt; 10-year workmanship. The price is $14,275.50, with $500.00 down.</p>");
    expect(online.sections[2]!.html).toBe(
      "<p>Estimate 1042 of October 21, 2026 for 1482 Ridgeview Dr, Springfield, IL 62704, billed to PO Box 9, Springfield, IL 62704. License #RC-104882. {Unknown} stays.</p>",
    );
    expect(online.terms).toBe("Checks to R&R Roofing & co.");
  });

  it("is fingerprinted as the server works it out for the option chosen: the words as they print, and the option's card", () => {
    const online = hubContract(view(), B, 14275.5)!;
    const resolved = resolveSections({ kind: "estimate", template, optionSectionIds: designer.section_ids, quoteSectionIds: [K3], library });
    // The card as the server keeps it (services/contracts.ts freezeOption), with the tier word the card shows.
    const card = { name: designer.name, tier: "Better", warranty: designer.warranty, highlights: [] };
    expect(online.hash).toBe(sectionsHash(resolved, { terms: template.terms, values: serverValues(14275.5), option: card }));
    // Another option brings other sections and another card, so another fingerprint; so does another total, which the warranty's words print.
    expect(hubContract(view(), A, 11466)!.hash).not.toBe(online.hash);
    expect(hubContract(view(), B, 1)!.hash).not.toBe(online.hash);
    // A total nothing prints changes nothing.
    const v = view();
    if (v.contract?.kind === "live") v.contract.library = library.map((s) => (s.id === K2 ? { ...s, body: "<p>{Option}: {Warranty}.</p>" } : s));
    expect(hubContract(v, B, 1)!.hash).toBe(hubContract(v, B, 14275.5)!.hash);
  });

  it("fills in {Option} and {Warranty} without options from the package it was priced from, as the server does", () => {
    const v = view();
    v.quote.options = [];
    if (v.contract?.kind === "live") v.contract = { ...v.contract, template_sections: [K1, K2], facts: { ...hubFacts, optionName: "Architectural shingle", warranty: "25 years" } };
    const online = hubContract(v, null, 11466)!;
    expect(online.sections.find((s) => s.id === K2)!.html).toBe("<p>Architectural shingle: 25 years. The price is $11,466.00, with $500.00 down.</p>");
    const facts = contractInput({ ...quote, total: 11466 }, client, property, company, template, { name: "Architectural shingle", warranty: "25 years" });
    const resolved = resolveSections({ kind: "estimate", template: { ...template, sections: [K1, K2] }, quoteSectionIds: [K3], library });
    expect(online.hash).toBe(sectionsHash(resolved, { terms: template.terms, values: contractValues(facts), option: null }));
  });

  it("is filled in on the iPad from the estimate and the visit's details, with the words the server keeps and the same words as online", () => {
    const total = 14275.5;
    // The tier word as the card shows it (core optionTierLabels: B is the dearer of the two).
    const input = signContractInput(estimate, details, template, designer, total, "Better")!;
    expect(contractValues(contractInput({ ...input.quote, total: input.total }, input.client, input.property, company, input.template, input.option))).toEqual(serverValues(total));
    // With options, {Option} and {Warranty} are the option's, never the package's.
    expect(input.fill).toBeNull();
    // So the paper's words are the ones online, and with the option's card as the customer sees it, their fingerprint too.
    const online = hubContract(view(), B, total)!;
    const iPad = quoteContract(input, company, library);
    expect(iPad).toEqual(online);
    // Its own tier word, when the option has one and nothing's worked out.
    expect(signContractInput(estimate, details, template, { ...designer, tier: "Premium" }, total)!.option).toMatchObject({ tier: "Premium", highlights: [] });
    expect(iPad).toEqual(
      liveContract({ template, library, optionSectionIds: designer.section_ids, quoteSectionIds: [K3], facts: contractInput({ ...quote, total }, client, property, company, template, designer), option: { name: designer.name, tier: "Better", warranty: designer.warranty, highlights: [] } }),
    );
    // Nothing to fill in before the details are in.
    expect(signContractInput(estimate, undefined, template, designer, total)).toBeNull();
  });

  it("is filled in on the iPad without options from the package it was priced from, with the fingerprint the server works out", () => {
    const single = { ...details, options: [] };
    const input = signContractInput(estimate, single, { ...template, sections: [K1, K2] }, null, 11466)!;
    expect(input.fill).toEqual({ name: "Architectural shingle", warranty: "25 years" });
    const iPad = quoteContract(input, company, library);
    expect(iPad.sections.find((s) => s.id === K2)!.html).toBe("<p>Architectural shingle: 25 years. The price is $11,466.00, with $500.00 down.</p>");
    // What services/signing.ts checks it against: the facts with the package (packageFill), and no option card.
    const facts = contractInput({ ...quote, total: 11466 }, client, property, company, template, { name: "Architectural shingle", warranty: "25 years" });
    const resolved = resolveSections({ kind: "estimate", template: { ...template, sections: [K1, K2] }, quoteSectionIds: [K3], library });
    expect(iPad.hash).toBe(sectionsHash(resolved, { terms: template.terms, values: contractValues(facts), option: null }));
    // A package without a warranty says none, as the server's does; no package, nothing.
    expect(signContractInput(estimate, { ...single, packageWarranty: null }, template, null, 11466)!.fill).toEqual({ name: "Architectural shingle", warranty: "" });
    expect(signContractInput(estimate, { ...single, packageName: null }, template, null, 11466)!.fill).toBeNull();
  });

  it("is filled in on the iPad for an estimate without a client or a sent date, as the server fills it in", () => {
    const input = signContractInput({ ...estimate, client: null }, { ...details, sent_at: null, deposit_amount: 0, billingAddress: null }, template, null, 999)!;
    const facts = contractInput({ ...input.quote, total: input.total }, input.client, input.property, company, input.template, input.option);
    expect(contractValues(facts)).toEqual(contractValues(contractInput({ ...quote, sent_at: null, deposit_amount: "0.00", total: 999 }, null, property, company, template, null)));
    expect(contractValues(facts)).toMatchObject({ "Customer name": "", "Customer address": "1482 Ridgeview Dr, Springfield, IL 62704", Date: "October 20, 2026", Deposit: "$0.00", Option: "" });
  });

  it("keeps initials on a section only while its words are the ones initialed", () => {
    const v = view();
    // The warranty section asks for initials too, and its words name the option and the total.
    if (v.contract?.kind === "live") v.contract.library = library.map((s) => (s.id === K2 ? { ...s, initials: true } : s));
    const signing = hubContract(v, B, 14275.5)!;
    const initialed = signing.sections.reduce((m, s) => initialSection(m, s, true), new Map<string, string>());
    expect([...stillInitialed(signing, initialed)]).toEqual([K1, K2]);
    // An add-on left off since: another total, so the warranty's words changed.
    expect([...stillInitialed(hubContract(v, B, 13975.5), initialed)]).toEqual([K1]);
    // Another option: its sections, its words.
    expect([...stillInitialed(hubContract(v, A, 11466), initialed)]).toEqual([K1]);
  });

  it("is the copy kept with the approval once it's signed, initialed where it was", () => {
    const v = view();
    v.quote.status = "approved";
    v.contract = {
      kind: "signed", terms: "Checks to R&R Roofing & co.",
      sections: [
        { id: K1, title: "Your right to cancel", body: "<p>Kept words</p>", place: "signatures", initials: true, initialed: true },
        { id: K2, title: "Warranty", body: "<p>Kept</p>", place: "terms", initials: false, initialed: false },
      ],
      initials: { image: "data:image/png;base64,AAAA", signed_at: "2026-10-25T18:00:00Z" },
    };
    const kept = hubContract(v, B, 0)!;
    expect(kept.hash).toBeNull();
    expect(kept.sections.map((s) => [s.html, s.initialed])).toEqual([["<p>Kept words</p>", { image: "data:image/png;base64,AAAA", date: "2026-10-25T18:00:00Z" }], ["<p>Kept</p>", null]]);
    expect(hubContract({ ...v, contract: null }, B, 0)).toBeNull();
  });
});
