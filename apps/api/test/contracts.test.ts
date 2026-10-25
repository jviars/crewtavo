/**
 * The contract on an estimate, on the server (services/contracts.ts): the library a quote prints
 * from, the facts its fill-ins come from, checking what was posted, and the copy kept with the
 * approval. The routes that use them are tested in hub.test.ts and signing.test.ts.
 */
import { contractValues, sectionsHash } from "@crewtavo/core/contracts";
import { templateSettings } from "@crewtavo/core/documents";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/supabase";
import {
  checkContract,
  contractFacts,
  contractHash,
  contractInput,
  freezeContract,
  freezeOption,
  initialsImage,
  invoiceContract,
  invoiceFill,
  invoiceInput,
  isPriced,
  loadLibrary,
  loadOptions,
  packageFill,
  postedId,
  readFrozen,
  resolveContract,
  type Contract,
  type OptionRow,
} from "../src/services/contracts";
import { drawnPng } from "./fixtures/drawn";

type Row = Record<string, unknown>;

const COMPANY = "00000000-0000-4000-8000-000000000c01";
const OTHER = "00000000-0000-4000-8000-000000000c02";
const A = "00000000-0000-4000-8000-000000000a01";
const B = "00000000-0000-4000-8000-000000000a02";
const C = "00000000-0000-4000-8000-000000000a03";
const D = "00000000-0000-4000-8000-000000000a04";
const PICTURE = `${COMPANY}/packages/00000000-0000-4000-8000-000000000f01.jpg`;
const PNG = drawnPng(240, 90, "initials");

/** A stand-in for Supabase that filters rows by eq and in, and remembers each query's filters. */
function fakeDb(tables: Record<string, Row[]>) {
  const queries: Array<{ table: string; filters: string[] }> = [];
  const db = {
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const query = { table, filters: [] as string[] };
      queries.push(query);
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: unknown) => (query.filters.push(`${column}=${value}`), filters.push((row) => row[column] === value), builder),
        in: (column: string, values: unknown[]) => (query.filters.push(`${column} in ${values.length}`), filters.push((row) => values.includes(row[column])), builder),
        maybeSingle: () => Promise.resolve({ data: (tables[table] ?? []).find((row) => filters.every((keep) => keep(row))) ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row))), error: null }).then(resolve),
      };
      return builder;
    },
  };
  return { db: db as unknown as Db, queries };
}

const section = (id: string, values: Row = {}) => ({ id, company_id: COMPANY, title: `Section ${id.slice(-2)}`, body: `<p>${id.slice(-2)}</p>`, place: "terms", initials: false, sort: 0, ...values });

const option = (values: Partial<OptionRow> = {}): OptionRow => ({
  id: B, name: "Standing-seam metal", tier: null, picture: PICTURE, picture_width: 1600, picture_height: 1200, style: "metal",
  highlights: ["Lasts 50 years"], warranty: "Lifetime on the panels & 15 years on our work.", section_ids: [], sort: 1, ...values,
});

