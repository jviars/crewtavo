/**
 * Estimate documents (features/documents): the words and numbers printed on the page, a quote turned
 * into a document with its signatures, and the page itself on each template style.
 */
import { DEFAULT_TEMPLATE, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  addressLines,
  approvalSignatures,
  documentCompany,
  documentLines,
  initials,
  inkOn,
  licenseLine,
  logoUrl,
  longDate,
  pageFooterCss,
  quantityLabel,
  quoteDocument,
  quoteTemplate,
  readableOnWhite,
  readApproval,
  SAMPLE_DOCUMENT,
  SAMPLE_GENERAL_DOCUMENT,
  sampleDocument,
  signedTemplate,
  websiteLabel,
} from "../src/features/documents/build";
import { EstimateDocument, printedPages } from "../src/features/documents/EstimateDocument";
import type { DocumentCompany, DocumentData } from "../src/features/documents/types";

const INK = `data:image/png;base64,${"A".repeat(40)}=`;
const MIKE = `data:image/png;base64,${"B".repeat(40)}=`;

const company: DocumentCompany = {
  name: "Ridgeline Roofing Co.",
  phone: "(614) 555-0188",
  email: "office@ridgeline.example",
  website: "https://ridgeline.example/",
  address: ["2290 Harper Rd", "Columbus, OH 43204"],
  logo: null,
  settings: { branding: { color: "#3b7d23" } },
};

const page = (template: Partial<TemplateSettings>, data: DocumentData = SAMPLE_DOCUMENT, pages?: number) =>
  renderToStaticMarkup(createElement(EstimateDocument, { template: { ...DEFAULT_TEMPLATE, ...template }, company, data, pages }));

describe("words and numbers on the page", () => {
  it("writes quantities the way a roofer reads them", () => {
    expect(quantityLabel(24.2, "square")).toBe("24.2 sq");
    expect(quantityLabel(22, "square")).toBe("22 sq");
    expect(quantityLabel(210, "ft")).toBe("210 ft");
    expect(quantityLabel(1200, "sq ft")).toBe("1,200 sq ft");
    expect(quantityLabel(3, "ea")).toBe("3");
    expect(quantityLabel(1, "lump sum")).toBe("1");
    expect(quantityLabel("6", "sheet")).toBe("6 sheets");
    expect(quantityLabel(1, "sheet")).toBe("1 sheet");
    expect(quantityLabel(12, "panel")).toBe("12 panels");
    expect(quantityLabel(2, "box")).toBe("2 boxes");
    expect(quantityLabel(1.5, "hr")).toBe("1.5 hr");
    expect(quantityLabel(2, "hours")).toBe("2 hr");
    expect(quantityLabel(0.333, "visit")).toBe("0.33 visits");
  });

  it("prints the business's address, website, license and initials cleanly", () => {
    expect(addressLines({ line1: " 2290 Harper Rd ", city: "Columbus", region: "OH", postal_code: "43204" })).toEqual(["2290 Harper Rd", "Columbus, OH 43204"]);
    expect(addressLines({ line1: "PO Box 12", postal_code: "43204" })).toEqual(["PO Box 12", "43204"]);
    expect(addressLines(null)).toEqual([]);
    expect(websiteLabel("https://ridgeline.example/")).toBe("ridgeline.example");
    expect(licenseLine("#RC-104882")).toBe("License #RC-104882");
    expect(licenseLine("Lic. 55-1234")).toBe("Lic. 55-1234");
    expect(initials("Ridgeline Roofing Co.")).toBe("RR");
    expect(initials("The Gutter Guys, LLC")).toBe("GG");
    expect(initials("Bob")).toBe("B");
  });

  it("loads the logo from the public logo address", () => {
    const co = "00000000-0000-4000-8000-000000000001";
    expect(logoUrl({ branding: { logo: `${co}/logo/abc.png` } })).toBe(`/api/public/logo/${co}/abc.png`);
    expect(logoUrl({ branding: { color: "#000000" } })).toBeNull();
    expect(logoUrl(null)).toBeNull();
    expect(documentCompany({ name: "Ridgeline", phone: " ", email: "a@b.co", address: { line1: "1 Main" }, settings: { branding: { logo: `${co}/logo/abc.png` } } })).toMatchObject({
      phone: null,
      email: "a@b.co",
      website: null,
      address: ["1 Main"],
      logo: `/api/public/logo/${co}/abc.png`,
    });
  });

  it("keeps words readable on the template's color", () => {
    expect(inkOn("#1f4e79")).toBe("#ffffff");
    expect(inkOn("#f5c400")).toBe("#0f2a35");
    expect(readableOnWhite("#1f4e79")).toBe("#1f4e79");
    // A pale brand color still colors the rules, but the words go in ink.
    expect(readableOnWhite("#f5c400")).toBe("#0f2a35");
  });

  it("dates the page in words", () => {
    expect(longDate("2026-10-22")).toBe("October 22, 2026");
    expect(longDate(null)).toBe("");
  });
});

