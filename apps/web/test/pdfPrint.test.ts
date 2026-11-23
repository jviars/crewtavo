/**
 * Printing in Safari as the server's PDF (features/documents/pdfPrint.ts): where the document is
 * sent, the print ticket it goes with (the office's from the sign-in, the Client Hub's from its
 * link), and when the page prints itself the old way instead. The browser and the API are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrintableDocumentProps } from "@/features/documents/EstimateDocument";

const asked = vi.hoisted(() => ({ paths: [] as string[], fail: false }));
vi.mock("@/lib/api", () => ({
  api: {
    post: async (path: string) => {
      asked.paths.push(path);
      if (asked.fail) throw new Error("Your session has expired. Sign in again.");
      return { ticket: "office-ticket" };
    },
  },
}));

const { openPrintablePdf, printableOnPage, printTicketsFrom } = await import("@/features/documents/pdfPrint");

type Field = { type: string; name: string; value: string };
type Form = { action: string; target: string; method: string; fields: Record<string, string>; append(field: Field): void; submit(): void; remove(): void };
let sent: Form[] = [];
let opened: string[] = [];
let closed = 0;
let blocked = false;

beforeEach(() => {
  sent = [];
  opened = [];
  closed = 0;
  blocked = false;
  asked.paths = [];
  asked.fail = false;
  vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc." });
  vi.stubGlobal("window", { open: (_url: string, name: string) => (blocked ? null : (opened.push(name), { close: () => closed++ })) });
  vi.stubGlobal("document", {
    body: { append() {} },
    createElement: (tag: string) => {
      if (tag === "input") return { type: "", name: "", value: "" } as Field;
      const form = { fields: {}, append: (field: Field) => (form.fields[field.name] = field.value), submit: () => sent.push(form), remove() {} } as unknown as Form;
      return form;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const doc = { template: {}, company: { name: "Arrington Paving" }, data: { kind: "invoice", number: 1042 } } as unknown as PrintableDocumentProps;
/** Lets the ticket's answer come in. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("printing as a PDF in Safari", () => {
  it("opens the new tab at once, then sends the document on the page into it with the office's print ticket", async () => {
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(true);
    off();
    // The tab is open while the tap still counts; the form waits for the ticket.
    expect(opened).toHaveLength(1);
    expect(sent).toEqual([]);
    await settle();
    expect(asked.paths).toEqual(["/documents/print-ticket"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe(opened[0]);
    expect(sent[0]!.method).toBe("POST");
    // The ticket goes in the form, never in the address.
    expect(sent[0]!.action).toBe("/api/public/documents/Invoice%201042.pdf");
    expect(sent[0]!.fields.ticket).toBe("office-ticket");
    expect(JSON.parse(sent[0]!.fields.document!)).toMatchObject({ company: { name: "Arrington Paving" }, data: { number: 1042 } });
  });

  it("asks the Client Hub's link for the ticket while the Hub is up, and the sign-in again after", async () => {
    const hub = vi.fn(async () => "hub-ticket");
    const back = printTicketsFrom(hub);
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(true);
    await settle();
    expect(hub).toHaveBeenCalledOnce();
    expect(asked.paths).toEqual([]);
    expect(sent[0]!.fields.ticket).toBe("hub-ticket");
    back();
    expect(openPrintablePdf()).toBe(true);
    await settle();
    off();
    expect(asked.paths).toEqual(["/documents/print-ticket"]);
    expect(sent[1]!.fields.ticket).toBe("office-ticket");
  });

  it("closes the new tab and prints the page itself when no ticket comes", async () => {
    asked.fail = true;
    const otherwise = vi.fn();
    const off = printableOnPage(doc);
    expect(openPrintablePdf("new tab", otherwise)).toBe(true);
    await settle();
    off();
    expect(sent).toEqual([]);
    expect(closed).toBe(1);
    expect(otherwise).toHaveBeenCalledOnce();
  });

  it("leaves the page to print itself when Safari blocks the new tab (no tap), without asking for a ticket", async () => {
    blocked = true;
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(false);
    await settle();
    off();
    expect(sent).toEqual([]);
    expect(asked.paths).toEqual([]);
  });

  it("turns a tab opened to print (?print=1) into the PDF, without opening another", async () => {
    const back = printTicketsFrom(async () => "hub-ticket");
    const off = printableOnPage(doc);
    expect(openPrintablePdf("this tab")).toBe(true);
    await settle();
    off();
    back();
    expect(opened).toEqual([]);
    expect(sent[0]!.target).toBe("_self");
    expect(sent[0]!.fields.ticket).toBe("hub-ticket");
  });

  it("prints a tab opened to print the old way when its link gives no ticket", async () => {
    const back = printTicketsFrom(async () => {
      throw new Error("This link has been replaced.");
    });
    const otherwise = vi.fn();
    const off = printableOnPage(doc);
    expect(openPrintablePdf("this tab", otherwise)).toBe(true);
    await settle();
    off();
    back();
    expect(sent).toEqual([]);
    expect(closed).toBe(0);
    expect(otherwise).toHaveBeenCalledOnce();
  });

  it("isn't for another browser, or a page with no document on it", async () => {
    expect(openPrintablePdf()).toBe(false);
    vi.stubGlobal("navigator", { vendor: "Google Inc." });
    const off = printableOnPage(doc);
    expect(openPrintablePdf()).toBe(false);
    await settle();
    off();
    expect(sent).toEqual([]);
    expect(asked.paths).toEqual([]);
  });
});
