/**
 * Printing in Safari as the server's PDF (features/documents/pdfPrint.ts): where the document is
 * sent, and when the page prints itself the old way instead. The browser is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrintableDocumentProps } from "@/features/documents/EstimateDocument";
import { openPrintablePdf, printableOnPage } from "@/features/documents/pdfPrint";

type Form = { action: string; target: string; field: { value: string }; append(field: Form["field"]): void; submit(): void; remove(): void };
let sent: Form[] = [];
let opened: string[] = [];
let blocked = false;

beforeEach(() => {
  sent = [];
  opened = [];
  blocked = false;
  vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc." });
  vi.stubGlobal("window", { open: (_url: string, name: string) => (blocked ? null : (opened.push(name), {})) });
  vi.stubGlobal("document", {
    body: { append() {} },
    createElement: () => {
      const form = { field: { value: "" }, append: (field: Form["field"]) => (form.field = field), submit: () => sent.push(form), remove() {} } as Form;
      return form;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const doc = { template: {}, company: { name: "Arrington Paving" }, data: { kind: "invoice", number: 1042 } } as unknown as PrintableDocumentProps;

describe("printing as a PDF in Safari", () => {
  it("sends the document on the page into a new tab, at the PDF's name", () => {
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(true);
    off();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe(opened[0]);
    expect(sent[0]!.action).toBe("/api/public/documents/Invoice%201042.pdf");
    expect(JSON.parse(sent[0]!.field.value)).toMatchObject({ company: { name: "Arrington Paving" }, data: { number: 1042 } });
  });

  it("leaves the page to print itself when Safari blocks the new tab (no tap)", () => {
    blocked = true;
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(false);
    off();
    expect(sent).toEqual([]);
  });

  it("turns a tab opened to print (?print=1) into the PDF, without opening another", () => {
    const off = printableOnPage(doc);
    expect(openPrintablePdf("this tab")).toBe(true);
    off();
    expect(opened).toEqual([]);
    expect(sent[0]!.target).toBe("_self");
  });

  it("isn't for another browser, or a page with no document on it", () => {
    expect(openPrintablePdf()).toBe(false);
    vi.stubGlobal("navigator", { vendor: "Google Inc." });
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(false);
    off();
    expect(sent).toEqual([]);
  });
});