describe("a quote as a document", () => {
  const hub = { name: "Alex Morgan", signature: INK, signed_at: "2026-10-20T15:00:00.000Z", ip: "203.0.113.9", selected_line_ids: [], total: 100 };

  it("reads every kind of approval", () => {
    expect(readApproval(null)).toBeNull();
    expect(readApproval(hub)).toEqual({ name: "Alex Morgan", signature: INK, signed_at: hub.signed_at, method: null, company: null, template: null });
    expect(readApproval({ name: "Sarah Lopez", method: "manual" })).toMatchObject({ name: "Sarah Lopez", signature: null, method: "manual" });
    const inPerson = readApproval({ ...hub, method: "in_person", company: { name: "Mike Torres", user_id: "u1", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" } });
    expect(inPerson?.company).toEqual({ name: "Mike Torres", user_id: "u1", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" });
    // Anything that isn't a drawn signature is left off.
    expect(readApproval({ name: "X", signature: "javascript:alert(1)", company: { name: "Y", signature: "https://evil.example/x.png" } })).toMatchObject({ signature: null, company: null });
  });

  it("keeps the template a quote was signed on, whatever the business's templates say now", () => {
    const rows = [
      { id: "t1", is_default: true, settings: { terms: "Today's default terms" } },
      { id: "t2", is_default: false, settings: { header: "banner", terms: "Metal roof terms" } },
    ];
    const saved = { ...DEFAULT_TEMPLATE, terms: "The terms Alex signed", company_signs: false };
    const signed = { ...hub, template: saved };
    expect(readApproval(signed)?.template).toEqual(saved);
    // Read like any template: anything out of shape falls back to the defaults.
    expect(readApproval({ ...hub, template: { header: "wavy", terms: 7 } })?.template).toEqual(DEFAULT_TEMPLATE);
    expect(readApproval({ ...hub, template: "classic" })?.template).toBeNull();

    expect(quoteTemplate(rows, { status: "approved", template_id: "t2", approval: signed })).toEqual(saved);
    expect(quoteTemplate(rows, { status: "converted", template_id: null, approval: signed }).terms).toBe("The terms Alex signed");
    // Signed before approvals kept their template: the one it names, else the default.
    expect(quoteTemplate(rows, { status: "approved", template_id: "t2", approval: hub }).terms).toBe("Metal roof terms");
    expect(quoteTemplate(rows, { status: "approved", template_id: null, approval: hub }).terms).toBe("Today's default terms");
    // Not signed (or reopened as a draft): it follows its template.
    expect(quoteTemplate(rows, { status: "draft", template_id: null, approval: signed }).terms).toBe("Today's default terms");
    expect(signedTemplate({ status: "sent", template_id: "t2", approval: signed })).toBeNull();
    // Without the status, a saved template means it was signed.
    expect(signedTemplate({ template_id: null, approval: signed })).toEqual(saved);
    expect(signedTemplate({ template_id: null, approval: null })).toBeNull();
  });

  it("puts each signature on its line, and leaves an office approval's customer line blank", () => {
    expect(approvalSignatures(hub)).toEqual({ customer: { name: "Alex Morgan", image: INK, date: hub.signed_at }, company: null });
    expect(approvalSignatures({ name: "Sarah Lopez", method: "manual" }, "2026-10-21T12:00:00Z")).toEqual({ customer: null, company: null });
    const both = approvalSignatures({ ...hub, signed_at: null, method: "in_person", company: { name: "Mike Torres", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" } }, "2026-10-24T18:14:00.000Z");
    expect(both.customer?.date).toBe("2026-10-24T18:14:00.000Z");
    expect(both.company).toEqual({ name: "Mike Torres", image: MIKE, date: "2026-10-24T18:14:00.000Z" });
  });

  it("prints the lines that count, in order, with a price set on site as a normal line", () => {
    const lines = documentLines([
      { name: "Ridge vent", quantity: 48, unit: "ft", unit_price: 9, sort: 2 },
      { name: "Architectural shingle roof", description: " Installed ", quantity: 24.2, unit: "square", unit_price: 560, sort: 1 },
      { name: "Gutter guards", quantity: 120, unit: "ft", unit_price: 7, optional: true, selected: false, sort: 3 },
      { name: "Chimney cricket", quantity: 1, unit: "ea", unit_price: 450, optional: true, selected: true, sort: 4 },
      { name: SITE_ADJUSTMENT_NAME, quantity: 1, unit: "ea", unit_price: 220.5, sort: 5 },
    ]);
    expect(lines.map((l) => l.name)).toEqual(["Architectural shingle roof", "Ridge vent", "Chimney cricket", SITE_ADJUSTMENT_NAME]);
    expect(lines[0]).toEqual({ name: "Architectural shingle roof", description: "Installed", quantity: 24.2, unit: "square", unit_price: 560, total: 13552 });
    expect(lines[3]!.total).toBe(220.5);
  });

  it("builds the whole estimate from the quote", () => {
    const doc = quoteDocument(
      {
        number: 1042, title: "New roof", message: " Thanks for having us out. ", subtotal: "18304.00", discount_amount: "250", tax_amount: 0, total: "18054.00", deposit_amount: 0,
        valid_until: "2026-11-21", sent_at: "2026-10-22T14:00:00Z", created_at: "2026-10-20T14:00:00Z", approved_at: null, approval: null,
        promo: { code: "SPRING" }, client: { display_name: "Alex Morgan" }, property: { line1: "1482 Maple Ave", city: "Springfield", region: "IL", postal_code: "62704" },
      },
      [{ name: "Architectural shingle roof", quantity: 24.2, unit: "square", unit_price: 560 }],
      { facts: ["22.0 squares", "6/12 pitch"] },
    );
    expect(doc).toMatchObject({
      kind: "estimate", number: 1042, date: "2026-10-22T14:00:00Z", validUntil: "2026-11-21", title: "New roof", facts: ["22.0 squares", "6/12 pitch"],
      client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] },
      subtotal: 18304, discount: 250, discountLabel: "Promo code SPRING", tax: 0, total: 18054, deposit: null, notes: "Thanks for having us out.",
      signatures: { customer: null, company: null },
    });
    // What a screen knows better wins.
    const custom = quoteDocument({ number: 7, subtotal: 0, discount_amount: 0, tax_amount: 0, total: 0, title: "Roof" }, [], { client: { name: "Dana", lines: [] }, title: "Architectural shingle roof", date: "2026-10-24" });
    expect(custom).toMatchObject({ client: { name: "Dana", lines: [] }, title: "Architectural shingle roof", date: "2026-10-24", discountLabel: undefined });
  });

  it("has believable samples whose totals add up", () => {
    expect(SAMPLE_DOCUMENT.total).toBe(18304);
    expect(SAMPLE_DOCUMENT.subtotal).toBe(SAMPLE_DOCUMENT.lines.reduce((s, l) => s + l.total, 0));
    expect(SAMPLE_GENERAL_DOCUMENT.total).toBe(2330);
    expect(sampleDocument("roofing_exteriors")).toBe(SAMPLE_DOCUMENT);
    expect(sampleDocument("lawn_exterior")).toBe(SAMPLE_GENERAL_DOCUMENT);
  });
});

describe("the page", () => {
  it("has the letterhead, the lines and the totals", () => {
    const html = page({ tagline: "Roofing · Siding · Gutters", license: "#RC-104882", insurer: "Hartwell Mutual" });
    for (const text of ["Ridgeline Roofing Co.", "Roofing · Siding · Gutters", "2290 Harper Rd", "(614) 555-0188 · office@ridgeline.example", "ridgeline.example", "License #RC-104882", "Insured by Hartwell Mutual", "Prepared for", "Alex Morgan", "No. 1042", "Good until", "24.2 sq", "$560.00", "$13,552.00", "$18,304.00", "Page 1 of 1"]) {
      expect(html, text).toContain(text);
    }
    // The business's initials stand in for a missing logo; the brand color colors the page.
    expect(html).toContain(">RR<");
    expect(html).toContain("--doc-color:#3b7d23");
  });

  it("leaves off what the template turns off", () => {
    const html = page({ license: "#RC-104882", show_license: false, insurer: "Hartwell", show_insurer: false, page_numbers: false, terms: "", customer_signs: false, company_signs: false });
    expect(html).not.toContain("RC-104882");
    expect(html).not.toContain("Hartwell");
    expect(html).not.toContain("Page 1");
    expect(html).not.toContain("Customer");
    expect(html).not.toContain("representative");
  });

  it("draws the signature lines, with each signature on its line", () => {
    const blank = page({ customer_label: "Homeowner" });
    expect(blank).toContain("Homeowner");
    expect(blank).toContain("Ridgeline Roofing Co. representative");
    expect(blank).not.toContain("<img");

    const signed = page({ customer_label: "Homeowner", company_label: "Sales rep" }, { ...SAMPLE_DOCUMENT, signatures: { customer: { name: "Alex Morgan", image: INK, date: "2026-10-24T18:14:00Z" }, company: { name: "Mike Torres", image: MIKE, date: "2026-10-24T18:14:00Z" } } });
    expect(signed).toContain(`src="${INK}"`);
    expect(signed).toContain('alt="Signature of Alex Morgan"');
    expect(signed).toContain(`src="${MIKE}"`);
    expect(signed).toContain("Mike Torres");
    expect(signed).toContain("Sales rep");
    expect(signed).toContain("Oct 24, 2026");

    // A signature is never left off the copy, even if the template stopped asking for that line.
    expect(page({ company_signs: false }, { ...SAMPLE_DOCUMENT, signatures: { company: { name: "Mike Torres", image: MIKE, date: null } } })).toContain(`src="${MIKE}"`);
  });

  it("prints in each header style and lettering", () => {
    const logo = renderToStaticMarkup(createElement(EstimateDocument, { template: templateSettings({ header: "banner" }), company: { ...company, logo: "/api/public/logo/c/l.png" }, data: SAMPLE_DOCUMENT }));
    expect(logo).toContain('src="/api/public/logo/c/l.png"');
    expect(page({ header: "centered" })).toContain("2290 Harper Rd, Columbus, OH 43204 · (614) 555-0188");
    expect(page({ font: "classic" })).toContain("Palatino");
  });

  it("counts the printed pages at the end", () => {
    expect(page({}, SAMPLE_DOCUMENT, 2)).toContain("Page 2 of 2");
  });

  it("counts a printed page for any bit over a page", () => {
    expect(printedPages(0)).toBe(1);
    expect(printedPages(979)).toBe(1);
    // 10 px over: a second page (the footer lands there), not "Page 1 of 1".
    expect(printedPages(990)).toBe(2);
    expect(printedPages(1958)).toBe(2);
    expect(printedPages(1962)).toBe(3);
  });

  it("prints the footer and page numbers along the bottom of every page", () => {
    const css = pageFooterCss({ footer: "Thank you for your business", page_numbers: true }, "#3b7d23", "Georgia, serif");
    expect(css).toContain('@bottom-left { content: "Thank you for your business";');
    expect(css).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages);');
    expect(css).toContain("border-top: 2px solid #3b7d23;");
    expect(css).toContain("font-family: Georgia, serif;");
    expect(pageFooterCss({ footer: "  ", page_numbers: false }, "#3b7d23", "serif")).toBe("");
    // Only one of them: it spans the bottom, set in on both sides.
    const numbers = pageFooterCss({ footer: "", page_numbers: true }, "#3b7d23", "serif");
    expect(numbers).not.toContain("@bottom-left");
    expect(numbers).toContain("margin-right: 44px; margin-left: 44px;");
    // The business's words, or a bad color, can't break out of the rule or the page's style.
    const tricky = pageFooterCss({ footer: 'Say "hi" \\ </style><script>', page_numbers: false }, "red; } body { display: none", "serif");
    expect(tricky).toContain(String.raw`content: "Say \22 hi\22  \5c  \3c /style\3e \3c script\3e ";`);
    expect(tricky).not.toContain("</style>");
    expect(tricky).toContain("border-top: 2px solid #0f2a35;");
  });

  it("prints an invoice with what's been paid and what's left, and no signature lines", () => {
    const html = page({}, { ...SAMPLE_DOCUMENT, kind: "invoice", dueOn: "2026-11-21", payments: [{ label: "Paid Oct 30, 2026", amount: 5000 }, { label: "Refunded Nov 2, 2026", amount: -100 }], balanceDue: 13404, signatures: undefined });
    expect(html).toContain("Invoice");
    expect(html).toContain("Bill to");
    expect(html).toContain("Due November 21, 2026");
    expect(html).toContain("−$5,000.00");
    expect(html).toContain("+$100.00");
    expect(html).toContain("Balance due");
    expect(html).toContain("$13,404.00");
    expect(html).not.toContain("representative");
  });
});