const quote = { number: 1042, sent_at: "2026-10-22T03:30:00Z", created_at: "2026-10-20T15:00:00Z", total: 32693, deposit_amount: 1000 };
const company = { name: "R&R Roofing", phone: "555-0100", timezone: "America/Chicago" };
const property = { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" };

describe("the library a quote prints from", () => {
  it("loads only the business's own sections, and only real ids", async () => {
    const { db, queries } = fakeDb({ contract_sections: [section(A), section(B), section(C, { company_id: OTHER })] });
    const library = await loadLibrary(db, COMPANY, [A, B.toUpperCase(), C, "not-an-id", A]);
    expect(library.map((s) => s.id)).toEqual([A, B]);
    expect(queries).toEqual([{ table: "contract_sections", filters: [`company_id=${COMPANY}`, "id in 3"] }]);
  });

  it("doesn't ask the database when there's nothing to look up", async () => {
    const { db, queries } = fakeDb({});
    expect(await loadLibrary(db, COMPANY, ["", "nope"])).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("puts the template's sections first, then the option's, then the quote's, each once", async () => {
    const { db } = fakeDb({ contract_sections: [section(A), section(B, { place: "signatures", initials: true }), section(C), section(D, { company_id: OTHER })] });
    const template = templateSettings({ terms: "Thanks, {Customer name}.", sections: [C, D] });
    const contract = await resolveContract(db, COMPANY, { template, option: { section_ids: [B, C] }, quoteSectionIds: [A, B] });
    expect(contract.sections.map((s) => s.id)).toEqual([C, B, A]);
    expect(contract.sections[1]).toMatchObject({ place: "signatures", initials: true });
    expect(contract.terms).toBe("Thanks, {Customer name}.");
    expect(contract).toEqual({ terms: template.terms, sections: contract.sections });
  });

  it("counts an option as priced only once it has a line of its own that isn't an add-on", () => {
    const shared = { option_id: null, optional: false };
    expect(isPriced({ id: B }, [shared, { option_id: B, optional: false }])).toBe(true);
    expect(isPriced({ id: B }, [shared, { option_id: B, optional: true }, { option_id: A, optional: false }])).toBe(false);
  });

  it("reads posted ids as the database writes them", () => {
    expect(postedId.parse(B.toUpperCase())).toBe(B);
    expect(postedId.safeParse("not-an-id").success).toBe(false);
  });

  it("reads a quote's options in the order they're offered", async () => {
    const { db } = fakeDb({ quote_options: [{ ...option(), quote_id: "q1", company_id: COMPANY }, { ...option({ id: A, sort: 0 }), quote_id: "q1", company_id: COMPANY }, { ...option({ id: C }), quote_id: "q2", company_id: COMPANY }] });
    expect((await loadOptions(db, COMPANY, "q1")).map((o) => o.id)).toEqual([A, B]);
  });
});

describe("the facts a contract is filled in with", () => {
  it("come from the quote, the customer, the job, the business, the template and the option chosen", () => {
    const input = contractInput(quote, { display_name: "Dana Whitfield", billing_address: { line1: "PO Box 12", city: "Springfield", region: "IL", postal_code: "62705" } }, property, company, templateSettings({ license: "RC-104882" }), option());
    expect(input).toEqual({
      customerName: "Dana Whitfield",
      customerAddress: ["PO Box 12", "Springfield, IL 62705"],
      jobAddress: ["1482 Ridgeview Dr", "Springfield, IL 62704"],
      businessName: "R&R Roofing",
      businessPhone: "555-0100",
      license: "RC-104882",
      estimateNumber: 1042,
      date: "2026-10-22T03:30:00Z",
      timeZone: "America/Chicago",
      total: 32693,
      deposit: 1000,
      optionName: "Standing-seam metal",
      warranty: "Lifetime on the panels & 15 years on our work.",
    });
    // The Client Hub sends only what doesn't depend on the option.
    expect(contractFacts(input)).toEqual({
      customerName: "Dana Whitfield",
      customerAddress: ["PO Box 12", "Springfield, IL 62705"],
      jobAddress: ["1482 Ridgeview Dr", "Springfield, IL 62704"],
      businessName: "R&R Roofing",
      businessPhone: "555-0100",
      license: "RC-104882",
      estimateNumber: 1042,
      date: "2026-10-22T03:30:00Z",
      timeZone: "America/Chicago",
      deposit: 1000,
      optionName: "Standing-seam metal",
      warranty: "Lifetime on the panels & 15 years on our work.",
    });
  });

  it("say a single-package estimate's package for {Option} and {Warranty}, the business's own only", async () => {
    const pkg = { id: A, company_id: COMPANY, name: "Architectural shingle", warranty: "10 years on our workmanship." };
    const { db } = fakeDb({ roof_packages: [pkg, { ...pkg, id: B, company_id: OTHER }] });
    const fill = await packageFill(db, COMPANY, A);
    expect(fill).toEqual({ name: "Architectural shingle", warranty: "10 years on our workmanship." });
    expect(contractValues(contractInput(quote, null, property, company, templateSettings({}), fill))).toMatchObject({ Option: "Architectural shingle", Warranty: "10 years on our workmanship." });
    expect(await packageFill(db, COMPANY, B)).toBeNull();
    expect(await packageFill(db, COMPANY, null)).toBeNull();
  });

  it("use the job address for the customer without a billing address, and the day it was made before it's sent", () => {
    const input = contractInput({ ...quote, sent_at: null }, { display_name: "Dana Whitfield", billing_address: {} }, property, company, templateSettings({}), null);
    expect(input.customerAddress).toEqual(["1482 Ridgeview Dr", "Springfield, IL 62704"]);
    expect(input.date).toBe("2026-10-20T15:00:00Z");
    expect(input).toMatchObject({ optionName: null, warranty: null, license: "" });
  });
});

describe("an invoice's {Option} and {Warranty}", () => {
  it("say the option the client signed for, else the one the quote shows, else its package", async () => {
    const pkg = { id: A, company_id: COMPANY, name: "Architectural shingle", warranty: "10 years on our workmanship." };
    const { db } = fakeDb({ roof_packages: [pkg] });
    const kept = freezeContract({ contract: { terms: "", sections: [] }, facts: contractInput(quote, null, property, company, templateSettings({}), option()), option: option(), initials: null, signedAt: "" });
    expect(await invoiceFill(db, COMPANY, { approval: kept, option_id: B, roof_package_id: A, option: { name: "Renamed later", warranty: "Changed" } })).toEqual({ name: "Standing-seam metal", warranty: "Lifetime on the panels & 15 years on our work." });
    expect(await invoiceFill(db, COMPANY, { approval: { name: "Office" }, option_id: B, roof_package_id: A, option: { name: "Metal", warranty: null } })).toEqual({ name: "Metal", warranty: "" });
    expect(await invoiceFill(db, COMPANY, { approval: null, option_id: null, roof_package_id: A, option: null })).toEqual({ name: "Architectural shingle", warranty: "10 years on our workmanship." });
    expect(await invoiceFill(db, COMPANY, null)).toBeNull();
  });
});

describe("an invoice's contract", () => {
  it("fills in the template's terms and invoice sections with the invoice's number, date and total", async () => {
    const { db, queries } = fakeDb({
      contract_sections: [
        section(A, { title: "Payment", body: "<p>{Total} on invoice {Estimate number}, dated {Date}, for {Customer name} at {Job address}.{Deposit}{Option}</p>" }),
        section(B),
        section(C, { company_id: OTHER }),
      ],
    });
    const template = templateSettings({ license: "RC-104882", terms: "Thanks, {Customer name}.", sections: [B], invoice_sections: [C, A] });
    const facts = invoiceInput({ number: 77, issued_on: "2026-10-01", total: 18304 }, { display_name: "Dana <Whitfield>", billing_address: {} }, property, company, template);
    expect(facts).toMatchObject({ estimateNumber: 77, date: "2026-10-01", total: 18304, deposit: null, optionName: null, warranty: null, license: "RC-104882" });
    // For a job made from a quote, {Option} and {Warranty} say what the client chose (invoiceFill).
    const chose = invoiceInput({ number: 77, issued_on: "2026-10-01", total: 18304 }, null, property, company, template, { name: "Designer shingle", warranty: "50 years" });
    expect(chose).toMatchObject({ optionName: "Designer shingle", warranty: "50 years", deposit: null });
    expect(await invoiceContract(db, COMPANY, template, facts)).toEqual({
      terms: "Thanks, Dana <Whitfield>.",
      // Another business's section is left out, and an estimate's sections don't print on an invoice.
      sections: [{ id: A, title: "Payment", body: "<p>$18,304.00 on invoice 77, dated October 1, 2026, for Dana &lt;Whitfield&gt; at 1482 Ridgeview Dr, Springfield, IL 62704.</p>", place: "terms", initials: false }],
    });
    expect(queries).toEqual([{ table: "contract_sections", filters: [`company_id=${COMPANY}`, "id in 2"] }]);
  });
});

describe("checking what was posted", () => {
  const contract = (initials = false): Contract => ({
    terms: "Thanks, {Customer name}.",
    sections: [{ id: A, title: "Your right to cancel", body: "<p>{Customer name} has three days. {Warranty}</p>", place: "signatures" as const, initials }],
  });
  const facts = contractInput(quote, { display_name: "Dana Whitfield" }, property, company, templateSettings({}), option());
  const card = freezeOption(option(), "Best");
  const kept = { facts, option: card };
  /** What the page sends: the fingerprint of the paper it showed, filled in with the same facts and card. */
  const read = (c: Contract) => sectionsHash(c.sections, { terms: c.terms, values: contractValues(facts), option: { name: card.name, tier: card.tier, warranty: card.warranty, highlights: card.highlights } });

  it("passes the terms that were read, with initials where they're asked for", () => {
    expect(() => checkContract(contract(), {}, kept)).not.toThrow();
    expect(contractHash(contract(true), facts, card)).toBe(read(contract(true)));
    expect(() => checkContract(contract(true), { sections_hash: read(contract(true)), initials: PNG }, kept)).not.toThrow();
  });

  it("turns down terms that changed, and a missing set of initials", () => {
    expect(() => checkContract(contract(), { sections_hash: "0000000000000000" }, kept)).toThrow(expect.objectContaining({ status: 409, message: "The terms changed. Please look them over again." }));
    expect(() => checkContract(contract(true), {}, kept)).toThrow(expect.objectContaining({ status: 400, message: "Add your initials where the terms ask for them." }));
  });

  it("turns down a paper that said something else than the copy kept will: another warranty, customer or option", () => {
    const posted = { sections_hash: read(contract()) };
    expect(() => checkContract(contract(), posted, { facts: { ...facts, warranty: "None" }, option: card })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => checkContract(contract(), posted, { facts: { ...facts, customerName: "Someone Else" }, option: card })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => checkContract(contract(), posted, { facts, option: { ...card, tier: "Good" } })).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe("drawn initials", () => {
  it("are a PNG of a size a signature pad makes", () => {
    // A full-width pad on a big iPad in landscape, at twice the pixels.
    expect(initialsImage.safeParse(drawnPng(2752, 200)).success).toBe(true);
    expect(initialsImage.safeParse(PNG).success).toBe(true);
  });

  it("turn down a picture that claims to be huge, or isn't a PNG at all", () => {
    // A few bytes that would take the office's browser 1.6 GB to draw.
    expect(initialsImage.safeParse(drawnPng(20_000, 20_000)).success).toBe(false);
    expect(initialsImage.safeParse(drawnPng(9000, 10)).success).toBe(false);
    expect(initialsImage.safeParse(drawnPng(0, 90)).success).toBe(false);
    expect(initialsImage.safeParse("data:image/png;base64,SU5JVElBTFM=").success).toBe(false);
    expect(initialsImage.safeParse("data:image/png;base64,iVBORw0KGgo=").success).toBe(false);
    // Kept with an approval before the check, a huge one isn't sent on.
    expect(readFrozen({ initials: { image: drawnPng(20_000, 20_000), signed_at: null } }).initials).toBeNull();
  });
});

describe("the copy kept with the approval", () => {
  const contract: Contract = {
    terms: "Thanks, {Customer name}, from {Business name}.",
    sections: [
      { id: A, title: "Payment", body: "<p>{Total} to {Business name}. {Not a fill-in}</p>", place: "terms", initials: false },
      { id: B, title: "Your right to cancel", body: "<p>{customer NAME} may cancel.</p>", place: "signatures", initials: true },
    ],
  };
  const facts = contractInput(quote, { display_name: "Dana <Whitfield>" }, property, company, templateSettings({}), option());

  it("fills in the words, keeps the option as it was offered and stamps the initials where they're asked for", () => {
    const kept = freezeContract({ contract, facts, option: option(), tier: "Best", initials: PNG, signedAt: "2026-10-25T18:00:00.000Z" });
    expect(kept).toEqual({
      option: {
        id: B, name: "Standing-seam metal", tier: "Best", picture: { path: PICTURE, width: 1600, height: 1200 }, style: "metal",
        highlights: ["Lasts 50 years"], warranty: "Lifetime on the panels & 15 years on our work.",
      },
      contract: {
        // The terms are plain text, so the values go in as they are; a section is HTML, so they're escaped.
        terms: "Thanks, Dana <Whitfield>, from R&R Roofing.",
        sections: [
          { id: A, title: "Payment", body: "<p>$32,693.00 to R&amp;R Roofing. {Not a fill-in}</p>", place: "terms", initials: false, initialed: false },
          { id: B, title: "Your right to cancel", body: "<p>Dana &lt;Whitfield&gt; may cancel.</p>", place: "signatures", initials: true, initialed: true },
        ],
      },
      initials: { image: PNG, signed_at: "2026-10-25T18:00:00.000Z" },
    });
  });

  it("keeps no initials and no option when none are asked for or offered", () => {
    const plain = freezeContract({ contract: { ...contract, sections: [contract.sections[0]!] }, facts, option: null, initials: PNG, signedAt: "2026-10-25T18:00:00.000Z" });
    expect(plain.option).toBeNull();
    expect(plain.initials).toBeNull();
    // The option's own tier, and no picture when its path isn't a package picture's.
    expect(freezeContract({ contract, facts, option: option({ tier: "Premium", picture: "elsewhere/x.jpg" }), initials: PNG, signedAt: "" }).option).toMatchObject({ tier: "Premium", picture: null });
  });

  it("reads back only what a signed copy prints", () => {
    const kept = freezeContract({ contract, facts, option: option(), tier: "Best", initials: PNG, signedAt: "2026-10-25T18:00:00.000Z" });
    expect(readFrozen({ name: "Dana", ip: "198.51.100.4", ...kept })).toEqual(kept);
    expect(readFrozen({ name: "Dana" })).toEqual({ option: null, contract: null, initials: null });
    expect(readFrozen(null)).toEqual({ option: null, contract: null, initials: null });
    expect(
      readFrozen({
        option: { id: B, name: "Metal", picture: { path: "https://example.com/x.jpg", width: 10, height: 10 }, highlights: ["One", 2], extra: "dropped" },
        contract: { terms: 5, sections: [{ id: A, title: "Payment", body: "<p>Hi</p>", place: "elsewhere", secret: true }, "junk", { title: "No id" }] },
        initials: { image: "javascript:alert(1)", signed_at: "2026-10-25T18:00:00.000Z" },
      }),
    ).toEqual({
      option: { id: B, name: "Metal", tier: null, picture: null, style: "other", highlights: ["One"], warranty: "" },
      contract: { terms: "", sections: [{ id: A, title: "Payment", body: "<p>Hi</p>", place: "terms", initials: false, initialed: false }] },
      initials: null,
    });
  });
});
