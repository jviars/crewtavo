import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { describe, expect, it } from "vitest";
import { hubLetterhead, hubTemplate, invoiceDocument, maybePrice, quoteDocument, type InvoiceView, type QuoteView } from "../src/features/hub/document";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const company: QuoteView["company"] = {
  name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example", timezone: "America/Chicago",
  branding: { color: "#1f4e79" }, logo: "/api/public/logo/c/l.png", address: ["200 Main St", "Springfield, IL 62704"],
};

function quoteView(quote: Partial<QuoteView["quote"]> = {}): QuoteView {
  return {
    kind: "quote", home: null, company, template: { header: "banner", license: "RC-104882" },
    drawings: [{ id: "d1", title: "Roof", has_picture: true, sections: [], total_area_sqft: 2000, total_length_ft: 0, roofing_squares: 22.4, roof_pitch: "6/12", imagery: null }],
    quote: {
      id: "q1", number: 1042, status: "sent", title: "New roof", message: "Thanks for having us out.", subtotal: 1400, discount_amount: 0, promo: null, tax_rate: 0.05,
      tax_amount: 70, total: 1470, deposit_amount: 0, valid_until: "2026-11-21", sent_at: "2026-10-22T15:00:00Z", approved_at: null,
      client: { display_name: "Dana Whitfield" }, property: { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" },
      package: { name: "Architectural shingle" }, approval: null, range: null,
      lines: [
        { id: "l1", name: "Roof", description: null, quantity: 2, unit: "square", unit_price: 500, optional: false, selected: true },
        { id: "l2", name: "Pipe boot", description: "Around the vent pipes", quantity: 3, unit: "ea", unit_price: 45, optional: false, selected: true },
        { id: "l3", name: "Ridge vent", description: null, quantity: 1, unit: "ea", unit_price: 265, optional: false, selected: true },
        { id: "l4", name: "Gutter guards", description: null, quantity: 100, unit: "ft", unit_price: 7, optional: true, selected: false },
      ],
      ...quote,
    },
  };
}

describe("the Client Hub's documents", () => {
  it("prints a quote as saved: its lines, amounts, client and roof", () => {
    const doc = quoteDocument(quoteView());
    expect(doc).toMatchObject({
      kind: "estimate", number: 1042, date: "2026-10-22", validUntil: "2026-11-21", title: "New roof",
      facts: ["Architectural shingle", "22.4 squares", "6/12 pitch"],
      client: { name: "Dana Whitfield", lines: ["1482 Ridgeview Dr", "Springfield, IL 62704"] },
      subtotal: 1400, discount: 0, tax: 70, total: 1470, deposit: null, notes: "Thanks for having us out.",
      signatures: { customer: null, company: null },
    });
    expect(doc.lines.map((l) => [l.name, l.total])).toEqual([["Roof", 1000], ["Pipe boot", 135], ["Ridge vent", 265]]);
    expect(doc.lines[1]!.description).toBe("Around the vent pipes");
  });

  it("follows the options the client ticks, worked out to the cent", () => {
    const doc = quoteDocument(quoteView({ promo: { code: "SPRING", kind: "percent", value: 10, description: null } }), ["l4"]);
    expect(doc.lines.map((l) => l.name)).toContain("Gutter guards");
    expect(doc.subtotal).toBe(2100);
    expect(doc.discount).toBe(210);
    expect(doc.tax).toBe(94.5);
    expect(doc.total).toBe(1984.5);
    expect(doc.discountLabel).toBe("Promo code SPRING");
  });

  it("puts both signatures on a signed quote, and none on the client's line when the office approved it", () => {
    const signed = quoteDocument(quoteView({
      status: "approved", deposit_amount: 500,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person", company: { name: "Mike Torres", signature: PNG, signed_at: "2026-10-25T18:01:00Z" } },
    }));
    expect(signed.signatures).toEqual({
      customer: { name: "Dana Whitfield", image: PNG, date: "2026-10-25T18:00:00Z" },
      company: { name: "Mike Torres", image: PNG, date: "2026-10-25T18:01:00Z" },
    });
    expect(signed.deposit).toBe(500);
    const manual = quoteDocument(quoteView({ status: "approved", approved_at: "2026-10-25T18:00:00Z", approval: { name: "Sarah in the office", signature: null, signed_at: null, method: "manual", company: null } }));
    expect(manual.signatures).toEqual({ customer: null, company: null });
  });

  it("prints an invoice with what's been paid, refunded and held back", () => {
    const view: InvoiceView = {
      kind: "invoice", home: null, company, can_pay: true, tips: false,
      invoice: {
        id: "i1", number: 77, status: "partially_paid", subject: "Roof replacement", notes: null, issued_on: "2026-10-01", due_on: "2026-10-31",
        subtotal: 1000, discount_amount: 0, tax_amount: 0, total: 1000, retainage_amount: 100, amount_paid: 450, balance_due: 450, promo: null,
        client: { display_name: "Dana Whitfield" },
        lines: [{ name: "Roof", description: null, quantity: 1, unit: "ea", unit_price: 1000 }],
        payments: [{ amount: 500, tip_amount: 0, received_at: "2026-10-05T16:00:00Z" }, { amount: -50, tip_amount: 0, received_at: "2026-10-06T16:00:00Z" }],
      },
    };
    expect(invoiceDocument(view)).toMatchObject({
      kind: "invoice", number: 77, date: "2026-10-01", dueOn: "2026-10-31", title: "Roof replacement", total: 1000, balanceDue: 450,
      payments: [{ label: "Retainage (billed later)", amount: 100 }, { label: "Paid Oct 5, 2026", amount: 500 }, { label: "Refunded Oct 6, 2026", amount: -50 }],
    });
  });

  it("uses the business's letterhead and template, with the defaults for anything missing", () => {
    expect(hubLetterhead(company)).toEqual({
      name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example",
      address: ["200 Main St", "Springfield, IL 62704"], logo: "/api/public/logo/c/l.png", settings: { branding: { color: "#1f4e79" } },
    });
    expect(hubLetterhead({ ...company, address: undefined, logo: undefined }).address).toEqual([]);
    expect(hubTemplate({ template: { header: "banner" } })).toEqual({ ...DEFAULT_TEMPLATE, header: "banner" });
    expect(hubTemplate({})).toEqual(DEFAULT_TEMPLATE);
  });

  it("draws a signed quote on the template its link sends, the one it was signed on", () => {
    const view = quoteView({ status: "approved", approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person", company: null } });
    view.template = { ...DEFAULT_TEMPLATE, terms: "The terms Dana signed", company_signs: false };
    expect(hubTemplate(view)).toEqual({ ...DEFAULT_TEMPLATE, terms: "The terms Dana signed", company_signs: false });
  });
});

describe("the price range page", () => {
  it("says what could change the price in plain words", () => {
    expect(maybePrice({ price: 95, per: "sheet" })).toBe("$95 a sheet");
    expect(maybePrice({ price: 85, per: "square" })).toBe("$85 a square");
    expect(maybePrice({ price: 650, per: null })).toBe("$650");
    expect(maybePrice({ price: 3.5, per: "ft" })).toBe("$3.50 a foot");
    expect(maybePrice({ price: 120, per: "hr" })).toBe("$120 an hour");
    expect(maybePrice({ price: 40, per: "ea" })).toBe("$40");
  });
});
